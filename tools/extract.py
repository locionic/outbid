#!/usr/bin/env python3
"""Extract leaderboard records from the outbid.lol static mirror.

Reads the mirrored Next.js HTML (read-only) and writes app/data/entries.json and
app/data/categories.json.

Why this is not a plain JSON parse
----------------------------------
The mirror's React Server Components flight payload has malformed JS string escaping
in places: a bare `"` appears where `\"` belongs, e.g.

    ..."../../assets/hoa5x7k.png","description":"Shortcut K

Parsing the push() string literal as JSON terminates at that stray quote and recovers
only 3 of 50 entries from category/ecommerce-retail/index.html. So instead we unescape
each <script> body independently and then brace-match entry objects in the resulting
text, which recovers all 50. See test_extract.py, which guards this.

stdlib only.
"""

import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "app" / "data"

# The 11 fields the app needs. An object is only accepted if it carries all of them,
# which is what filters out the surrounding React element tree.
FIELDS = (
    "id",
    "categorySlug",
    "identityType",
    "identityKey",
    "sourceUrl",
    "displayName",
    "imageUrl",
    "description",
    "amountCents",
    "createdAt",
    "clickCount",
)

# Deliberately excluded from the output:
#   polarOrderId, polarCheckoutId  - the original operator's payment records
#   takeoverStartedAt              - null on all but one row
#   categoryRank                   - stored as 1 on 1271/1273 rows; rank is derived

SCRIPT_RE = re.compile(r"<script\b[^>]*>(.*?)</script>", re.S)
ENTRY_RE = re.compile(r'\{\\?"id\\?":\\?"[0-9a-fA-F]{8}-')
CATEGORY_RE = re.compile(
    r'\{"slug":"([a-z0-9-]+)","name":"(.*?)","shortName":"(.*?)","sortOrder":(\d+)\}'
)

_SIMPLE_ESCAPES = {
    "n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f",
    '"': '"', "'": "'", "\\": "\\", "/": "/", "0": "\0",
}


def unescape_js(s):
    """Best-effort JS string unescape. Tolerant of malformed input by design."""
    try:
        return json.loads('"' + s + '"')
    except ValueError:
        pass
    out = []
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c == "\\" and i + 1 < n:
            nxt = s[i + 1]
            if nxt in _SIMPLE_ESCAPES:
                out.append(_SIMPLE_ESCAPES[nxt])
                i += 2
                continue
            if nxt == "u" and i + 5 < n:
                try:
                    out.append(chr(int(s[i + 2:i + 6], 16)))
                    i += 6
                    continue
                except ValueError:
                    pass
            out.append(nxt)
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _script_text(html):
    """Unescaped text of every <script> body, concatenated."""
    return "\n".join(unescape_js(m.group(1)) for m in SCRIPT_RE.finditer(html))


def _brace_match(text, start, limit=40000):
    """Return the substring of `text` that is the JSON object beginning at `start`."""
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, min(start + limit, len(text))):
        c = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                in_string = False
        elif c == '"':
            in_string = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def extract_entries_from_html(html):
    """All listing records in one page, in document order, deduped by id."""
    text = _script_text(html)
    required = set(FIELDS)
    seen = set()
    found = []
    for m in ENTRY_RE.finditer(text):
        raw = _brace_match(text, m.start())
        if raw is None:
            continue
        try:
            obj = json.loads(raw)
        except ValueError:
            continue
        if required <= set(obj) and obj["id"] not in seen:
            seen.add(obj["id"])
            found.append(normalize_entry(obj))
    return found


def extract_categories_from_html(html):
    """Category metadata keyed by slug. Later duplicates win, which is harmless
    because the mirror repeats the identical object across several chunks."""
    found = {}
    for m in CATEGORY_RE.finditer(_script_text(html)):
        found[m.group(1)] = {
            "slug": m.group(1),
            "name": m.group(2),
            "shortName": m.group(3),
            "sortOrder": int(m.group(4)),
        }
    return found


def normalize_entry(obj):
    """Strip the RSC date marker and rebase the image path to the repo root."""
    entry = {k: obj[k] for k in FIELDS}
    # React serializes Dates as "$D2026-08-25T13:42:13.967Z".
    created = entry["createdAt"]
    if isinstance(created, str) and created.startswith("$D"):
        entry["createdAt"] = created[2:]
    # imageUrl is relative to category/<slug>/, e.g. "../../assets/h1l5i7k8.png".
    # Absent images are null in the source; normalise to "" so the field is always a string.
    url = entry["imageUrl"] or ""
    while url.startswith("../"):
        url = url[3:]
    entry["imageUrl"] = url
    return entry


def rank_key(entry):
    """All-time board ordering, per the site's own rules: higher spend wins, and
    equal amounts keep placement order (the older listing ranks higher)."""
    return (-entry["amountCents"], entry["createdAt"])


def load(root=ROOT):
    """Walk the mirror and return (entries, categories)."""
    entries = {}
    categories = {}
    for page in sorted(root.glob("**/*.html")):
        html = page.read_text(encoding="utf-8", errors="replace")
        for entry in extract_entries_from_html(html):
            entries.setdefault(entry["id"], entry)
        for slug, cat in extract_categories_from_html(html).items():
            categories.setdefault(slug, cat)
    return list(entries.values()), list(categories.values())


def main():
    entries, categories = load()
    categories.sort(key=lambda c: c["sortOrder"])
    entries.sort(key=rank_key)

    if not entries:
        print("error: no entries extracted - mirror layout may have changed",
              file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "entries.json").write_text(
        json.dumps(entries, indent=1, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    (OUT_DIR / "categories.json").write_text(
        json.dumps(categories, indent=1, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    # Self-verifying summary.
    per_cat = Counter(e["categorySlug"] for e in entries)
    dates = sorted(e["createdAt"] for e in entries)
    amounts = [e["amountCents"] for e in entries]

    print(f"entries      {len(entries)}")
    print(f"categories   {len(categories)} metadata, {len(per_cat)} populated")
    print(f"spend        ${sum(amounts) / 100:,.2f} total, "
          f"${min(amounts) / 100:,.2f} min, ${max(amounts) / 100:,.2f} max")
    print(f"window       {dates[0][:10]} -> {dates[-1][:10]}")
    print(f"clicks       {sum(e['clickCount'] for e in entries):,}")
    print(f"no image     {sum(1 for e in entries if not e['imageUrl'])}")
    thin = [f"{c}={n}" for c, n in per_cat.most_common() if n < 50]
    if thin:
        print(f"under 50     {', '.join(thin)}")
    empty = [c["slug"] for c in categories if c["slug"] not in per_cat]
    if empty:
        print(f"no entries   {', '.join(empty)}")
    print(f"written      {OUT_DIR}/entries.json, {OUT_DIR}/categories.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
