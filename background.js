// Background service worker: the only place that talks to Claude.
// Keeps credentials out of the Zillow page context and centralizes API access.
//
// Supports two providers:
//   - "anthropic": POST https://api.anthropic.com/v1/messages with x-api-key
//   - "bedrock":   POST https://bedrock-runtime.<region>.amazonaws.com/...
//                  signed with AWS SigV4 (computed here via Web Crypto)

import { invokeBedrock } from "./bedrock.js";

const ANTHROPIC_MODEL = "claude-opus-4-8";

// Bedrock requires a cross-region INFERENCE PROFILE id for Claude models, not
// the bare model id — on-demand invocation of "anthropic.claude-opus-4-8" is
// rejected with a 400. The profile id is the model id prefixed by a geo code
// derived from the region: us. / eu. / apac.
const BEDROCK_BASE_MODEL = "anthropic.claude-opus-4-8";

function bedrockProfileId(region) {
  const r = (region || "").toLowerCase();
  let geo = "us"; // sensible default
  if (r.startsWith("eu-")) geo = "eu";
  else if (r.startsWith("ap-")) geo = "apac";
  else if (r.startsWith("us-") || r.startsWith("ca-")) geo = "us";
  return `${geo}.${BEDROCK_BASE_MODEL}`;
}

// JSON schema for the per-listing verdict — guarantees a parseable shape.
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    keep: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["keep", "reason"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You evaluate a single real-estate listing against a user's custom criteria that Zillow's own filters can't express.

You are given:
- The user's custom criteria (natural language).
- Structured listing data (price, beds, baths, address, description text).
- Either a floorplan image, listing photos, or neither.

Decide whether this ONE listing satisfies ALL of the user's custom criteria.
- If a floorplan image is provided, inspect it for the requested feature (e.g. a den, office, extra room). Floorplans often label such rooms ("study den", "den/office", "flex", "bonus room").
- If only photos or a description are provided, infer from those — look for keywords and visual evidence.
- If there is not enough evidence to confirm a required feature, set keep=false.

Respond with ONLY a JSON object and nothing else — no prose, no markdown fences. The object must be exactly:
{"keep": <true|false>, "reason": "<one sentence>"}`;

// Fetch an image and return an Anthropic base64 image source. Bedrock requires
// inline base64 (it rejects url sources); the direct Anthropic API accepts URLs.
async function fetchImageAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch ${res.status}`);
  const mediaType = res.headers.get("content-type") || "image/jpeg";
  const buf = await res.arrayBuffer();
  // Base64-encode without blowing the call stack on large images.
  let binary = "";
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  const data = btoa(binary);
  return { type: "base64", media_type: mediaType.split(";")[0], data };
}

// Build an image block for the given URL. inlineImages=true → fetch + base64
// (Bedrock); false → pass the URL (Anthropic). Returns null if a Bedrock image
// fetch fails, so the listing still gets evaluated on text alone.
async function imageBlock(url, inlineImages) {
  if (!inlineImages) return { type: "image", source: { type: "url", url } };
  try {
    return { type: "image", source: await fetchImageAsBase64(url) };
  } catch {
    return null;
  }
}

// Build the user-turn content blocks for one listing.
async function buildContent(userPrompt, listing, inlineImages, dbg) {
  const blocks = [
    {
      type: "text",
      text:
        `User's custom criteria: ${userPrompt}\n\n` +
        `Listing data:\n${JSON.stringify(listing.data, null, 2)}`,
    },
  ];

  // A building can have MANY floorplans (studio, 1bd, 2bd "Type 15", ...). The
  // requested feature (e.g. a den) may exist in only ONE of them, so send all
  // candidates (capped) rather than just the first — which is often a
  // placeholder or the wrong unit type.
  const fpUrls =
    listing.floorplanUrls && listing.floorplanUrls.length
      ? listing.floorplanUrls
      : listing.floorplanUrl
      ? [listing.floorplanUrl]
      : [];

  if (fpUrls.length) {
    const imgs = [];
    for (const url of fpUrls.slice(0, 12)) {
      const img = await imageBlock(url, inlineImages);
      if (img) imgs.push(img);
    }
    if (dbg) dbg.images += imgs.length;
    if (imgs.length) {
      blocks.push({
        type: "text",
        text:
          `${imgs.length} image(s) for this property follow. They are a MIX of ` +
          `exterior/amenity photos AND floorplan drawings (a building may have several ` +
          `unit types, each with its own floorplan). First identify which images are ` +
          `floorplans (line drawings with labeled rooms), then read the room labels — ` +
          `the requested feature (e.g. a den, study, office, flex room) is often a small ` +
          `labeled room on the floorplan even if it's not mentioned anywhere in the text. ` +
          `If ANY floorplan shows the requested feature, keep the listing.`,
      });
      blocks.push(...imgs);
    } else {
      blocks.push({
        type: "text",
        text: "Floorplans exist but could not be loaded; decide from the description text above.",
      });
    }
  } else if (listing.photoUrls && listing.photoUrls.length) {
    const imgs = [];
    for (const url of listing.photoUrls.slice(0, 3)) {
      const img = await imageBlock(url, inlineImages);
      if (img) imgs.push(img);
    }
    if (dbg) dbg.images += imgs.length;
    if (imgs.length) {
      blocks.push({
        type: "text",
        text: "No floorplan available. Listing photos follow; infer from them and the description.",
      });
      blocks.push(...imgs);
    } else {
      blocks.push({
        type: "text",
        text: "No floorplan or photos could be loaded. Decide from the description text above only.",
      });
    }
  } else {
    blocks.push({
      type: "text",
      text: "No floorplan or photos available. Decide from the description text above only.",
    });
  }

  return blocks;
}

// Shared request body. `structuredFormat` enables output_config.format, which
// the direct Anthropic API supports but Bedrock's bedrock-2023-05-31 schema
// rejects ("Extra inputs are not permitted"). On Bedrock we rely on the system
// prompt's JSON instruction + tolerant parsing instead.
async function buildBody(userPrompt, listing, inlineImages, structuredFormat, dbg) {
  const output_config = { effort: "low" };
  if (structuredFormat) {
    output_config.format = { type: "json_schema", schema: VERDICT_SCHEMA };
  }
  return {
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    output_config,
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      { role: "user", content: await buildContent(userPrompt, listing, inlineImages, dbg) },
    ],
  };
}

// Tolerant verdict parser: handles raw JSON, JSON wrapped in ```fences```, or
// JSON embedded in prose. Fails CLOSED (keep:false) so a parse failure can't
// masquerade as a match.
function parseVerdict(message) {
  const textBlock = (message.content || []).find((b) => b.type === "text");
  const raw = textBlock?.text || "";
  // _raw carries the model's literal reply (truncated) so the page console can
  // show exactly what the model said vs. what we parsed.
  const dbgRaw = raw.slice(0, 200);
  if (!raw) return { keep: false, reason: "No content returned.", _raw: dbgRaw };

  const tryParse = (s) => {
    try {
      const obj = JSON.parse(s);
      if (typeof obj.keep === "boolean") return obj;
    } catch (_) {}
    return null;
  };

  // 1) Whole string is JSON.
  let v = tryParse(raw.trim());
  if (v) return { ...v, _raw: dbgRaw };

  // 2) JSON object embedded somewhere in the text.
  const match = raw.match(/\{[\s\S]*?"keep"[\s\S]*?\}/);
  if (match) {
    v = tryParse(match[0]);
    if (v) return { ...v, _raw: dbgRaw };
  }

  return { keep: false, reason: "Unparseable response; excluded." };
}

async function callAnthropic(apiKey, userPrompt, listing) {
  // Anthropic direct API accepts image URLs (no inline) and output_config.format.
  const dbg = { images: 0 };
  const body = {
    model: ANTHROPIC_MODEL,
    ...(await buildBody(userPrompt, listing, false, true, dbg)),
  };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Anthropic ${res.status}: ${txt.slice(0, 300)}`);
  }
  const message = await res.json();
  if (message.stop_reason === "refusal") {
    return { keep: false, reason: "Model refused to evaluate; excluded.", _images: dbg.images };
  }
  return { ...parseVerdict(message), _images: dbg.images };
}

async function callBedrock(aws, userPrompt, listing) {
  // Bedrock body uses anthropic_version instead of model, requires images
  // inlined as base64 (rejects url image sources), and rejects
  // output_config.format (so structuredFormat=false; we parse JSON from text).
  const dbg = { images: 0 };
  const body = {
    anthropic_version: "bedrock-2023-05-31",
    ...(await buildBody(userPrompt, listing, true, false, dbg)),
  };
  const message = await invokeBedrock(aws, bedrockProfileId(aws.region), body);
  if (message.stop_reason === "refusal") {
    return { keep: false, reason: "Model refused to evaluate; excluded.", _images: dbg.images };
  }
  return { ...parseVerdict(message), _images: dbg.images };
}

// ---- Connection test -------------------------------------------------------
// Minimal request to confirm credentials can reach Opus 4.8. No image, no
// structured output, no thinking — just pure connectivity + model access, so a
// failure points squarely at credentials/permissions/region, not our payload.

async function testAnthropic(apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with the single word: OK" }],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Anthropic ${res.status}: ${txt.slice(0, 400)}`);
  }
  const msg = await res.json();
  const text = (msg.content || []).find((b) => b.type === "text")?.text || "";
  return { model: msg.model || ANTHROPIC_MODEL, text };
}

async function testBedrock(aws) {
  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 16,
    messages: [{ role: "user", content: "Reply with the single word: OK" }],
  };
  const profileId = bedrockProfileId(aws.region);
  const msg = await invokeBedrock(aws, profileId, body);
  const text = (msg.content || []).find((b) => b.type === "text")?.text || "";
  return { model: msg.model || profileId, text };
}

async function testConnection(config) {
  if (config.keyType === "bedrock") return testBedrock(config.aws);
  return testAnthropic(config.anthropicKey);
}

async function evaluateListing(config, listing) {
  if (config.keyType === "bedrock") {
    return callBedrock(config.aws, config.prompt, listing);
  }
  return callAnthropic(config.anthropicKey, config.prompt, listing);
}

// Message router. The content script sends one EVALUATE_LISTING per listing so
// it can control concurrency and update the DOM incrementally.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "EVALUATE_LISTING") {
    evaluateListing(msg.config, msg.listing)
      .then((verdict) => sendResponse({ ok: true, verdict }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  }
  if (msg.type === "TEST_CONNECTION") {
    testConnection(msg.config)
      .then((info) => sendResponse({ ok: true, ...info }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  }
});
