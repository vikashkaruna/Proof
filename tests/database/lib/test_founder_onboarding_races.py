"""Offline boundary tests for owned synthetic onboarding race fixture."""

import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "onboarding176_races", HERE / "founder-onboarding-races.py"
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Onboarding race fixture source unavailable")
RACES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RACES)


class OnboardingFixture(unittest.TestCase):
    def test_committed_fixture_has_no_temporary_schema_escape_or_business_assertions(
        self,
    ):
        program = RACES.fixture_program()
        self.assertEqual(program.count("\nbegin;\n"), 1)
        self.assertTrue(program.endswith("\ncommit;\n"))
        self.assertNotIn("pg_temp.", program)
        self.assertNotIn("create temp", program)
        self.assertIn("create schema onboarding176_race;", program)
        self.assertIn("onboarding176_race.onboard", program)
        self.assertNotIn("ordinary owner onboarding succeeds", program)
        self.assertNotIn("tenant_quota_exceeded", program)
        self.assertNotIn("set_config('axiom.platform_founder_sync'", program)

    def test_new_designation_race_starts_without_the_other_founder_designation(self):
        program = RACES.fixture_program(omit_other_designation=True)
        self.assertIn("designate_platform_founder(onboarding176_race.u(1)", program)
        self.assertNotIn("designate_platform_founder(onboarding176_race.u(2)", program)
        self.assertIn(
            "grant usage on schema onboarding176_race to authenticated", program
        )

    def test_canonical_race_program_keeps_old_snapshot_and_explicit_isolation_refusal_proof(
        self,
    ):
        text = (HERE / "founder-onboarding-races.py").read_text()
        self.assertIn('for isolation in ("repeatable read", "serializable")', text)
        self.assertIn('for mutation in ("designate", "revoke")', text)
        self.assertIn("ONBOARD176_OLD_SNAPSHOT", text)
        self.assertIn('"writeRefusedSqlstate": "25001"', text)
        self.assertNotIn("set transaction isolation", text.lower())

    def test_fixture_source_boundary_change_refuses_without_native_calls(self):
        import tempfile

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "tests/database/founder-onboarding-authority.test.sql"
            target.parent.mkdir(parents=True)
            target.write_text("begin; select 1; commit;")
            with self.assertRaisesRegex(ValueError, "boundary"):
                RACES.fixture_program(root)


if __name__ == "__main__":
    unittest.main()
