# Zillow Extra Filter — starter scaffold

## Load it
1. `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Navigate to a Zillow search results page, click the extension icon

## The one thing you need to do before it works
Zillow's DOM and class names change over time, so `content.js` ships with
**placeholder selectors** in the `CONFIG` object at the top of the file.
To wire it up to the real page:

1. Open a Zillow search results page.
2. Right-click a single listing card → **Inspect**.
3. Walk up the DOM tree until you find the element that repeats once per
   listing (this is your `CONFIG.cardSelector`).
4. Within that card, find the elements holding price / address / beds-baths-sqft
   text and update `CONFIG.fallbackSelectors`.
5. Optional but more robust: search the page source (Ctrl+F in DevTools'
   Elements/Sources panel) for a `<script>` tag containing a JSON blob with
   the full listing data (look for things like `"zpid"` or `"price"` inside
   a `<script>` tag). If you find one, set `CONFIG.jsonScriptSelector` and
   fill in the real path inside `extractFromJson()` — JSON extraction is far
   more reliable than scraping text out of divs.
6. Reload the extension (the circular arrow icon on its card in
   `chrome://extensions`) and refresh the Zillow tab.

Open the page's DevTools Console — `content.js` logs how many listings it
found and how many it hid on every pass, which makes it easy to tell whether
your selectors are matching anything.

## Card type matters
Zillow renders (at least) two different card shapes:

- **Single-unit** (typical for-sale home, or a standalone rental unit): one
  price, one address, one "X bds | Y ba | Z sqft" line.
- **"Building"** (an apartment community listing multiple unit types): one
  address, but a *price + bed count per unit type* instead of a single set
  of numbers — confirmed from a real card, it looks like `$2,400+ 1bd` /
  `$3,200+ 2bd` inside a block with `data-testid="PropertyCardInventorySet"`.
  There's no sqft at all on these cards.

`content.js` detects which shape a card is and extracts accordingly — for
building cards, your filter runs against *each unit type*, and the whole
card stays visible if any one unit type would pass. If you're filtering
for-sale single-family homes specifically, you'll mostly hit the
single-unit path; the building path matters if your search includes
rentals or apartment communities.

## How filtering logic works
`passesCustomFilter()` in `content.js` is where your "extra" rules live. The
scaffold ships with three example rules (min sqft/bedroom, max $/sqft,
address keyword exclusion) wired to the popup's inputs — add your own
conditions there using whatever fields you're able to extract per listing.

## Why hide instead of delete
Cards get a `zef-hidden` class (display: none) rather than being removed
from the DOM. This keeps Zillow's own JS happy (no broken event listeners
or React reconciliation errors) and makes it trivial to "un-hide" if you
loosen your filters.

## How to check it's actually working

The content script's `console.log`/`console.table` output and your `window.ZEF`
debug helper show up in the **Zillow page's own DevTools console** — not the
extension's background page (this extension has no service worker), and not
the popup's console. So: on the Zillow tab itself, right-click → **Inspect**
→ **Console** tab.

One gotcha specific to extensions: content scripts run in an "isolated
world," a separate JS scope from the page's own scripts. By default the
Console panel evaluates whatever you type against the **page's** scope (it
says "top" in a small dropdown near the top-left of the Console tab). To
reach the content script's globals — including the `window.ZEF` helper this
scaffold exposes — click that dropdown and switch it to this extension's
content script context (it'll be labeled with the extension name).

Once you're in the right context:

```js
ZEF.getAllListings()      // see exactly what got extracted from every card
ZEF.applyFilters()        // manually re-run filtering right now
ZEF.activeCriteria        // see what criteria are currently loaded
ZEF.CONFIG.debug = false  // turn off the console.table spam once things work
```

Practical test: pick one visible card, note something unique in its address,
then in the popup set "Exclude addresses containing" to that text and click
**Apply filters**. You should see exactly that card disappear, and the
console log's hidden count go up by 1. If nothing happens:

- **Console shows "Filtered 0 listings"** → `CONFIG.cardSelector` isn't
  matching anything on this page. Re-check it against the current markup.
- **Console shows listings but the count never changes after clicking
  Apply** → the popup's message likely isn't reaching the content script.
  Right-click the popup itself → Inspect → check its console for errors
  (the `.catch(() => {})` in `popup.js` is currently swallowing send
  failures — temporarily remove it to see the real error).
- **You edited `content.js` but nothing changed** → content scripts only
  inject when a page loads. Reload the extension in `chrome://extensions`
  (circular arrow on its card), then refresh the Zillow tab — editing the
  file alone doesn't hot-reload into already-open tabs.


## Note on Zillow's terms of use
This only manipulates a page you're already viewing locally in your own
browser — it doesn't crawl Zillow's servers or bypass any access controls.
That said, Zillow's terms generally restrict automated data extraction, so
treat this as a personal tool rather than something to redistribute or run
at scale.
