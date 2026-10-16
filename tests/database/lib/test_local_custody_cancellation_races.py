"""Offline149 contracts only. SQL/races NOT executed by these tests."""

import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "local149", HERE / "local-custody-cancellation-races.py"
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("fixture module unavailable")
RACES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RACES)


class CancellationRaces(unittest.TestCase):
    def test_exact_six_cases_keep_both_orders_and_expiry(self):
        cases = RACES.scenarios()
        self.assertEqual(len(cases), 6)
        self.assertEqual(len({c["name"] for c in cases}), 6)
        self.assertEqual(
            [c["counts"] for c in cases[:3]],
            [[1, 1, 1, 0, 1], [0, 0, 0, 1, 1], [0, 0, 0, 1, 1]],
        )
        self.assertEqual(cases[-1]["mode"], "expires")
        self.assertIn("RACE_DEADLINE=", cases[-1]["contender"])
        self.assertEqual(cases[-1]["error"], "42501")

    def test_uses_existing_exact47_witness_and_owned_guard(self):
        contract = "custody145:tenant:" + RACES.TENANT
        self.assertIn("47", RACES.BARRIER.custody145_probe_query(contract, 123, 456))
        with self.assertRaises(RACES.BARRIER.BarrierFailure):
            RACES.BARRIER.custody145_probe_query(contract + ";select", 123, 456)
        self.assertIs(RACES.Runner.owned, RACES.BASE.Runner.owned)
        self.assertIs(RACES.Runner.cleanup, RACES.BASE.Runner.cleanup)

    def test_absent_auth_standin_uses_reviewed_postgres_owner_setup(self):
        root = HERE.parents[2]
        reviewed = (
            root / "tests/database/local-custody-credential-issuance.test.sql"
        ).read_text()
        start = reviewed.index("do $fixture145_auth$")
        end = reviewed.index("end $fixture145_auth$;", start) + len(
            "end $fixture145_auth$;"
        )
        expected = reviewed[start:end].replace("fixture145_auth", "fixture149_auth")
        text = RACES.setup(root)
        self.assertIn(expected, text)
        self.assertEqual(text.count("create table auth.sessions("), 1)
        self.assertNotIn("create table if not exists auth.sessions", text.lower())
        self.assertNotIn("alter table auth.sessions", text.lower())
        self.assertNotIn("grant select on auth.sessions", text.lower())

    def test_fixture_namespace_before_writer_and_committed_once(self):
        text = RACES.setup(HERE.parents[2])
        self.assertIn(
            "grant usage on schema local149_race to human_action_writer,service_role",
            text,
        )
        self.assertNotIn("pg_temp.", text)
        self.assertNotIn("rollback;", text)
        self.assertTrue(text.endswith("commit;\n"))
        self.assertEqual(text.count("create schema local149_race"), 1)
        self.assertNotIn("delete from public.audit_ledger", text.lower())


if __name__ == "__main__":
    unittest.main()
