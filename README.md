# Zillow Custom Filter (Claude)

A Chrome extension (Manifest V3) that filters Zillow listings against a custom
natural-language criterion Zillow can't express on its own (e.g. "has a den"),
using **Claude Opus 4.8 with vision**. The agent reads each listing's floorplan
images and description, decides whether it meets your criteria, then **reorders
matching listings to the top and hides the non-matches**.

Works with either the **Anthropic API** or **AWS Bedrock**.

## How it works

```
popup (popup.html/js)          content.js (on zillow.com)         background.js + bedrock.js
─────────────────────          ──────────────────────────         ──────────────────────────
prompt + credentials  ──msg──▶ read Zillow's active filters        holds NO state; per listing:
provider selector              scrape listing cards                 • Anthropic: POST /v1/messages
"Test connection"              fetch each detail page                  (image URLs OK)
                               mine ALL floorplan/photo images       • Bedrock: SigV4-signed
                               from the raw HTML                       InvokeModel (base64 images,
                               ──per-listing msg──────────────▶        inference profile)
                               reorder: matches top, hide rest ◀──   returns {keep, reason}
```

- **popup** collects your criteria + provider credentials, persists them to
  `chrome.storage.local`, and triggers a run. A **Test connection** button hits
  Opus 4.8 with a trivial request so you can confirm credentials/model access
  before filtering. If the content script isn't loaded in the tab (e.g. right
  after an extension reload), the popup auto-injects it via `chrome.scripting`.
- **content.js** reads Zillow's active filters from the page's embedded search
  state, finds listing cards by their listing links (`/homedetails/`, `/b/`,
  `/apartments/`, …), fetches each detail page, and extracts evidence (see
  *Floorplan extraction* below). It calls the background worker per listing
  (4 concurrent), then reorders the DOM: matches first, non-matches hidden.
- **background.js** is the only code that talks to Claude. It builds the request
  (adaptive thinking, `effort: low`, prompt-cached system prompt), inlines
  images for Bedrock, parses the verdict, and dispatches to the right provider.
- **bedrock.js** implements AWS SigV4 request signing with Web Crypto, entirely
  in the service worker.

## Floorplan extraction (the core trick)

The hard part of this project is getting Claude the *right* image. Zillow
apartment pages are JavaScript-rendered, and a den is often **only** visible as
a labeled room ("study den") inside a floorplan drawing — never in the listing
text. Two non-obvious facts drove the final approach:

1. **The floorplans are in the raw HTML.** Even though the live DOM is
   JS-rendered, the page source embeds every image URL
   (`photos.zillowstatic.com/fp/<hash>-<variant>.jpg`). `content.js` mines these
   with regex from the fetched HTML rather than relying on DOM selectors.
2. **You cannot tell a floorplan from a photo by its URL.** The same URL variant
   suffix (`-o_a`, `-p_i`, …) is used for both photos and floorplans. So instead
   of guessing, we **collect every distinct image** (deduped by content hash,
   best resolution per hash), rank them so likely floorplans come first (photos
   have many responsive size variants; floorplans have few), send **up to 12**,
   and let the **vision model decide which is the floorplan** and read its room
   labels. The prompt tells Claude the images are a mix and to look for the
   feature among the floorplan drawings.

As a text backstop, `content.js` also keyword-scans the source for
`den`/`study`/`office`/`flex room`/`bonus room` and surfaces any hit to the
model. When a listing genuinely has no floorplan, the model decides from the
description + photos.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. (After any code change, click the **reload ↻** icon on the extension card.)
4. Open a Zillow search page, click the extension icon.
5. Enter your criteria, pick a provider, paste credentials, optionally
   **Test connection**, then **Filter listings**.

> **Tip:** scroll the results so all cards render (Zillow lazy-loads) before
> running — reordering only affects already-rendered cards.

## Providers

### Anthropic
Paste an `sk-ant-...` key. Calls go from the service worker with the
`anthropic-dangerous-direct-browser-access: true` header. Images are passed by
URL. Structured output is enforced via `output_config.format`.

### AWS Bedrock
Paste AWS Access Key ID + Secret (+ optional session token) and region.
Requests are **SigV4-signed in the browser** (`bedrock.js`). Three Bedrock
specifics the code handles automatically — each one differs from the direct
Anthropic API:

| Concern | Anthropic API | Bedrock |
|---|---|---|
| **Model ID** | `claude-opus-4-8` | **Cross-region inference profile** `us.anthropic.claude-opus-4-8` (the bare `anthropic.claude-opus-4-8` returns 400 "on-demand isn't supported"). Geo prefix (`us`/`eu`/`apac`) derived from the region. |
| **Images** | URL sources OK | **Must be base64-inlined** (URL sources rejected). The worker fetches each image and encodes it. |
| **Structured output** | `output_config.format` supported | **Rejected** ("Extra inputs are not permitted"). The system prompt instructs JSON output and a tolerant parser extracts `{keep, reason}`. |

Body uses `anthropic_version: "bedrock-2023-05-31"`.

> ⚠️ **AWS keys live in the browser and are signed client-side.** Use a scoped,
> short-lived credential (e.g. STS session creds limited to `bedrock:InvokeModel`
> on the inference profile). **Never a root key.** For anything beyond a personal
> POC, move signing to a backend. Also requires Bedrock **model access enabled**
> for Claude Opus 4.8 in your region.

## Model & cost notes

- Model: `claude-opus-4-8` (Anthropic) / `us.anthropic.claude-opus-4-8`
  (Bedrock). 1M context, $5 / $25 per 1M input / output tokens.
- **One API call per listing.** Each call sends up to 12 full-resolution
  floorplan/photo images, and a floorplan image can cost up to ~4,800 input
  tokens — so a full results page is a real spend. Mitigations in place:
  `effort: "low"`, adaptive thinking, and a prompt-cached system prompt. If cost
  or latency is a concern, lower the image cap (`slice(0, 12)` in both
  `content.js` and `background.js`).
- **Fails closed.** Any API/parse error excludes the listing (rather than
  silently keeping it), so a glitch can't masquerade as a match. Use
  **Test connection** to distinguish credential problems from filtering results.

## Known fragile spots (POC — expect maintenance)

1. **Zillow DOM / HTML patterns** — card detection and the
   `photos.zillowstatic.com/fp/...` image mining in `content.js` depend on
   Zillow's current markup and will break when Zillow re-skins. This is the #1
   maintenance item.
2. **Detail-page fetch** — same-origin `fetch` with the user's Zillow cookies;
   rapid fetches may be rate-limited. Concurrency is capped at
   `MAX_CONCURRENCY = 4`.
3. **No floorplan published** — some listings (especially single-unit rentals)
   have no floorplan drawing; the den check then relies on text/photos and is
   weaker.
4. **Image cap** — only the first 12 ranked images are sent. A building with
   many unit types whose den-bearing floorplan ranks low could be missed; raise
   the cap (at higher token cost) if needed.
5. **Bedrock credentials in the browser** — inherently riskier than a backend
   proxy; fine for a personal POC only.
6. **Reordering only affects rendered cards** — Zillow lazy-loads/paginates;
   scroll to load all results first.

## Debugging

`content.js` logs per-listing diagnostics to the page console (open DevTools on
the Zillow tab):

- `[ZCF] <url> | images:N/M desc:LEN urls:[hash,hash,...]` — evidence gathered
  (N images sent of M distinct found; image hashes in the batch).
- `[ZCF verdict] <url> | keep: <bool> | images sent: N | reason: ... | raw: ...`
  — what the model received and decided.

These make it possible to tell "model judged wrong" from "model never got the
floorplan." Remove the `console.log` lines for a production build.

## Files

| File           | Role                                                          |
| -------------- | ------------------------------------------------------------- |
| `manifest.json`| MV3 manifest (module service worker, `scripting` permission, host perms incl. `zillowstatic.com`) |
| `popup.html/css/js` | Settings UI; persists config; Test connection; triggers a run; auto-injects content script |
| `content.js`   | Read filters, find cards, mine floorplan/photo images, reorder/hide |
| `content.css`  | `.zcf-hide` / `.zcf-keep` styles                              |
| `background.js`| Claude request builder, image inlining, verdict parsing, provider dispatch, connection test |
| `bedrock.js`   | AWS SigV4 signing + Bedrock InvokeModel via Web Crypto        |
