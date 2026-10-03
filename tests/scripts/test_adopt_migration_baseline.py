"""Baseline adoption stops at the first migration that is not fully present."""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location("adopt", ROOT / "scripts" / "adopt-migration-baseline.py")
adopt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adopt)


def mig(name, *tables):
    return (name, "\n".join(f"create table if not exists {t} (id int);" for t in tables) or "select 1;")


FILES = [mig("0001_a.sql", "public.a"), mig("0002_fn.sql"), mig("0003_b.sql", "public.b", "x.c"), mig("0004_d.sql", "public.d")]


class PlanTests(unittest.TestCase):
    def test_adopts_the_prefix_whose_tables_exist_and_stops_at_the_first_absent(self):
        done, why = adopt.plan(FILES, {"public.a", "public.b", "x.c"}, set())
        self.assertEqual(done, ["0001_a.sql", "0002_fn.sql", "0003_b.sql"])
        self.assertIn("0004_d.sql: none of its tables exist", why)

    def test_a_half_applied_migration_stops_adoption_and_is_named(self):
        done, why = adopt.plan(FILES, {"public.a", "public.b"}, set())
        self.assertEqual(done, ["0001_a.sql", "0002_fn.sql"])
        self.assertIn("0003_b.sql: only some of its tables exist", why)

    def test_recorded_migrations_are_skipped(self):
        done, _ = adopt.plan(FILES, {"public.a", "public.b", "x.c", "public.d"}, {"0001_a.sql"})
        self.assertEqual(done, ["0002_fn.sql", "0003_b.sql", "0004_d.sql"])

    def test_nothing_exists_adopts_nothing(self):
        done, why = adopt.plan(FILES, set(), set())
        self.assertEqual(done, [])
        self.assertIn("0001_a.sql", why)

    def test_unqualified_tables_are_public_and_quotes_are_ignored(self):
        self.assertEqual(adopt.created_tables('create table "Foo" (id int); create table s.bar (id int);'), ["public.Foo", "s.bar"])

    def test_a_container_name_is_all_that_is_accepted(self):
        for bad in ("postgres://u:p@h/db", "a b", "--help"):
            with self.assertRaises(SystemExit):
                adopt.main(["--container", bad])


if __name__ == "__main__":
    unittest.main()
