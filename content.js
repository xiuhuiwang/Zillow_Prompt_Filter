// ============================================================================
// CONFIG — you WILL need to adjust this section.
//
// Zillow's markup/JSON changes fairly often and isn't something I can verify
// live from here, so this is wired up as a small adapter layer: open the
// search page, DevTools > Elements, hover the listing cards, and fill these
// in to match what you actually see. Two extraction strategies are tried in
// order — JSON first (more robust), DOM scraping as a fallback.
// ============================================================================
const CONFIG = {
  // Confirmed from a real card: the attribute is data-testid (not data-test),
  // and the card element itself is an <article>.
  cardSelector: '[data-testid="property-card"]',

  fallbackSelectors: {
    price: '[data-testid="property-card-price"]',
    address: 'address',
    // NOT confirmed yet — this only shows up on single-unit cards (typical
    // for-sale homes). The "building" card type (apartment communities with
    // multiple unit types) doesn't have this line at all; see
    // extractListingData() below. If you're filtering for-sale listings,
    // inspect one of those cards and update this if it doesn't match.
    details: '[data-testid="property-card-details"]', // usually "3 bds | 2 ba | 1,500 sqft"
  },

  // Set to true to log every extracted listing as a table on each pass —
  // useful while you're still confirming selectors. Turn off once it's
  // working so it doesn't spam the console while you browse.
  debug: true,

  // If you find an embedded JSON blob (e.g. a <script id="__NEXT_DATA__">
  // or similar containing the search results), set its selector here and
  // adjust extractFromJson() below to match its actual shape. Leave null to
  // skip straight to DOM scraping.
  jsonScriptSelector: null, // e.g. 'script#__NEXT_DATA__'
};

// ============================================================================
// FILTER CRITERIA — replace this with whatever "extra" logic you need.
//
// `listing` is the normalized object from extractListingData() below. It has
// two shapes:
//   Single-unit card:  { isBuilding: false, price, beds, baths, sqft, address, el }
//   Building card:     { isBuilding: true, units: [{price, beds}, ...], address, el }
// (Building cards don't have sqft at the card level — Zillow doesn't surface
// per-unit sqft on the search results grid for apartment communities.)
// ============================================================================
function passesCustomFilter(listing, criteria) {
  if (listing.isBuilding) {
    // No units parsed at all (e.g. a "Contact for price" community) — keep
    // it visible rather than guessing.
    if (!listing.units || listing.units.length === 0) return true;
    // Keep the card if ANY of its unit types would individually pass.
    return listing.units.some((unit) => passesUnitFilter(listing, unit, criteria));
  }
  return passesUnitFilter(listing, listing, criteria);
}

function passesUnitFilter(listing, unit, criteria) {
  if (criteria.minSqftPerBed && listing.sqft && unit.beds) {
    if (listing.sqft / unit.beds < criteria.minSqftPerBed) return false;
  }
  if (criteria.maxPricePerSqft && unit.price && listing.sqft) {
    if (unit.price / listing.sqft > criteria.maxPricePerSqft) return false;
  }
  if (criteria.excludeKeywords && criteria.excludeKeywords.length) {
    const haystack = (listing.address || '').toLowerCase();
    if (criteria.excludeKeywords.some((kw) => haystack.includes(kw.toLowerCase()))) {
      return false;
    }
  }
  return true;
}

// ============================================================================
// Extraction
// ============================================================================
function parseNumber(str) {
  if (!str) return null;
  const cleaned = str.replace(/[^0-9.]/g, '');
  return cleaned ? parseFloat(cleaned) : null;
}

function extractFromJson() {
  if (!CONFIG.jsonScriptSelector) return null;
  const script = document.querySelector(CONFIG.jsonScriptSelector);
  if (!script) return null;
  try {
    const data = JSON.parse(script.textContent);
    // TODO: adjust this path once you've inspected the actual JSON shape.
    // Expected output: array of { zpid, price, beds, baths, sqft, address }
    console.warn('[ZEF] jsonScriptSelector found, but extractFromJson() needs the real path filled in.');
    return null;
  } catch (e) {
    console.warn('[ZEF] Failed to parse embedded JSON', e);
    return null;
  }
}

function extractFromDom(card) {
  const addressEl = card.querySelector(CONFIG.fallbackSelectors.address);
  const address = addressEl?.textContent?.trim() || null;

  // "Building" cards (apartment communities) list one price+bed pair per
  // unit type instead of a single price for the card. Detected via the
  // PropertyCardInventorySet block confirmed in a real card.
  const inventorySet = card.querySelector('[data-testid="PropertyCardInventorySet"]');
  if (inventorySet) {
    const boxes = inventorySet.querySelectorAll('[data-testid="PropertyCardInventoryBox"]');
    const units = Array.from(boxes)
      .map((box) => {
        const text = box.textContent || '';
        const priceMatch = text.match(/\$([\d,]+)/);
        const bedsMatch = text.match(/(\d+(?:\.\d+)?)\s*bd/i);
        return {
          price: priceMatch ? parseNumber(priceMatch[1]) : null,
          beds: bedsMatch ? parseFloat(bedsMatch[1]) : null,
        };
      })
      .filter((u) => u.price !== null || u.beds !== null);
    return { isBuilding: true, units, address, sqft: null, el: card };
  }

  // Single-unit card (typical for-sale home or standalone rental).
  const priceEl = card.querySelector(CONFIG.fallbackSelectors.price);
  const detailsEl = card.querySelector(CONFIG.fallbackSelectors.details);

  const priceText = priceEl?.textContent || '';
  const priceMatch = priceText.match(/\$([\d,]+)/);
  const price = priceMatch ? parseNumber(priceMatch[1]) : null;

  let beds = null, baths = null, sqft = null;
  if (detailsEl) {
    const text = detailsEl.textContent;
    const bedsMatch = text.match(/(\d+(?:\.\d+)?)\s*bd/i);
    const bathsMatch = text.match(/(\d+(?:\.\d+)?)\s*ba/i);
    const sqftMatch = text.match(/([\d,]+)\s*sqft/i);
    if (bedsMatch) beds = parseFloat(bedsMatch[1]);
    if (bathsMatch) baths = parseFloat(bathsMatch[1]);
    if (sqftMatch) sqft = parseNumber(sqftMatch[1]);
  } else {
    // Some single-unit cards (like rentals) embed bed count in the price
    // text itself, e.g. "$2,400+ 1 bd", same pattern as building cards.
    const bedsMatch = priceText.match(/(\d+(?:\.\d+)?)\s*bd/i);
    if (bedsMatch) beds = parseFloat(bedsMatch[1]);
  }

  return { isBuilding: false, price, beds, baths, sqft, address, el: card };
}

function getAllListings() {
  const fromJson = extractFromJson();
  if (fromJson) return fromJson;

  return Array.from(document.querySelectorAll(CONFIG.cardSelector)).map(extractFromDom);
}

// ============================================================================
// Apply filters to the live page
// ============================================================================
let activeCriteria = {};

async function loadCriteria() {
  const stored = await chrome.storage.sync.get('zefCriteria');
  activeCriteria = stored.zefCriteria || {};
}

function applyFilters() {
  const listings = getAllListings();
  let hiddenCount = 0;

  for (const listing of listings) {
    if (!listing.el) continue;
    const keep = passesCustomFilter(listing, activeCriteria);
    listing.el.classList.toggle('zef-hidden', !keep);
    if (!keep) hiddenCount++;
  }

  console.log(`[ZEF] Filtered ${listings.length} listings, hid ${hiddenCount}.`);
  if (CONFIG.debug) {
    console.table(
      listings.map((l) => ({
        address: l.address,
        isBuilding: l.isBuilding,
        price: l.isBuilding ? l.units?.map((u) => u.price).join('/') : l.price,
        beds: l.isBuilding ? l.units?.map((u) => u.beds).join('/') : l.beds,
        sqft: l.sqft,
        hidden: l.el.classList.contains('zef-hidden'),
      }))
    );
  }
}

// Debounce so rapid DOM mutations (scrolling, lazy-loading) don't trigger
// a filter pass on every single node insertion.
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
const debouncedApply = debounce(applyFilters, 250);

// ============================================================================
// Watch for new listings being added (scroll, pagination, Zillow's own
// filters changing) and re-run the custom filter automatically.
// ============================================================================
function startObserving() {
  const root = document.body;
  const observer = new MutationObserver((mutations) => {
    const hasRelevantChange = mutations.some((m) => m.addedNodes.length > 0);
    if (hasRelevantChange) debouncedApply();
  });
  observer.observe(root, { childList: true, subtree: true });
}

// ============================================================================
// React to the popup saving new criteria
// ============================================================================
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.zefCriteria) {
    activeCriteria = changes.zefCriteria.newValue || {};
    applyFilters();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'ZEF_REAPPLY') applyFilters();
});

// ============================================================================
// Debug API — accessible from the Zillow tab's DevTools console (see
// README for the "switch context" step needed since content scripts run
// in an isolated JS world).
// ============================================================================
window.ZEF = { getAllListings, applyFilters, CONFIG, get activeCriteria() { return activeCriteria; } };

// ============================================================================
// Boot
// ============================================================================
(async function init() {
  await loadCriteria();
  applyFilters();
  startObserving();
})();
