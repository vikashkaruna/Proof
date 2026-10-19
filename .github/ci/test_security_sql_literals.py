"""Offline regression for SQL payload escaping; no database or cloud commands."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    path = ROOT / "scripts" / name
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), path)
    if spec is None or spec.loader is None:
        raise ValueError("Reviewed SQL helper unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SqlLiterals(unittest.TestCase):
    def test_quote_backslash_payload_stays_one_explicit_escape_literal(self):
        # The backslash immediately before quote must not defeat doubled quotes
        # when the database has standard_conforming_strings disabled.
        payload = "user\\'; SELECT current_user; --"
        expected = "E'user\\\\''; SELECT current_user; --'"
        for name in (
            "adopt-migration-baseline.py",
            "marketing-db-job.py",
            "marketing-acceptance-readback.py",
        ):
            with self.subTest(name=name):
                self.assertEqual(load(name).postgres_literal(payload), expected)

    def test_nul_payload_is_refused_before_sql_construction(self):
        for name in (
            "adopt-migration-baseline.py",
            "marketing-db-job.py",
            "marketing-acceptance-readback.py",
        ):
            with self.subTest(name=name), self.assertRaises(ValueError):
                load(name).postgres_literal("invalid\x00literal")

    def test_bounded_preprod_database_selector_refuses_sql_punctuation(self):
        job = load("marketing-db-job.py")
        for value in (
            "axiom_proof_preprod';SELECT 1--",
            "axiom_proof_preprod\\x",
            "foreign_database",
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                job.admission_programs(value)


if __name__ == "__main__":
    unittest.main()
