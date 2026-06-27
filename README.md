# Zillow Custom Filter (Claude)

A Chrome extension (Manifest V3) that filters Zillow listings against a custom
natural-language criterion Zillow can't express (e.g. "has a den"), using
Claude Opus 4.8 with vision. Matching listings move to the top; non-matches
sink to the bottom and are hidden.

## How it works

```
popup (popup.html/js)          content.js (on zillow.com)        background.js + bedrock.js
─────────────────────          ──────────────────────────        ──────────────────────────
prompt + credentials  ──msg──▶ read Zillow filters                holds NO state; per request:
key type selector              scrape ~20 listing cards            • Anthropic: POST /v1/messages
                               fetch each detail page              • Bedrock:  SigV4-signed
                               (floorplan URL / description)         InvokeModel
                               ──per-listing msg──────────────▶    returns {keep, reason}
                               reorder: matches top, hide rest ◀──
```

- **popup** collects the criteria + credentials, saves them to
  `chrome.storage.local`, and tells the content script to run.
- **content.js** reads the active Zillow filters from the page's embedded
  search state, scrapes the listing cards, fetches each listing's detail page
  for a floorplan image (or falls back to the description text / photos), asks
  the background worker for a verdict per listing (4 at a time), then reorders
  the DOM.
- **background.js** is the only code that talks to Claude. It builds the
  request (structured output `{keep, reason}`, adaptive thinking, low effort,
  prompt-cached system prompt) and dispatches to Anthropic or Bedrock.
- **bedrock.js** implements AWS SigV4 signing with Web Crypto for the Bedrock
  path.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open a Zillow search page, click the extension icon.
4. Enter your criteria, pick a provider, paste credentials, **Filter listings**.

## Providers

- **Anthropic** — paste an `sk-ant-...` key. Calls go from the service worker
  with the `anthropic-dangerous-direct-browser-access: true` header.
- **Bedrock** — paste AWS Access Key ID + Secret (+ optional session token) and
  region. Requests are SigV4-signed in the browser. **Use a scoped, short-lived
  credential** (e.g. STS session creds with only `bedrock:InvokeModel`); never a
  root key. Model ID: `anthropic.claude-opus-4-8`.

## Model & cost notes

- Model: `claude-opus-4-8` (Anthropic) / `anthropic.claude-opus-4-8` (Bedrock).
  1M context, $5/$25 per 1M input/output tokens.
- Each listing is one API call. A floorplan image can cost up to ~4,800 input
  tokens, so 20 listings is non-trivial — the system prompt is prompt-cached and
  effort is set to `low` to keep cost/latency down.

## Known fragile spots (POC — expect maintenance)

1. **Zillow DOM selectors** (`SELECTORS` in `content.js`) — card/list/link
   selectors and the detail-page floorplan/description heuristics will break
   when Zillow re-skins. This is the #1 maintenance item.
2. **Detail-page fetch** — relies on a same-origin `fetch` with the user's
   Zillow cookies. Zillow may rate-limit or bot-block rapid fetches. Concurrency
   is capped at 4; tune `MAX_CONCURRENCY` if you see blocks.
3. **Floorplans are often absent** — most listings have no floorplan. The agent
   falls back to the description text and a few photos; results are weaker then.
4. **Bedrock credentials in the browser** — client-side AWS keys are inherently
   riskier than a backend proxy. Fine for a personal POC; for anything shared,
   move signing to a server.
5. **Reordering only affects already-rendered cards** — Zillow lazy-loads /
   paginates. Scroll to load all 20 before running, or add a
   MutationObserver to handle new cards.

## Files

| File           | Role                                                      |
| -------------- | --------------------------------------------------------- |
| `manifest.json`| MV3 manifest (module service worker, host permissions)    |
| `popup.html/css/js` | Settings UI; persists config; triggers a run         |
| `content.js`   | Scrape Zillow, fetch details, reorder/hide cards          |
| `content.css`  | `.zcf-hide` / `.zcf-keep` styles                          |
| `background.js`| Claude request builder + provider dispatch                |
| `bedrock.js`   | AWS SigV4 signing + Bedrock InvokeModel                    |
