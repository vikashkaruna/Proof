"""Offline source/ownership/semantic regressions; no Docker or SQL execution."""

import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / name)
    if spec is None or spec.loader is None:
        raise RuntimeError("fixture helper unavailable")
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


RACE = load("local-custody-issuance-races.py")
FIXTURE = load("local-custody-issuance-race-fixture.py")


class FixtureTests(unittest.TestCase):
    def test_genuine_reviewed_quorum_and_three_issuances_preserved(self):
        text = FIXTURE.setup(HERE.parent / "local-custody-credential-issuance.test.sql")
        self.assertIn("owned145 synthetic template only", text)
        self.assertIn("current_database()", text)
        self.assertIn("public.record_local_custody_policy_event", text)
        self.assertIn("'local_custody_policy'", text)
        self.assertIn(
            "set local session authorization axiom_local_custody_145_fixture_operator",
            text,
        )
        self.assertEqual(text.count("insert into local145_race.issuer145_saved"), 3)
        self.assertIn("local145_race.issue145(201)", text)
        self.assertNotIn("pg_temp.", text)
        self.assertNotIn("create temporary table", text)
        self.assertNotIn("delete from", text.lower())
        self.assertNotIn("update public.audit_ledger", text.lower())
        self.assertTrue(text.endswith("commit;\n"))

    def test_set_role_writer_has_only_required_namespace_and_id_access_before_calls(
        self,
    ):
        text = FIXTURE.setup(HERE.parent / "local-custody-credential-issuance.test.sql")
        usage = "grant usage on schema local145_race to human_action_writer;"
        execute = (
            "grant execute on function local145_race.id(int) to human_action_writer;"
        )
        self.assertIn(usage, text)
        self.assertIn(execute, text)
        first_call = text.index(
            "insert into local145_race.custody_saved values('request'"
        )
        self.assertLess(text.index(usage), first_call)
        self.assertLess(text.index(execute), first_call)
        self.assertGreater(
            text.index(execute), text.index("create function local145_race.id")
        )
        # Final PUBLIC revocation must not erase the explicit narrow ID grant.
        self.assertNotIn(
            "revoke all on all functions in schema local145_race from human_action_writer",
            text,
        )
        self.assertNotIn(
            "grant select on local145_race.requests to human_action_writer", text
        )
        self.assertNotIn("grant all", text.lower())
        self.assertNotIn("grant execute on all functions", text.lower())

    def test_changed_fixture_refused_without_generation(self):
        with tempfile.TemporaryDirectory() as raw:
            path = Path(raw) / "changed.sql"
            path.write_text("begin;commit;")
            with self.assertRaisesRegex(ValueError, "fixture_changed"):
                FIXTURE.setup(path)

    def test_17_unique_cases_and_six_exact_capability_waits(self):
        cases = RACE.scenarios()
        self.assertEqual(len(cases), 17)
        self.assertEqual(len({c["name"] for c in cases}), 17)
        for case in cases[:6]:
            self.assertEqual(case["error"], "42501")
            self.assertTrue(case["contract"].startswith("custody145:"))
            self.assertIn("pg_advisory_xact_lock", case["holder"])
            self.assertIn("set local session authorization", case["contender"])
        self.assertIn("alter role", cases[5]["holder"])
        self.assertIn("with admin false,inherit false,set true", cases[4]["holder"])
        self.assertEqual(cases[-1]["mode"], "expires")
        self.assertIn("RACE_DEADLINE=", cases[-1]["contender"])

    def test_both_orders_and_exact_replay_are_not_optional_cases(self):
        names = {c["name"] for c in RACE.scenarios()}
        for expected in [
            "duplicate-issue",
            "duplicate-revoke",
            "lost-response-exact-replay",
            "competing-predecessors",
            "policy-revoke-before-issue",
            "issue-before-policy-revoke",
            "actor-before-issue",
            "issue-before-actor",
            "workload-before-issue",
            "issue-before-workload",
        ]:
            self.assertIn(expected, names)

    def state(self):
        return {
            **{
                name: {"rows": 3, "hash": "old"}
                for name in ["credentials", "issuances", "revocations", "ledger"]
            },
            "history": "unchanged",
            "violations": 0,
            "orphanIssuances": 0,
            "orphanRevocations": 0,
        }

    def test_negative_wait_cannot_append_or_rewrite_authority(self):
        before = self.state()
        case = {"operation": "none"}
        RACE.validate_outcome(before, copy.deepcopy(before), case)
        for key in ["credentials", "issuances", "revocations", "ledger"]:
            for change in [{"rows": 4, "hash": "old"}, {"rows": 3, "hash": "changed"}]:
                after = copy.deepcopy(before)
                after[key] = change
                with self.assertRaises(ValueError):
                    RACE.validate_outcome(before, after, case)

    def test_positive_issue_allows_exactly_one_receipted_append(self):
        before = self.state()
        after = copy.deepcopy(before)
        for name in ["credentials", "issuances", "ledger"]:
            after[name] = {"rows": 4, "hash": "new"}
        RACE.validate_outcome(before, after, {"operation": "issue"})
        for key in ["violations", "orphanIssuances", "orphanRevocations"]:
            with self.assertRaises(ValueError):
                RACE.validate_outcome(before, {**after, key: 1}, {"operation": "issue"})
        with self.assertRaises(ValueError):
            RACE.validate_outcome(
                before, {**after, "history": "changed"}, {"operation": "issue"}
            )

    def test_role_and_database_cleanup_are_narrow_and_no_ledger_cleanup(self):
        text = (HERE / "local-custody-issuance-races.py").read_text()
        self.assertIn("if database not in self.databases", text)
        self.assertIn("GUARD.inspect(self.docker, self.cid, OWNER, self.image)", text)
        self.assertIn("preexisting_synthetic_roles_refused", text)
        self.assertNotIn("delete from", text.lower())
        self.assertNotIn('"rm", "-f"', text)
        self.assertNotIn("pg_sleep", text)
        self.assertNotIn("time.sleep", text)

    def test_wrong_name_or_owner_stops_before_sql(self):
        with patch.object(RACE.GUARD, "command") as call:
            with self.assertRaises(ValueError):
                RACE.Runner("supabase_db_axiom-owner-test", "image", Path("/tmp"))
            call.assert_not_called()
        with (
            patch.object(RACE, "OWNER", Path.cwd()),
            patch.object(RACE.shutil, "which", return_value="/fake/docker"),
            patch.object(
                RACE.GUARD, "command", return_value=json.dumps("sha256:" + "a" * 64)
            ) as call,
            patch.object(
                RACE.GUARD, "inspect", side_effect=RACE.GUARD.Refused("owner_mismatch")
            ),
            patch.object(RACE.subprocess, "run") as execute,
        ):
            with self.assertRaises(RACE.GUARD.Refused):
                RACE.Runner("axiom-db-test-123", "reviewed-image", Path("/tmp"))
            self.assertEqual(call.call_args.args[1][:2], ["image", "inspect"])
            execute.assert_not_called()

    def test_imports_do_not_create_processes(self):
        with (
            patch("subprocess.run", side_effect=AssertionError("no resource calls")),
            patch("subprocess.Popen", side_effect=AssertionError("no resource calls")),
        ):
            load("local-custody-issuance-races.py")
            load("local-custody-issuance-race-fixture.py")


if __name__ == "__main__":
    unittest.main()
