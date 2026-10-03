"""The production audit wrapper: allowlisted advisories pass until they expire."""

import sys
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import audit_prod  # noqa: E402


def report(*advisories):
    return {"advisories": {str(i): a for i, a in enumerate(advisories)}}


def adv(ghsa="GHSA-aaaa-bbbb-cccc", severity="high", name="braces"):
    return {"github_advisory_id": ghsa, "severity": severity, "module_name": name, "vulnerable_versions": "<=1.0.0"}


ALLOWED = {"GHSA-aaaa-bbbb-cccc": {"ghsa": "GHSA-aaaa-bbbb-cccc", "reason": "r", "expires": "2026-11-02"}}
TODAY = date(2026, 10, 3)


class AuditProdTests(unittest.TestCase):
    def test_unlisted_high_advisory_fails(self):
        failures, _ = audit_prod.evaluate(report(adv("GHSA-other-other-other")), ALLOWED, TODAY)
        self.assertEqual(len(failures), 1)
        self.assertIn("not allowlisted", failures[0])

    def test_allowlisted_advisory_passes_with_a_note(self):
        failures, notes = audit_prod.evaluate(report(adv()), ALLOWED, TODAY)
        self.assertEqual(failures, [])
        self.assertIn("allowed until 2026-11-02", notes[0])

    def test_expired_allowance_fails_again(self):
        failures, _ = audit_prod.evaluate(report(adv()), ALLOWED, date(2026, 11, 3))
        self.assertEqual(len(failures), 1)
        self.assertIn("expired", failures[0])

    def test_the_expiry_day_itself_still_passes(self):
        failures, _ = audit_prod.evaluate(report(adv()), ALLOWED, date(2026, 11, 2))
        self.assertEqual(failures, [])

    def test_critical_is_blocking_and_lower_severities_are_ignored(self):
        failures, _ = audit_prod.evaluate(report(adv("GHSA-x-y-z", "critical"), adv("GHSA-m-o-d", "moderate")), {}, TODAY)
        self.assertEqual(len(failures), 1)
        self.assertIn("critical", failures[0])

    def test_an_empty_report_passes(self):
        self.assertEqual(audit_prod.evaluate({"advisories": {}}, {}, TODAY), ([], []))

    def test_allowlist_entries_need_a_reason_and_an_expiry(self):
        import json, tempfile
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "a.json"
            path.write_text(json.dumps({"allowed": [{"ghsa": "GHSA-a-b-c", "expires": "2026-11-02"}]}))
            with self.assertRaises(ValueError):
                audit_prod.load_allowlist(path)

    def test_the_committed_allowlist_is_valid_and_every_entry_expires(self):
        allowed = audit_prod.load_allowlist()
        self.assertTrue(allowed)
        for entry in allowed.values():
            date.fromisoformat(entry["expires"])


class TrivyIgnoreParityTests(unittest.TestCase):
    def test_every_allowlisted_id_and_alias_is_in_trivyignore_with_the_same_expiry(self):
        import json

        allow = json.loads((ROOT / "security" / "audit-allowlist.json").read_text())["allowed"]
        lines = {
            line.split()[0]: line.split("exp:")[1].strip()
            for line in (ROOT / ".trivyignore").read_text().splitlines()
            if "exp:" in line and not line.startswith("#")
        }
        for entry in allow:
            for ident in [entry["ghsa"], *entry.get("aliases", [])]:
                self.assertEqual(lines.get(ident), entry["expires"], ident)


if __name__ == "__main__":
    unittest.main()
