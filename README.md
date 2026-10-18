# outbid.lol Leaderboard Mirror

A local mirror of the [outbid.lol](https://outbid.lol) all-time pay-to-rank leaderboard. This project extracts and displays listing data from a static snapshot of the site.

## Quick Start

Start a local server and open the app:

```bash
python3 -m http.server 8000
```

Then visit `http://localhost:8000/app/` in your browser.

## Test Commands

Run the extractor tests:

```bash
python3 -m unittest tools.test_extract -v
```

Run the browser verification tests:

```bash
node tools/verify_app.mjs
```

## Key Features

- **Leaderboard**: Browse 1,273 listings ranked by amount paid
- **Search**: Find listings by name, description, or URL
- **Filters**: Narrow results by category and spend tier (Whale, High, Mid, Low)
- **Sort**: Order by paid amount, clicks, estimated CPC, or date
- **CSV Export**: Download current view as CSV for offline analysis
- **Shareable URLs**: State is encoded in the URL hash for easy sharing
- **Category Spend Panel**: See where money is concentrated across categories

## Data Source

- Mirror of [outbid.lol](https://outbid.lol), captured 2026-09-01
- Extracts listings from static HTML snapshots
- Local data stored in `app/data/`