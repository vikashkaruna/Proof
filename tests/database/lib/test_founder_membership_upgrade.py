"""Offline upgrade-input boundaries; native upgrade assertions run separately."""

import importlib.util
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "founder176_upgrade", HERE / "founder-membership-upgrade.py"
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Founder upgrade fixture unavailable")
UPGRADE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPGRADE)


class FounderMembershipUpgrade(unittest.TestCase):
    def test_real_prefix_and_final_projection_reconciliation_are_required(self):
        prefix, target = UPGRADE.migration_inputs()
        self.assertEqual(
            [int(p.name[:4]) for p in prefix], [v for v in range(176) if v != 132]
        )
        self.assertEqual(target.name, UPGRADE.MIGRATION)
        self.assertEqual(
            target.read_text().count(
                "select public.sync_platform_founder_memberships(null,null);"
            ),
            1,
        )
        self.assertLess(
            target.read_text().index(
                "select public.sync_platform_founder_memberships(null,null);"
            ),
            target.read_text().rindex("commit;"),
        )

    def test_missing_historical_migration_or_projection_step_cannot_be_substituted(
        self,
    ):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root / "infra/supabase/migrations"
            directory.mkdir(parents=True)
            for number in range(177):
                if number != 132:
                    (directory / f"{number:04d}_fixture.sql").write_text(
                        "-- offline inventory only"
                    )
            target = directory / UPGRADE.MIGRATION
            target.write_text("begin; select 1; commit;")
            with self.assertRaisesRegex(ValueError, "reconciliation"):
                UPGRADE.migration_inputs(root)
            (directory / "0001_fixture.sql").unlink()
            with self.assertRaisesRegex(ValueError, "historical"):
                UPGRADE.migration_inputs(root)

    def test_dirty_state_is_not_made_with_private_sync_flag_or_disabled_triggers(self):
        text = (HERE / "founder-membership-upgrade.py").read_text()
        self.assertNotIn("set_config('axiom.platform_founder_sync'", text)
        self.assertNotIn("disable trigger", text.lower())
        self.assertNotIn("session_replication_role", text)
        self.assertIn("FOUNDER176_UPGRADE_HELD", text)
        self.assertIn("mutationCommittedBeforeTenant", text)
        self.assertIn("onboard_organization", text)
        self.assertIn("revoke_platform_founder", text)
        self.assertIn("designate_platform_founder", text)
        program = UPGRADE.fixture_program()
        self.assertIn("'owner','2026-01-01T00:00:00Z'", program)
        self.assertNotIn("creation_authority", program)
        self.assertNotIn("insert into public.audit_ledger", program)

    def test_only_new_intake_projection_field_is_normalized_from_history(self):
        self.assertNotIn("-'creation_authority'", UPGRADE.snapshot_sql(upgraded=False))
        self.assertIn("-'creation_authority'", UPGRADE.snapshot_sql(upgraded=True))
        for name in (
            "explicit",
            "validDerived",
            "ledger",
            "designations",
            "users",
            "tenants",
            "engagements",
            "entitlements",
            "intakes",
        ):
            self.assertIn("'" + name + "'", UPGRADE.snapshot_sql(upgraded=True))

    def test_canonical_runner_invokes_owned_upgrade_exactly_once(self):
        text = (UPGRADE.ROOT / "scripts/test-database.sh").read_text()
        self.assertEqual(
            text.count(
                'python3 tests/database/lib/founder-membership-upgrade.py --container "$container_id" --image "$standing173_race_image"'
            ),
            1,
        )


if __name__ == "__main__":
    unittest.main()
