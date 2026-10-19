"""Offline boundary regressions; no Docker, credential or database access."""
import importlib.util
from pathlib import Path
import unittest

HERE=Path(__file__).resolve().parent
SPEC=importlib.util.spec_from_file_location('flow174_races',HERE/'explicit-data-flow-races.py')
if SPEC is None or SPEC.loader is None:
    raise RuntimeError('Declaration fixture source unavailable')
RACES=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RACES)


class DeclarationFixture(unittest.TestCase):
    def test_owned_child_program_has_one_explicit_transaction_and_no_temporary_schema_escape(self):
        program=RACES.fixture_program()
        self.assertEqual(program.count('\nbegin;\n'),1)
        self.assertTrue(program.endswith('\ncommit;\n'))
        self.assertNotIn('pg_temp.',program)
        self.assertNotIn('create temporary table',program)
        self.assertIn('create schema flow174_race;',program)
        self.assertIn("flow174_race.declare174(203,flow174_race.id(201))",program)
        self.assertNotIn("'declare2'",program)

    def test_canonical_runner_cannot_omit_authority_suite_or_real_lock_order_proof(self):
        root=HERE.parents[2]
        runner=(root/'scripts/test-database.sh').read_text()
        self.assertIn('"$suite" = explicit-data-flow-declarations.test.sql',runner)
        self.assertIn('python3 tests/database/lib/explicit-data-flow-races.py --container "$container_id"',runner)
        self.assertIn('data_flow174_suite_required',(HERE/'report-policy-phases.py').read_text())


if __name__=='__main__':
    unittest.main()
