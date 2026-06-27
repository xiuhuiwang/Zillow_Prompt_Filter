// Content script: runs on zillow.com search pages.
// Responsibilities:
//   1. Read the active Zillow filters (from the embedded search state).
//   2. Scrape the visible listing cards.
//   3. For each card, fetch its detail page to get a floorplan URL or the
//      description text.
//   4. Ask the background worker (Claude) for a keep/drop verdict per listing.
//   5. Reorder matches to the top (visible); sink non-matches to the bottom and
//      hide them.
//
// Selectors here are best-effort against Zillow's current DOM and will need
// maintenance as Zillow changes. They are centralized in SELECTORS for that.
//
// Wrapped in an IIFE so the script can be re-injected (e.g. by the popup after
// an extension reload) without top-level `const` redeclaration errors. Each
// injection gets a fresh scope and registers a live message listener.
(() => {
const SELECTORS = {
  // The list container and the repeated card element.
  resultList:
    "#grid-search-results ul, ul.photo-cards, ul[class*='photo-cards'], ul[class*='List']",
  // A Zillow listing link. Rentals/apartments use /b/, /apartments/, /community/
  // building URLs; for-sale homes use /homedetails/. Cover all of them.
  cardLink:
    "a[data-test='property-card-link'], a[href*='/homedetails/'], a[href*='/b/'], a[href*='/apartments/'], a[href*='/community/']",
};

const MAX_CONCURRENCY = 4;
const CARD_FLAG = "data-zcf-processed";

// ---- Filter extraction -----------------------------------------------------

// Zillow stores the full search/query state as JSON in the page. Pulling it
// from the embedded script is far more stable than reading individual filter
// chips. We fall back to the URL's searchQueryState param.
function readZillowFilters() {
  // 1) URL param (present on most search result URLs).
  try {
    const url = new URL(location.href);
    const sqs = url.searchParams.get("searchQueryState");
    if (sqs) return JSON.parse(sqs);
  } catch (_) {}

  // 2) __NEXT_DATA__ hydration blob.
  try {
    const nextData = document.getElementById("__NEXT_DATA__");
    if (nextData) {
      const json = JSON.parse(nextData.textContent);
      const qs =
        json?.props?.pageProps?.searchPageState?.queryState ||
        json?.props?.searchPageState?.queryState;
      if (qs) return qs;
    }
  } catch (_) {}

  return null;
}

// ---- Card scraping ---------------------------------------------------------

// Find listing cards. Rather than depend on Zillow's churning class names, we
// anchor on the listing links (which are stable-ish) and walk up to the nearest
// <article> or <li> that represents one card.
function getCards() {
  const links = [...document.querySelectorAll(SELECTORS.cardLink)];
  const cards = new Set();

  for (const link of links) {
    // Walk up to the enclosing card element.
    const card = link.closest("article, li");
    if (!card) continue;
    // Skip nested matches: if an ancestor card is already collected, skip.
    let hasCardAncestor = false;
    for (const existing of cards) {
      if (existing !== card && existing.contains(card)) {
        hasCardAncestor = true;
        break;
      }
    }
    if (!hasCardAncestor) cards.add(card);
  }

  return [...cards];
}

// Diagnostic string for when no cards are found — tells us what the page has.
function diagnose() {
  const counts = {
    "li total": document.querySelectorAll("li").length,
    article: document.querySelectorAll("article").length,
    "homedetails links": document.querySelectorAll("a[href*='/homedetails/']").length,
    "/b/ links": document.querySelectorAll("a[href*='/b/']").length,
    "/apartments/ links": document.querySelectorAll("a[href*='/apartments/']").length,
    "property-card-link": document.querySelectorAll("a[data-test='property-card-link']").length,
  };
  return Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

function scrapeCard(card) {
  const link = card.querySelector(SELECTORS.cardLink);
  const detailUrl = link ? link.href : null;
  const text = card.innerText.replace(/\s+/g, " ").trim();
  return { detailUrl, summaryText: text };
}

// ---- Detail page fetch -----------------------------------------------------

// Fetch a listing detail page and extract a floorplan image URL and the
// description text. Same-origin fetch from the content script carries the
// user's Zillow session cookies.
async function fetchDetail(detailUrl) {
  const out = {
    floorplanUrl: null,
    floorplanUrls: [],
    isFloorplan: false,
    description: "",
    photoUrls: [],
    diag: "",
  };
  if (!detailUrl) {
    out.diag = "no detail url";
    return out;
  }

  try {
    const res = await fetch(detailUrl, { credentials: "include" });
    if (!res.ok) {
      out.diag = `fetch ${res.status}`;
      return out;
    }
    const html = await res.text();

    // Zillow apartment pages are JS-rendered — the live DOM's floorplan <img>
    // is NOT in this static HTML. But Zillow embeds floorplan + unit data as
    // JSON in the page source, so we mine the RAW HTML text with regex rather
    // than rely on DOM selectors against an empty shell.

    // 1) Floorplan image URL. Zillow floorplan images are on
    //    photos.zillowstatic.com; floorplan ones carry an "fp" path segment or
    //    a "floorplan"/"floor_plan" token. JSON-encoded URLs escape slashes
    //    (\/), so we un-escape after matching.
    // Zillow serves photos AND floorplan drawings under /fp/, and the URL
    // suffix does NOT reliably distinguish them (the real floorplan can be
    // -o_a.jpg, the same suffix used by photos). Rather than guess from the
    // URL, we collect every DISTINCT image (deduped by content hash, best
    // resolution per hash) and let the vision model decide which is the
    // floorplan. Each /fp/ asset has the shape:
    //   /fp/<hash>-<variant>.<ext>
    // where <variant> encodes size/crop (cc_ft_384, p_i, o_a, d_d,
    // uncropped_scaled_within_1536_1152, ...). We score variants by pixel
    // width and keep the largest per hash — room labels need ~1000px+ to read.
    const fpRe =
      /https?:\\?\/\\?\/photos\.zillowstatic\.com\/fp\/[^"'\s\\)]+\.(?:jpg|jpeg|png|webp)/gi;
    // hash -> { bestUrl, bestScore, variantCount }
    const byHash = new Map();

    const scoreVariant = (url) => {
      const wide = url.match(/within_(\d+)_\d+/); // uncropped_scaled_within_1536_1152
      if (wide) return parseInt(wide[1], 10);
      const ft = url.match(/cc_ft_(\d+)/); // cc_ft_1536
      if (ft) return parseInt(ft[1], 10);
      if (/-(?:o_a|d_d|p_d|p_i)\./i.test(url)) return 2000; // full-size originals
      return 500;
    };

    for (const m of html.matchAll(fpRe)) {
      const url = m[0].replace(/\\\//g, "/").replace(/\\u002f/gi, "/");
      if (/placeholder|default|no[_-]?image|blank|sprite|icon/i.test(url)) continue;
      const hashMatch = url.match(/\/fp\/([a-f0-9]+)-/i);
      if (!hashMatch) continue;
      const hash = hashMatch[1];
      const score = scoreVariant(url);
      const e = byHash.get(hash) || { bestUrl: url, bestScore: -1, variantCount: 0 };
      e.variantCount++;
      if (score > e.bestScore) {
        e.bestScore = score;
        e.bestUrl = url;
      }
      byHash.set(hash, e);
    }

    // Heuristic ranking (not classification): carousel PHOTOS are served in
    // many responsive sizes (high variantCount: cc_ft_384..1536, p_d, o_a, ...);
    // FLOORPLAN drawings tend to have FEW variants (often just -o_a / -p_i).
    // So images with the fewest size variants are the likeliest floorplans —
    // send those FIRST, then the rest. This puts the real floorplan early
    // without relying on a brittle URL-suffix rule, and lets us cap lower.
    const ranked = [...byHash.values()]
      .sort((a, b) => a.variantCount - b.variantCount)
      .map((v) => v.bestUrl);

    out.floorplanUrls = ranked.slice(0, 12);
    out.isFloorplan = ranked.length > 0; // images present; model classifies
    out.floorplanUrl = out.floorplanUrls[0] || null;

    // 2) Description / keyword text. Use the full raw HTML lowercased for the
    //    keyword fallback (the embedded JSON often contains unit/amenity text),
    //    plus a stripped text dump for readability. We keep a bounded slice so
    //    the request stays small.
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, style, noscript").forEach((n) => n.remove());
    const visibleText = (doc.body?.textContent || "").replace(/\s+/g, " ").trim();
    out.description = visibleText.slice(0, 6000);

    // Also surface any explicit den/study/office mention found anywhere in the
    // raw source, so the model gets a strong textual hint even when it's only
    // in the embedded JSON.
    const denHit = html
      .toLowerCase()
      .match(/\b(study den|den\/office|den|study|office|flex room|bonus room)\b/);
    if (denHit) out.description += `\n[Source mentions: "${denHit[1]}"]`;

    // All images go through floorplanUrls now; photoUrls is unused.
    out.photoUrls = [];

    out.diag =
      `images:${out.floorplanUrls.length}/${byHash.size} desc:${out.description.length}` +
      ` urls:[${out.floorplanUrls
        .map((u) => (u.match(/\/fp\/([a-f0-9]{6})/) || [, "?"])[1])
        .join(",")}]`;
  } catch (e) {
    out.diag = "error: " + e.message;
  }
  return out;
}

// ---- Concurrency helper ----------------------------------------------------

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

// ---- Background call -------------------------------------------------------

function evaluateListing(config, listing) {
  return chrome.runtime.sendMessage({
    type: "EVALUATE_LISTING",
    config,
    listing,
  });
}

// ---- DOM mutation ----------------------------------------------------------

function markCard(card, verdict) {
  card.setAttribute(CARD_FLAG, "1");
  if (verdict && verdict.keep) {
    card.classList.add("zcf-keep");
    card.classList.remove("zcf-hide");
  } else {
    card.classList.add("zcf-hide");
    card.classList.remove("zcf-keep");
  }
  // Stash the reason (or error) for hover/debug.
  if (verdict && verdict.error) card.title = "Filter error: " + verdict.error;
  else if (verdict && verdict.reason) card.title = verdict.reason;
}

// Reorder: matches first (in original order), non-matches after (hidden).
// Group by actual parent so mixed card nesting reorders within its own list.
function reorder(cards) {
  const byParent = new Map();
  for (const c of cards) {
    const parent = c.parentElement;
    if (!parent) continue;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(c);
  }
  for (const [parent, group] of byParent) {
    const keeps = group.filter((c) => c.classList.contains("zcf-keep"));
    const hides = group.filter((c) => !c.classList.contains("zcf-keep"));
    for (const c of [...keeps, ...hides]) parent.appendChild(c);
  }
}

function resetPage() {
  document.querySelectorAll(`[${CARD_FLAG}]`).forEach((card) => {
    card.classList.remove("zcf-keep", "zcf-hide");
    card.removeAttribute(CARD_FLAG);
    card.removeAttribute("title");
  });
}

// ---- Main run --------------------------------------------------------------

async function runFilter(config) {
  const filters = readZillowFilters();
  const cards = getCards();
  if (!cards.length) {
    return {
      ok: false,
      error:
        "No listing cards found. Scroll the results so they render, then retry. " +
        "(Page scan: " +
        diagnose() +
        ")",
    };
  }

  // Enrich config with the Zillow filters so Claude sees the full picture.
  const enrichedConfig = {
    ...config,
    prompt:
      `${config.prompt}\n\n(Zillow filters already applied: ` +
      `${filters ? JSON.stringify(filters.filterState || filters) : "unknown"})`,
  };

  let kept = 0;
  let hidden = 0;
  let errored = 0;
  let firstError = null;

  await mapWithConcurrency(cards, MAX_CONCURRENCY, async (card) => {
    const { detailUrl, summaryText } = scrapeCard(card);
    const detail = await fetchDetail(detailUrl);

    // Per-listing evidence diagnostic — open DevTools console on the Zillow tab
    // to see exactly what each listing sent to Claude. This is how we tell
    // "model judged wrong" from "model never got the floorplan".
    console.log("[ZCF]", detailUrl, "|", detail.diag);

    const listing = {
      data: {
        summary: summaryText,
        url: detailUrl,
        description: detail.description,
      },
      // All distinct listing images (photos + floorplans mixed); the model
      // identifies which are floorplans and inspects them for the feature.
      floorplanUrls: detail.floorplanUrls,
      photoUrls: [],
    };

    // A failed call is NOT a match. We surface the error rather than silently
    // keeping the card (which would make every listing look like a match).
    let verdict;
    try {
      const resp = await evaluateListing(enrichedConfig, listing);
      if (resp && resp.ok) {
        verdict = resp.verdict;
        // Show what the model actually received and replied, per listing.
        console.log(
          "[ZCF verdict]",
          detailUrl,
          "| keep:",
          verdict.keep,
          "| images sent:",
          verdict._images,
          "| reason:",
          verdict.reason,
          "| raw:",
          verdict._raw
        );
      } else {
        verdict = { keep: false, error: resp?.error || "evaluation error" };
      }
    } catch (e) {
      verdict = { keep: false, error: e.message };
    }

    if (verdict.error) {
      errored++;
      if (!firstError) firstError = verdict.error;
    }
    markCard(card, verdict);
    if (verdict.keep) kept++;
    else hidden++;
  });

  reorder(cards);
  return {
    ok: true,
    kept,
    hidden,
    errored,
    total: cards.length,
    firstError,
  };
}

// ---- Message router --------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "PING") {
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "RUN_FILTER") {
    runFilter(msg.config)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async
  }
  if (msg.type === "RESET_FILTER") {
    resetPage();
    sendResponse({ ok: true });
    return false;
  }
});
})();
