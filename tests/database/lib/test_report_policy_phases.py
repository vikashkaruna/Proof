"""Offline report policy-phase regressions. No Docker, SQL or credential access."""

import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "report_phases", HERE / "report-policy-phases.py"
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Phase helper unavailable")
PHASES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PHASES)


class PolicyPhases(unittest.TestCase):
    def directory(self):
        owned = tempfile.TemporaryDirectory()
        self.addCleanup(owned.cleanup)
        p = Path(owned.name).resolve()
        p.chmod(0o700)
        return p

    def test_inventory_exact_once_distinct_policy_phases(self):
        plan = PHASES.plan()
        self.assertEqual(plan["historical143"], list(PHASES.HISTORICAL))
        self.assertEqual(len(plan["all"]), len(set(plan["all"])))
        self.assertEqual(sorted(plan["historical143"] + plan["current"]), plan["all"])
        self.assertIn(PHASES.CURRENT, plan["current"])
        self.assertEqual(plan["currentVersion"], 172)
        self.assertIn(
            "local-public-control-assessment-dispatch.test.sql", plan["current"]
        )
        self.assertIn("local-custody-credential-identity.test.sql", plan["current"])
        self.assertIn("local-custody-credential-issuance.test.sql", plan["current"])
        self.assertIn(
            "local-custody-credential-issuance-demo.test.sql", plan["current"]
        )

    def test_latest_phase_refuses_missing145_suite_or_noncanonical_migration_inventory(
        self,
    ):
        root = self.directory()
        (root / "tests/database").mkdir(parents=True)
        (root / "infra/supabase/migrations").mkdir(parents=True)
        for source in (PHASES.ROOT / "tests/database").glob("*.test.sql"):
            (root / "tests/database" / source.name).write_text(
                "-- offline inventory only"
            )
        for source in (PHASES.ROOT / "infra/supabase/migrations").glob("*.sql"):
            (root / "infra/supabase/migrations" / source.name).write_text(
                "-- offline inventory only"
            )
        self.assertEqual(PHASES.plan(root)["currentVersion"], 172)
        custody = root / "tests/database/local-custody-operator-context.test.sql"
        custody.unlink()
        with self.assertRaisesRegex(ValueError, "custody148_context_suite_required"):
            PHASES.plan(root)
        custody.write_text("-- restored inventory only")
        dispatch = (
            root / "tests/database/local-public-control-assessment-dispatch.test.sql"
        )
        dispatch.unlink()
        with self.assertRaisesRegex(ValueError, "dispatch147_suite_required"):
            PHASES.plan(root)
        dispatch.write_text("-- restored inventory only")
        identity = root / "tests/database/local-custody-credential-identity.test.sql"
        identity.unlink()
        with self.assertRaisesRegex(ValueError, "identity146_suite_required"):
            PHASES.plan(root)
        identity.write_text("-- restored inventory only")
        missing = (
            root / "tests/database/local-custody-credential-issuance-demo.test.sql"
        )
        missing.unlink()
        with self.assertRaisesRegex(ValueError, "issuer145_suites_required"):
            PHASES.plan(root)
        missing.write_text("-- restored inventory only")
        (root / "infra/supabase/migrations/0132_unpublished.sql").write_text(
            "-- must not fabricate history"
        )
        with self.assertRaisesRegex(
            ValueError, "canonical_latest145_migrations_required"
        ):
            PHASES.plan(root)

    def test_current_connector_and_full_closure_suites_cannot_be_omitted(self):
        for suite, code in (
            ("postgresql-sandbox-discovery.test.sql", "sandbox163_suite_required"),
            ("full-closure-lifecycle.test.sql", "closure164_suites_required"),
            ("full-closure-source-graph.test.sql", "closure164_suites_required"),
            ("postgresql-discovery-requests.test.sql", "discovery165_suite_required"),
            ("owned-postgres-target.test.sql", "owned_target166_suite_required"),
            ("owned-human-plans.test.sql", "owned_human167_suite_required"),
            ("owned-execution-binding.test.sql", "owned_execution168_suite_required"),
            ("owned-effect-observations.test.sql", "owned_effect170_suite_required"),
            ("scheduled-postgresql-reads.test.sql", "scheduled_read171_suite_required"),
            ("prativedan-accounted-terminal.test.sql", "prativedan172_suite_required"),
        ):
            with self.subTest(suite=suite), tempfile.TemporaryDirectory() as raw:
                root = Path(raw)
                (root / "tests/database").mkdir(parents=True)
                (root / "infra/supabase/migrations").mkdir(parents=True)
                for source in (PHASES.ROOT / "tests/database").glob("*.test.sql"):
                    if source.name != suite:
                        (root / "tests/database" / source.name).write_text(
                            "-- inventory"
                        )
                for source in (PHASES.ROOT / "infra/supabase/migrations").glob("*.sql"):
                    (root / "infra/supabase/migrations" / source.name).write_text(
                        "-- inventory"
                    )
                with self.assertRaisesRegex(ValueError, code):
                    PHASES.plan(root)

    def test_preparation_copies_only143_historical_migrations(self):
        p = self.directory()
        PHASES.prepare(p)
        self.assertEqual(len(list((p / "migrations143").glob("*.sql"))), 143)
        self.assertEqual(
            [f.name for f in (p / "migration144").glob("*.sql")], [PHASES.MIGRATION]
        )
        with self.assertRaisesRegex(ValueError, "fresh_fixture_directory_required"):
            PHASES.prepare(p)

    def test_inventory_missing_and_duplicate_are_refused(self):
        p = self.directory()
        PHASES.prepare(p)
        plan = PHASES.plan()
        rows = [f"143|{n}" for n in plan["historical143"]] + [
            f"{plan['currentVersion']}|{n}" for n in plan["current"]
        ]
        for wrong in [
            rows[:-1],
            [
                r.replace(
                    f"{plan['currentVersion']}|", f"{plan['currentVersion'] - 1}|"
                )
                for r in rows
            ],
            rows + rows[:1],
            [r.replace("143|", "144|") for r in rows],
        ]:
            (p / "executed-suites.txt").write_text("\n".join(wrong) + "\n")
            with self.assertRaisesRegex(ValueError, "suite_inventory_not_exact_once"):
                PHASES.verify_inventory(p)
        (p / "executed-suites.txt").write_text("\n".join(rows) + "\n")
        PHASES.verify_inventory(p)
        self.assertTrue(
            json.loads((p / "suite-inventory-verified.json").read_text())["noneOmitted"]
        )

    def test_latest149_requires_cancellation_suite(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            shutil.copytree(PHASES.ROOT / "infra", root / "infra")
            shutil.copytree(PHASES.ROOT / "tests/database", root / "tests/database")
            (
                root / "tests/database/local-custody-intent-cancellation.test.sql"
            ).unlink()
            with self.assertRaisesRegex(
                ValueError, "custody149_cancellation_suite_required"
            ):
                PHASES.plan(root)

    def test_latest150_requires_mfa_clock_suite(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            shutil.copytree(PHASES.ROOT / "infra", root / "infra")
            shutil.copytree(PHASES.ROOT / "tests/database", root / "tests/database")
            (root / "tests/database/local-custody-mfa-time-contract.test.sql").unlink()
            with self.assertRaisesRegex(
                ValueError, "custody150_mfa_clock_suite_required"
            ):
                PHASES.plan(root)

    def test_latest151_requires_founder_authority_suite(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            shutil.copytree(PHASES.ROOT / "infra", root / "infra")
            shutil.copytree(PHASES.ROOT / "tests/database", root / "tests/database")
            (root / "tests/database/platform-founder-authority.test.sql").unlink()
            with self.assertRaisesRegex(
                ValueError, "founder151_authority_suite_required"
            ):
                PHASES.plan(root)

    def test_latest152_requires_founder_recovery_suite(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            shutil.copytree(PHASES.ROOT / "infra", root / "infra")
            shutil.copytree(PHASES.ROOT / "tests/database", root / "tests/database")
            (root / "tests/database/founder-mfa-recovery.test.sql").unlink()
            with self.assertRaisesRegex(ValueError, "recovery152_suite_required"):
                PHASES.plan(root)

    def test_latest155_requires_questionnaire_parity_suite(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            shutil.copytree(PHASES.ROOT / "infra", root / "infra")
            shutil.copytree(PHASES.ROOT / "tests/database", root / "tests/database")
            (root / "tests/database/questionnaire-evidence-parity.test.sql").unlink()
            with self.assertRaisesRegex(
                ValueError, "questionnaire155_parity_suite_required"
            ):
                PHASES.plan(root)

    def test_legacy_rows_commit_before_canonical144_and_then_replay(self):
        p = self.directory()
        PHASES.prepare(p)
        for version in (2, 3):
            text = PHASES.legacy_program(p, version)
            request = text.index("create temporary table board_requested")
            commit = text.index("COMMIT;", request)
            applying = text.index("Applying: " + PHASES.MIGRATION)
            replay = text.index("old exact request replays without policy upgrade")
            self.assertLess(request, commit)
            self.assertLess(commit, applying)
            self.assertLess(applying, replay)
            self.assertIn(f"schema_version'='{version}'", text)
            self.assertIn("six RPC OID ACL exact after upgrade", text)
            self.assertIn("six RPC OID ACL exact after checksum repeat", text)
            self.assertIn("all143 historical migration rows exact", text)
            self.assertIn("old document text-derived digest remains exact", text)
        with self.assertRaisesRegex(ValueError, "explicit_legacy_version_required"):
            PHASES.legacy_program(p, 1)

    def test_current_program_requires_explicit_generated_fixture(self):
        p = self.directory()
        PHASES.prepare(p)
        with self.assertRaisesRegex(ValueError, "generated_parity_fixture_required"):
            PHASES.current_program(p)
        (p / "parity-fixtures.sql").write_text(
            "-- owned synthetic placeholder for offline expansion only\n"
        )
        text = PHASES.current_program(p)
        self.assertNotIn("-- @coverage144_", text)
        self.assertIn("create temporary table board_requested", text)
        self.assertIn("exact four production TS parity fixtures", text)
        self.assertIn("actual SQL/TS complete document5 projection parity", text)
        self.assertIn("schema_version'='4'", text)
        self.assertNotIn("board source3 requested", text)

    def test_symlink_fixture_or_directory_refused(self):
        p = self.directory()
        q = self.directory()
        PHASES.prepare(p)
        (q / "fixture.sql").write_text("select 1;")
        (p / "parity-fixtures.sql").symlink_to(q / "fixture.sql")
        with self.assertRaisesRegex(ValueError, "generated_parity_fixture_required"):
            PHASES.current_program(p)
        (q / "linked").symlink_to(p, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "fixture_directory_boundary"):
            PHASES.protected(q / "linked")

    def test_current_marker_mutation_cannot_drop_setup_assertions(self):
        root = self.directory()
        (root / "tests/database").mkdir(parents=True)
        original = PHASES.ROOT / "tests/database"
        for name in PHASES.HISTORICAL:
            (root / "tests/database" / name).write_text((original / name).read_text())
        text = (
            (original / PHASES.CURRENT)
            .read_text()
            .replace("-- @coverage144_setup", "-- removed setup")
        )
        (root / "tests/database" / PHASES.CURRENT).write_text(text)
        (root / "parity-fixtures.sql").write_text("-- synthetic")
        with self.assertRaisesRegex(
            ValueError, "reviewed_current_suite_markers_changed"
        ):
            PHASES.current_program(root, root)


if __name__ == "__main__":
    unittest.main()
