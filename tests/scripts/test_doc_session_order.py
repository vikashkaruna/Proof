"""Regression coverage for the local-only private session chronology guard."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("doc_names", ROOT / "scripts/check-doc-names.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
MARKER = MODULE.MARKER


class SessionOrderTests(unittest.TestCase):
    def check(self, *entries, prefix=""):
        return MODULE.session_log_problems(prefix + MARKER + "\n" + "\n".join(entries))

    def test_quoted_marker_does_not_select_instruction_section(self):
        self.assertEqual(self.check("### 2026-10-09 18:06 UTC - fixture", prefix="Instructions quote `" + MARKER + "`.\n"), [])

    def test_same_day_minutes_must_be_newest_first(self):
        self.assertTrue(self.check("### 2026-10-09 06:00 UTC - fixture", "### 2026-10-09 18:00 UTC - fixture"))

    def test_duplicate_standalone_marker_is_rejected(self):
        self.assertTrue(self.check(MARKER))

    def test_missing_marker_is_rejected(self):
        self.assertTrue(MODULE.session_log_problems("### 2026-10-09 18:00 UTC - fixture"))

    def test_older_days_and_legacy_date_only_records_are_preserved(self):
        self.assertEqual(self.check("### 2026-10-09 18:00 UTC - fixture", "### 2026-10-09 - legacy", "### 2026-10-09 06:00 UTC - fixture", "### 2026-10-08 - legacy"), [])

    def test_timed_record_across_legacy_record_remains_ordered(self):
        self.assertTrue(self.check("### 2026-10-09 06:00 UTC - fixture", "### 2026-10-09 - legacy", "### 2026-10-09 18:00 UTC - fixture"))

    def test_day_inversion_is_rejected(self):
        self.assertTrue(self.check("### 2026-10-08 - fixture", "### 2026-10-09 - fixture"))

    def test_invalid_calendar_and_clock_are_rejected(self):
        for entry in ["### 2026-02-30 - fixture", "### 2026-10-09 25:00 UTC - fixture"]:
            with self.subTest(entry=entry):
                self.assertTrue(self.check(entry))

    def test_timed_record_requires_utc(self):
        self.assertTrue(self.check("### 2026-10-09 18:00 - fixture"))


if __name__ == "__main__":
    unittest.main()
