# Local Leaderboard App

A static web app that displays leaderboard data from the outbid.lol mirror.

## What it is

This project is a local leaderboard viewer built from a static mirror of outbid.lol. It extracts and presents data from 1,273 top-50-per-category entries across 27 populated categories.

## Running

1. Extract the mirror data:
   ```bash
   python3 tools/extract.py
   ```

2. Start the static server:
   ```bash
   python3 -m http.server 8000
   ```

3. Open in browser:
   ```
   open http://localhost:8000/app/
   ```

## Running Tests

Python extraction tests:
```bash
python3 -m unittest tools.test_extract -v
```

JavaScript app verification:
```bash
node tools/verify_app.mjs
```

## Key Features

- **Search**: Filter entries by name/description
- **Filter**: Narrow by category or search term
- **Sort**: Order by spend, clicks, or name
- **Category spend panel**: Visualize total spend per category
- **CSV export**: Download current view as CSV
- **Shareable URLs**: State reflected in hash for sharing
- **Detail modal**: Click entries for more info
- **Theme switcher**: Toggle between light/dark modes

## Data Source and Limitations

- **Snapshot date**: 2026-09-01
- **Entry count**: 1,273 entries (top-50 per category across 27 populated categories)
- **Categories**: 28 total, 27 with entries
- **Limitations**: No daily/today boards; data is a point-in-time snapshot from the mirror

## Project Structure

```
├── app/
│   ├── index.html      # App entry point
│   ├── app.js          # App JavaScript
│   └── app.css         # App styles
├── app/data/
│   ├── entries.json    # Extracted leaderboard entries
│   └── categories.json # Category metadata
├── category/           # Source mirror HTML by category
├── tools/
│   ├── extract.py      # Data extraction script
│   ├── test_extract.py # Extractor tests
│   └── verify_app.mjs  # App verification tests
└── index.html          # Root mirror HTML
```