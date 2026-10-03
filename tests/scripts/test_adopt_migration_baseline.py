"""Baseline adoption stops at the first migration that is not fully present."""

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import importlib.util  # noqa: E402
from unittest.mock import patch  # noqa: E402

spec = importlib.util.spec_from_file_location("adopt", ROOT / "scripts" / "adopt-migration-baseline.py")
adopt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adopt)


def mig(name, *tables):
    return (name, "\n".join(f"create table if not exists {t} (id int);" for t in tables) or "select 1;")


FILES = [mig("0001_a.sql", "public.a"), mig("0002_fn.sql"), mig("0003_b.sql", "public.b", "x.c"), mig("0004_d.sql", "public.d")]
HISTORY = {"0001": "a", "0002": "fn", "0003": "b", "0004": "d"}


class PlanTests(unittest.TestCase):
    def test_adopts_the_prefix_whose_tables_exist_and_stops_at_the_first_absent(self):
        done, why = adopt.plan(FILES, {"public.a", "public.b", "x.c"}, set(), HISTORY)
        self.assertEqual(done, ["0001_a.sql", "0002_fn.sql", "0003_b.sql"])
        self.assertIn("0004_d.sql: none of its tables exist", why)

    def test_a_half_applied_migration_stops_adoption_and_is_named(self):
        done, why = adopt.plan(FILES, {"public.a", "public.b"}, set(), HISTORY)
        self.assertEqual(done, ["0001_a.sql", "0002_fn.sql"])
        self.assertIn("0003_b.sql: only some of its tables exist", why)

    def test_recorded_migrations_are_skipped(self):
        done, _ = adopt.plan(FILES, {"public.a", "public.b", "x.c", "public.d"}, {"0001_a.sql"}, HISTORY)
        self.assertEqual(done, ["0002_fn.sql", "0003_b.sql", "0004_d.sql"])

    def test_nothing_exists_adopts_nothing(self):
        done, why = adopt.plan(FILES, set(), set(), HISTORY)
        self.assertEqual(done, [])
        self.assertIn("0001_a.sql", why)

    def test_table_presence_does_not_adopt_a_migration_without_history(self):
        done, why = adopt.plan(FILES, {"public.a", "public.b", "x.c", "public.d"}, set(), {"0001": "a"})
        self.assertEqual(done, ["0001_a.sql"])
        self.assertIn("0002_fn.sql: no matching Supabase history", why)

    def test_wrong_history_name_does_not_adopt_a_migration(self):
        done, why = adopt.plan(FILES, {"public.a"}, set(), {"0001": "other"})
        self.assertEqual(done, [])
        self.assertIn("schema audit required", why)

    def test_apply_refuses_to_write_when_history_has_a_gap(self):
        answers = iter(["t", "0000_bootstrap_roles_and_extensions.sql", "t", "0001|a", "public.a"])
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            (folder / "0001_a.sql").write_text("create table public.a (id int);")
            (folder / "0002_fn.sql").write_text("create function public.f() returns int language sql as $$select 1$$;")
            with patch.object(adopt, "psql", side_effect=lambda *_: next(answers)) as db:
                self.assertEqual(adopt.main(["--container", "supabase_db_test", "--migrations", temporary, "--apply"]), 2)
        self.assertEqual(db.call_count, 5)

    def test_unqualified_tables_are_public_and_quotes_are_ignored(self):
        self.assertEqual(adopt.created_tables('create table "Foo" (id int); create table s.bar (id int);'), ["public.Foo", "s.bar"])

    def test_a_container_name_is_all_that_is_accepted(self):
        for bad in ("postgres://u:p@h/db", "a b", "--help"):
            with self.assertRaises(SystemExit):
                adopt.main(["--container", bad])


if __name__ == "__main__":
    unittest.main()
