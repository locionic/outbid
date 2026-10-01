# Local leaderboard app from the outbid.lol mirror

## Context

`/home/renovibe79/outbid` is a static mirror of **https://outbid.lol** — a public
leaderboard where you *pay to rank #1* in one of 28 categories (no ads, no API keys,
no revenue share). Launched 2026-08-19 by Jonathan Wilke (@jonathan_wilke).

There is no source code, no build, and no test suite here. But the mirrored HTML embeds
a React Server Components flight payload containing **1,273 complete listing records**
with 100% field coverage across all 15 fields, plus metadata for all 28 categories
(`slug`, `name`, `shortName`, `sortOrder`).

Goal: a clean, dependency-free local web app that browses that data. Scope is
**leaderboard + search/filter only** — no stats dashboard, no per-category boards, no
About/Rules reproduction. The mirror stays untouched; the app is additive.

## Two findings that drive the design

**1. The mirror's JS escaping is malformed.** Some flight-payload chunks contain a bare
`"` where `\"` belongs, e.g. `..."../../assets/hoa5x7k.png","description":"Shortcut K`
in `category/ecommerce-retail/index.html`. A strict JS-string parse terminates there and
recovers only **3 of 50** entries for that page. The extractor must not parse the JS
string literal. It unescapes each `<script>` body **independently**, then brace-matches
entry objects in the resulting text — that recovers all 50. This is a regression worth a
test.

**2. Rank is not stored.** `categoryRank` is `1` for 1,271 of 1,273 rows. Rank must be
derived by sorting `amountCents` desc, tie-broken by `createdAt` asc — which is exactly
the rule the site's own Rules page states ("Equal amounts stay in the order they were
placed — the older listing keeps the higher rank").

## Data profile (verified)

| | |
|---|---|
| Unique entries | 1,273 (one row per product; `identityKey` is 100% unique) |
| Categories | 28 in metadata, 27 populated (`audio-voice-podcasting` is empty and has no page) |
| Spend | $2 → $17,000, median $15, **$240,118 total** |
| Window | 2026-08-19 → 2026-09-01 (14 UTC days) |
| Clicks | 339,255 total |
| `identityType` | 1,245 `website`, 28 `x` |
| Images | 1,053 local (**100% resolve on disk**), 185 empty, 33 remote, 2 data URIs |
| Payload | ~649 KB as JSON |

**Honest limitation:** the live site caps each category board at 50 rows, so this is the
top-50-per-category snapshot (1,273), not all ~2,560 listed products. And because each
product has one running total rather than a payment history, the "Today" and "Daily"
boards are **not** derivable — only all-time is. The app shows all-time and says so.

## Fields

Keep 11 of 15: `id`, `categorySlug`, `identityType`, `identityKey`, `sourceUrl`,
`displayName`, `imageUrl`, `description`, `amountCents`, `createdAt`, `clickCount`.

Drop 4:
- `polarOrderId`, `polarCheckoutId` — the original operator's payment records. Not
  needed to display a leaderboard; excluding them keeps third-party order identifiers
  out of a derived dataset.
- `takeoverStartedAt` — null on 1,272 of 1,273 rows.
- `categoryRank` — derived, and wrong anyway.

Normalizations applied at extract time: strip the `$D` RSC date marker from `createdAt`;
rebase `imageUrl` from `../../assets/…` to `assets/…` so the app resolves it as
`../assets/…`.

## Files

```
app/
  index.html          app shell
  app.css             clean neutral design, light/dark via prefers-color-scheme
  app.js              render, search, category filter, sort, rank derivation
  data/entries.json      GENERATED — 1,273 records
  data/categories.json   GENERATED — 28 categories
tools/
  extract.py          parser (stdlib only)
  test_extract.py     one stdlib unittest, guards the escaping bug
```

`app/` is a new subdirectory — the mirror's own `index.html` at the repo root is not
touched.

## Steps

1. **`tools/extract.py`** — read-only over the mirror, writes the two JSON files.
   - Locate every `<script>` body; unescape each independently (tolerant fallback when
     `json.loads('"'+s+'"')` fails, handling `\n \t \r \b \f \" \\ \/ \uXXXX`).
   - Brace-match every object that carries all 11 kept fields; dedupe by `id`.
   - Re-derive the image path and strip `$D`. Drop the 4 excluded fields.
   - Emit `categories.json` from the `{"slug","name","shortName","sortOrder"}` objects.
   - Print a summary (entry count, per-category counts, total spend) so the run is
     self-verifying.

2. **`tools/test_extract.py`** — stdlib `unittest`, no framework. Asserts:
   - `category/ecommerce-retail` yields 50 entries (the malformed-escaping regression —
     a strict parser yields 3, so this is the test that catches a future rewrite).
   - the `…hoa5x7k.png","description"` bare-quote sequence is handled;
   - `$D` stripping and `../../` rebasing;
   - global invariants: 1,273 unique ids, 1,273 unique `identityKey`, 28 categories,
     27 populated, every record has all 11 fields;
   - rank derivation: equal amounts order older `createdAt` first.

3. **`app/index.html`** — semantic markup. Labeled search input, category `<select>`,
   sort `<select>` (Spend / Clicks / Newest / Name, Spend default), result count in an
   `aria-live="polite"` region, `<table>` with `scope="col"` headers. Rows: rank, logo,
   name + description, category, amount, clicks, outbound link.

4. **`app/app.css`** — CSS custom properties, `prefers-color-scheme` light/dark,
   `prefers-reduced-motion` respected, visible `:focus-visible` rings, no fixed font or
   color choices that fail contrast.

5. **`app/app.js`** — `fetch()` the two JSON files, derive rank
   (`amountCents` desc, `createdAt` asc), filter by category, filter by a
   case-insensitive substring match over name + description + `sourceUrl` +
   `identityKey`, then sort. Render via one `innerHTML` pass.
   Image fallback: `onerror` swaps in a CSS monogram of the first character, which
   covers the 185 empty, 33 remote, and any offline cases.

## Verification

```bash
cd /home/renovibe79/outbid
python3 -m unittest tools.test_extract -v      # must pass
python3 tools/extract.py                       # regenerates app/data/*.json, prints summary
python3 -m http.server 8000
```

Then in a browser at `http://localhost:8000/app/`:

1. Header shows 1,273 listings and $240,118 total.
2. Search `outrank` → rows narrow; result count updates.
3. Category filter `Developer Tools` → 50 rows, correct top entry.
4. Sort by Clicks / Newest / Name reorders; Spend restores the default.
5. Spot-check a logo resolves (e.g. Modulate); a listing with no image shows a monogram.
6. Toggle OS dark mode; tab through rows — focus ring visible on every control.
7. Reload `http://localhost:8000/category/ecommerce-retail/index.html` — the original
   mirror is untouched and still behaves as it did.

## Skipped

- **A "Daily"/"Today" board.** Not derivable — the mirror stores one running total per
  product, not a payment history. Would require reimplementing what the original sold.
- **Entry detail pages.** Every row links out to `sourceUrl`; a local detail view would
  have nothing to add.
- **Pagination / virtualization.** 1,273 rows renders in one pass. Revisit only if a
  filter combination visibly stalls.
- **The mirror's Tailwind/woff2 styling.** Deliberate: the app gets its own CSS.

---

# Phase 2 — enhancements

Phase 1 (above) is complete and verified. This phase is additive; no Phase 1 behaviour
changes except the two noted under P2.4.

## P2.1 Category spend panel — the one visualization worth building

The leaderboard answers "who paid most"; it does not answer "where does the money go",
which is the obvious next question about this dataset.

**Form.** A horizontal bar **table**, not a free-standing plot: `category | bar | value`.
Chosen over a standalone chart because 27 categories x a label + a number is a table
with bars in it — the layout that makes every value readable without a tooltip and
without a legend. A plot would force the values behind hover.

**Color.** One series (total spend) -> **one hue for every bar** (slot-1 accent). Explicitly
NOT a value-ramp: coloring each bar darker-where-bigger double-encodes length as hue and
burns the free channel on information the bar already shows. Categories are nominal, so
they have no order a ramp could express. No legend — a single series needs none; the panel
heading names what is plotted. No categorical palette is involved, so the palette
validator does not apply.

**Mark specs.** Bar <= 24px (10px actual, in a table row); 4px rounded data-end, square at
the baseline (`border-radius: 0 4px 4px 0`); rows separated by whitespace, never a border
drawn around the mark; hairline recessive rules, solid, never dashed. Bar scales to the
largest category in the current slice.

**Text.** Category names and values wear text tokens (primary / muted), never the bar
hue — identity comes from the colored mark beside the text. Tabular figures, because the
values form a right-aligned column that must align vertically.

**Scoping.** The panel recomputes against the same filtered slice as the table, driven by
the one filter row above it. It is not a second, independent filter.

**Collapsed by default** in a `<details>` — 27 rows is a lot of vertical space above the
leaderboard, and it is a summary, not the primary view. Zero JS.

**Hover.** Native `title` attribute carrying the exact figure and listing count. A
tooltip here enhances; it never gates a value, because every value is already a visible
table cell.

## P2.2 CSV export of the current view

The archive's whole reason to exist is that the data can leave. A button exports exactly
the rows currently on screen — respecting search, category, and sort — so a filtered view
is the unit of export, not the full set.

- RFC 4180 quoting: a field containing `"`, `,`, or a newline is wrapped and doubled.
  A listing name or description from a scraped third-party site can contain any of those,
  so this is a correctness requirement, not a nicety.
- Fields: rank, display name, description, category, amount (dollars, 2dp), clicks,
  listed date, URL.
- UTF-8 with a BOM, so Excel renders the em-dashes and curly quotes in these listings
  correctly instead of as mojibake.
- Generated via `Blob` + a temporary object URL; the URL is revoked after the click.

## P2.3 Shareable URL state

Search, category, and sort are written to `location.hash` as they change, and read back
on load. Makes a filtered view shareable and survives reload/back. `hash` rather than a
query string so the page keeps working when opened from disk-adjacent static hosting.

- Empty/partial state writes nothing — a default view keeps a clean URL.
- `hashchange` is handled, so back/forward moves between views.

## P2.4 UI polish (two real fixes, not restyling)

- **Sticky table header.** `position: sticky` on `thead th`. With 1,273 rows the column
  meanings are otherwise scrolled off within one screen.
- **Stat tiles drop `tabular-nums`.** They currently use it, which is the wrong call:
  tabular is for numbers that align *vertically in a column*; the four stat values sit in
  a row and should use the font's proportional figures. The leaderboard's own `.num`
  cells keep tabular — those genuinely align.

## P2.5 `tools/verify_app.mjs` — a runnable check for the new JS

Ponytail rule: non-trivial logic leaves one runnable check. P2.2 and P2.3 add parsing
(CSV quoting, hash codec) and currently nothing asserts them.

Stdlib only, no npm install: Node 22's built-in `WebSocket` drives headless Chrome over
CDP, exactly as the throwaway harness used during Phase 1 verification. Assertions cover
the new surface — CSV escaping of a quote/comma/newline-bearing name, hash round-trip,
panel totals matching the filtered slice, stat-tile figure format, zero console errors,
zero broken images.

Deliberately not a full test framework. One file, exit non-zero on failure.

## Phase 2 verification

```bash
cd /home/renovibe79/outbid
python3 -m unittest tools.test_extract -v   # must still pass (18 tests)
python3 -m http.server 8000 &
node tools/verify_app.mjs                   # must exit 0
```

Plus by eye at `http://localhost:8000/app/`: the category panel tracks the filter; export
produces a CSV matching the visible rows; a copied URL reopens the same view; the header
stays pinned on scroll; the stat tiles read correctly in both color schemes.

## Phase 2 skipped

- **A scatter / correlation view** (clicks vs. spend). Two measures, and the relationship
  is dominated by a handful of high-spend outliers; a log axis would be needed to make the
  bulk legible. Adds interpretation risk for little insight.
- **A time series of spend by day.** Requires per-day history the mirror does not have —
  same blocker as the Daily board in Phase 1.
- **Server-side rendering / a build step.** Phase 1's no-build constraint still holds.
