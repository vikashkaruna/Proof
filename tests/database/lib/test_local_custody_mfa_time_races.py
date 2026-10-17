"""Offline150 race contracts only; these tests never start transport/resources."""

import copy
import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "local150", HERE / "local-custody-mfa-time-races.py"
)
RACES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RACES)


class MfaTimeRaces(unittest.TestCase):
    def test_six_distinct_afterwait_contracts(self):
        cases = RACES.scenarios()
        self.assertEqual(len(cases), 6)
        self.assertEqual(len({c["name"] for c in cases}), 6)
        self.assertEqual(sum(c.get("mode") == "expires" for c in cases), 2)
        self.assertEqual([c["error"] for c in cases], [None, *["42501"] * 5])
        for case in cases:
            if case.get("mode") == "expires":
                self.assertIn("RACE_DEADLINE=", case["contender"])

    def test_issue_uses_actual_rpc_without_fixture_prelock(self):
        text = RACES.setup(HERE.parents[2])
        body = text.split("create function local150_race.issue_after_release()")[1]
        self.assertNotIn("pg_advisory_xact_lock", body)
        self.assertIn("local150_race.issue(1", body)
        self.assertNotIn("transaction_timestamp()", body)
        self.assertIn("public.issue_local_custody_mfa_challenge", text)
        self.assertNotIn("pg_temp.", text)
        self.assertTrue(text.endswith("commit;\n"))

    def test_issue_deadline_is_created_in_contender_not_before_startup(self):
        case = RACES.scenarios()[0]
        sql = case["contender"]
        self.assertLess(
            sql.index("held_until=clock_timestamp()+interval '2 seconds'"),
            sql.index("RACE_DEADLINE="),
        )
        self.assertLess(
            sql.index("RACE_DEADLINE="),
            sql.index("select local150_race.issue_after_release()"),
        )
        self.assertIn("transaction_started_at=transaction_timestamp()", sql)
        self.assertIn(
            "transaction_started_at<held_until and held_until>clock_timestamp()", sql
        )
        import inspect

        startup = inspect.getsource(RACES.Runner.race)
        self.assertNotIn("set held_until=", startup)

    @staticmethod
    def assert_no_restricted_binding_after_service_role(text):
        import re

        windows = re.findall(
            r"set local role service_role;(.*?)(?:reset role;|execute format\('set local role)",
            text,
            re.DOTALL,
        )
        if not windows:
            raise AssertionError("expected real service-role windows")
        for window in windows:
            if re.search(
                r"(?:pg_temp|local150_race)\.binding\(|controller_security\.", window
            ):
                raise AssertionError("restricted fixture binding under service_role")

    def test_native_and_race_bindings_precomputed_before_service_role(self):
        root = HERE.parents[2]
        native = (
            root / "tests/database/local-custody-mfa-time-contract.test.sql"
        ).read_text()
        race = RACES.setup(root)
        self.assert_no_restricted_binding_after_service_role(native)
        self.assert_no_restricted_binding_after_service_role(race)
        self.assertIn(
            "binding_digest text:=pg_temp.binding(request_text,actor)", native
        )
        self.assertIn(
            "binding_digest:=local150_race.binding(s.q,1);set local role service_role",
            race,
        )
        migration = (
            root / "infra/supabase/migrations/0150_local_custody_mfa_database_clock.sql"
        ).read_text()
        self.assertNotIn("grant usage on schema controller_security", migration.lower())

    def test_prior_rpc_argument_evaluation_under_service_role_is_caught(self):
        legacy = "set local role service_role;perform public.issue_local_custody_mfa_challenge(pg_temp.binding(request_text,actor));execute format('set local role %I',prior);"
        with self.assertRaisesRegex(AssertionError, "restricted fixture binding"):
            self.assert_no_restricted_binding_after_service_role(legacy)

    def test_actual47_guard_and_cleanup_reused(self):
        contract = "custody145:tenant:" + RACES.TENANT
        self.assertIn("47", RACES.BARRIER.custody145_probe_query(contract, 123, 456))
        with self.assertRaises(RACES.BARRIER.BarrierFailure):
            RACES.BARRIER.custody145_probe_query(contract + ";select", 123, 456)
        self.assertIs(RACES.Runner.owned, RACES.BASE.Runner.owned)
        self.assertIs(RACES.Runner.cleanup, RACES.BASE.Runner.cleanup)
        self.assertIs(RACES.BARRIER, RACES.BASE.BARRIER)

    def test_issue_earlier_clock_or_changed_ttl_is_causally_refused(self):
        case = RACES.scenarios()[0]
        base = {"violations": 0}
        good = {
            "satisfied": False,
            "consumed": False,
            "originalExpiryUnchanged": True,
            "deadlineAfterTransactionStart": True,
            "issuedAfterHeldDeadline": True,
            "issuedAfterTransactionStart": True,
            "exactTtl": True,
        }
        RACES.validate_outcome(case, good, base, base)
        for key in [
            "deadlineAfterTransactionStart",
            "issuedAfterHeldDeadline",
            "issuedAfterTransactionStart",
            "exactTtl",
        ]:
            bad = copy.deepcopy(good)
            bad[key] = False
            with (
                self.subTest(key=key),
                self.assertRaisesRegex(ValueError, "post_held_deadline"),
            ):
                RACES.validate_outcome(case, bad, base, base)

    def test_single_winner_and_no_renewal_are_causally_required(self):
        for case in RACES.scenarios()[1:]:
            value = {
                "satisfied": case["satisfied"],
                "consumed": case["consumed"],
                "originalExpiryUnchanged": True,
            }
            base = {"violations": 0}
            RACES.validate_outcome(case, value, base, base)
            for key in ["satisfied", "consumed", "originalExpiryUnchanged"]:
                changed = copy.deepcopy(value)
                changed[key] = not changed[key]
                with (
                    self.subTest(case=case["name"], key=key),
                    self.assertRaises(ValueError),
                ):
                    RACES.validate_outcome(case, changed, base, base)

    def test_ledger_authority_and_history_preservation(self):
        case = RACES.scenarios()[1]
        v = {"satisfied": True, "consumed": False, "originalExpiryUnchanged": True}
        with self.assertRaisesRegex(ValueError, "unrelated_authority"):
            RACES.validate_outcome(
                case, v, {"violations": 0, "rows": 0}, {"violations": 0, "rows": 1}
            )
        source = (HERE / "local-custody-mfa-time-races.py").read_text()
        self.assertIn("migration_history_changed", source)
        script = (HERE.parents[2] / "scripts/test-database.sh").read_text()
        self.assertEqual(
            script.count(
                'bash tests/database/concurrent-local-custody-mfa-time-contract.sh "$container" "$image"'
            ),
            1,
        )


if __name__ == "__main__":
    unittest.main()
