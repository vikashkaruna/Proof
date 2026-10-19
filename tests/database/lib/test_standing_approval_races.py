"""Offline immutable owned-fixture CLI boundary; no Docker/SQL calls."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('standing173_races',Path(__file__).with_name('standing-approval-races.py'))
if spec is None or spec.loader is None:
    raise RuntimeError('Reviewed fixture helper unavailable')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class StandingFixtureIdentity(unittest.TestCase):
    def test_accepts_exact_immutable_native_identity_shape(self):
        module.validate_fixture_inputs('a'*64,'sha256:'+'b'*64)

    def test_refuses_names_tags_options_and_incomplete_identity(self):
        for container,image in [('axiom-bff','sha256:'+'b'*64),('a'*63,'sha256:'+'b'*64),('a'*64,'supabase/postgres:17.6.1.127'),('--format=x','sha256:'+'b'*64),('a'*64,'sha256:'+'G'*64)]:
            with self.subTest(container=container,image=image),self.assertRaises(module.Refused):
                module.validate_fixture_inputs(container,image)

    def test_real_fixture_generator_preserves_one_explicit_transaction(self):
        program=module.fixture_program()
        self.assertIn('create schema standing173_race;',program)
        self.assertTrue(program.endswith('commit;\n'))
        self.assertNotIn('pg_temp.',program)
        self.assertNotIn('rollback;',program)

if __name__=='__main__':
    unittest.main()
