#!/usr/bin/env python3
"""Checks for the mirror extractor.

The important one is TestMalformedEscaping: the mirror contains a bare `"` where
`\"` belongs, which silently truncates a strict parse to 3 of 50 entries on one page.
If someone "simplifies" extract.py into a plain json.loads, that test is what catches it.

Run: python3 -m unittest tools.test_extract -v
"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import extract  # noqa: E402

ROOT = extract.ROOT
PAGE = ROOT / "category" / "ecommerce-retail" / "index.html"

# Expected totals, measured against the mirror on 2026-09-30.
EXPECTED_ENTRIES = 1273
EXPECTED_CATEGORIES = 28
EXPECTED_POPULATED = 27


class TestMalformedEscaping(unittest.TestCase):
    """Regression guard for the mirror's broken JS string escaping."""

    @classmethod
    def setUpClass(cls):
        cls.html = PAGE.read_text(encoding="utf-8", errors="replace")

    def test_source_contains_the_stray_quote(self):
        # If the mirror is ever re-captured cleanly this fails loudly rather than
        # silently making the rest of this class vacuous. Sliced so a failure prints
        # a short window rather than all 371 KB of the page.
        i = self.html.find('.png",')
        self.assertNotEqual(i, -1, "mirror no longer contains the stray quote")
        self.assertIn('description', self.html[i:i + 40])

    def test_strict_parse_of_the_flight_string_would_truncate(self):
        """Show why the obvious approach is wrong: it recovers only 3 of 50."""
        buf = ""
        key = "self.__next_f.push([1,"
        pos = 0
        while True:
            i = self.html.find(key, pos)
            if i == -1:
                break
            j = i + len(key)
            try:
                s, _ = json.JSONDecoder().raw_decode(self.html, j)
                buf += s
            except ValueError:
                pass
            pos = j + 1
        self.assertLessEqual(buf.count("identityKey"), 10)

    def test_tolerant_extraction_recovers_full_page(self):
        self.assertEqual(len(extract.extract_entries_from_html(self.html)), 50)

    def test_unescape_is_not_fooled_by_a_bare_quote(self):
        # The real malformed fragment: every quote escaped except the one after .png.
        src = r'\",\"imageUrl\":\"../../assets/hoa5x7k.png",\"description\":\"Shortcut Keyboards'
        out = extract.unescape_js(src)
        self.assertIn('"description":', out)
        self.assertIn('hoa5x7k.png","description"', out)


class TestNormalize(unittest.TestCase):
    def _entry(self, image_url):
        entry = {f: None for f in extract.FIELDS}
        entry["createdAt"] = "$D2026-08-25T13:42:13.967Z"
        entry["imageUrl"] = image_url
        return extract.normalize_entry(entry)

    def test_strips_rsc_date_marker(self):
        self.assertEqual(self._entry("")["createdAt"], "2026-08-25T13:42:13.967Z")

    def test_rebases_image_path(self):
        self.assertEqual(
            self._entry("../../external/h13dn03x.ico")["imageUrl"],
            "external/h13dn03x.ico",
        )

    def test_leaves_remote_and_data_uris_alone(self):
        for url in ("https://cdn.example.com/a.png", "data:image/svg+xml,%3Csvg%3E"):
            self.assertEqual(self._entry(url)["imageUrl"], url)


class TestRankOrder(unittest.TestCase):
    def test_higher_spend_wins(self):
        rows = [
            {"amountCents": 100, "createdAt": "2026-08-25T00:00:00.000Z"},
            {"amountCents": 900, "createdAt": "2026-08-25T00:00:00.000Z"},
        ]
        self.assertEqual(sorted(rows, key=extract.rank_key)[0]["amountCents"], 900)

    def test_equal_spend_puts_older_listing_first(self):
        older = {"amountCents": 500, "createdAt": "2026-08-20T00:00:00.000Z"}
        newer = {"amountCents": 500, "createdAt": "2026-08-28T00:00:00.000Z"}
        self.assertEqual(sorted([newer, older], key=extract.rank_key)[0], older)


class TestWholeMirror(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.entries, cls.categories = extract.load(ROOT)

    def test_entry_count(self):
        self.assertEqual(len(self.entries), EXPECTED_ENTRIES)

    def test_ids_are_unique(self):
        ids = [e["id"] for e in self.entries]
        self.assertEqual(len(ids), len(set(ids)))

    def test_one_row_per_product(self):
        keys = [e["identityKey"] for e in self.entries]
        self.assertEqual(len(keys), len(set(keys)))

    def test_every_record_is_complete(self):
        for e in self.entries:
            self.assertEqual(set(e), set(extract.FIELDS), e["id"])

    def test_category_counts(self):
        self.assertEqual(len(self.categories), EXPECTED_CATEGORIES)
        self.assertEqual(len({e["categorySlug"] for e in self.entries}),
                         EXPECTED_POPULATED)

    def test_dates_are_iso_utc(self):
        for e in self.entries:
            self.assertRegex(e["createdAt"], r"^\d{4}-\d{2}-\d{2}T[\d:.]+Z$")

    def test_amounts_are_non_negative_integers(self):
        for e in self.entries:
            self.assertIsInstance(e["amountCents"], int)
            self.assertGreaterEqual(e["amountCents"], 0)

    def test_payment_ids_are_not_exported(self):
        for e in self.entries:
            self.assertNotIn("polarOrderId", e)
            self.assertNotIn("polarCheckoutId", e)

    def test_local_images_resolve_on_disk(self):
        missing = [
            e["imageUrl"] for e in self.entries
            if e["imageUrl"]
            and not e["imageUrl"].startswith(("http", "data:"))
            and not (ROOT / e["imageUrl"]).exists()
        ]
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
