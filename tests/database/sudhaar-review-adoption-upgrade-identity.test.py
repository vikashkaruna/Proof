#!/usr/bin/env python3
"""Independent fake-Docker regressions: no admin command after identity drift."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
ID = 'a' * 64


class UpgradeIdentityTest(unittest.TestCase):
    def run_fixture(self, fault='', after=0):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            docker = path / 'docker'
            docker.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
base = pathlib.Path(os.environ['FAKE_DOCKER_DIR'])
args = sys.argv[1:]
with (base/'calls').open('a') as out: out.write(json.dumps(args)+'\\n')
if args[0] == 'inspect':
 if '--format' in args: print('a'*64); sys.exit(0)
 counter = base/'counter'
 count = int(counter.read_text())+1 if counter.exists() else 1
 counter.write_text(str(count))
 item = {'Id':'a'*64, 'Name':'/axiom-db-test-11720261008',
  'Config':{'Labels':{'com.axiom.owner-worktree':os.environ['EXPECTED_OWNER'],
   'com.axiom.fixture':'database-policy-test','com.axiom.fixture.project':'axiom-db-tests'}},
  'HostConfig':{'PortBindings':{}},'NetworkSettings':{'Ports':{'5432/tcp':None}}}
 fault = os.environ['IDENTITY_FAULT'] if count >= int(os.environ['FAULT_AFTER']) else ''
 if fault in ('Id','Name'): item[fault] = 'replaced'
 elif fault in ('owner','kind','project'):
  label = {'owner':'com.axiom.owner-worktree','kind':'com.axiom.fixture','project':'com.axiom.fixture.project'}[fault]
  item['Config']['Labels'][label] = 'foreign'
 elif fault == 'ports': item['NetworkSettings']['Ports']['5432/tcp'] = [{'HostPort':'5432'}]
 elif fault == 'bindings': item['HostConfig']['PortBindings']['5432/tcp'] = [{'HostPort':'5432'}]
 print(json.dumps([item]))
elif args[0] == 'exec' and 'psql' in args: sys.stdin.read()
''')
            docker.chmod(0o700)
            env = dict(os.environ, PATH=str(path)+os.pathsep+os.environ['PATH'],
                       FAKE_DOCKER_DIR=str(path), EXPECTED_OWNER=str(ROOT),
                       IDENTITY_FAULT=fault, FAULT_AFTER=str(after))
            result = subprocess.run(['bash', 'tests/database/sudhaar-review-adoption-upgrade.sh',
                                     'axiom-db-test-11720261008'], cwd=ROOT, env=env,
                                    capture_output=True, text=True)
            calls = [json.loads(line) for line in (path/'calls').read_text().splitlines()]
            return result, calls

    def test_all_operations_bound_to_full_id_and_rechecked(self):
        result, calls = self.run_fixture()
        self.assertEqual(result.returncode, 0, result.stderr)
        operations = [call for call in calls if call[0] == 'exec']
        self.assertEqual(len(operations), 8)
        for index, call in enumerate(calls):
            if call[0] == 'exec':
                self.assertIn(ID, call)
                self.assertEqual(calls[index-1], ['inspect', ID])
        self.assertIn('dropdb', operations[-1])

    def test_initial_foreign_identity_refuses_creation(self):
        for fault in ('Id', 'Name', 'owner', 'kind', 'project', 'ports', 'bindings'):
            with self.subTest(fault=fault):
                result, calls = self.run_fixture(fault, 1)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any(call[0] == 'exec' for call in calls))

    def test_midflight_drift_refuses_sql_and_cleanup(self):
        for fault in ('Id', 'Name', 'owner', 'kind', 'project', 'ports', 'bindings'):
            with self.subTest(fault=fault):
                result, calls = self.run_fixture(fault, 3)
                self.assertNotEqual(result.returncode, 0)
                operations = [call for call in calls if call[0] == 'exec']
                self.assertEqual(len(operations), 1)
                self.assertIn('createdb', operations[0])
                self.assertIn('preserving evidence', result.stderr)
                # The mock proves no foreign cleanup; remove only its empty local scratch.
                scratch = result.stderr.split('preserving evidence at ')[-1].splitlines()[0]
                import shutil
                shutil.rmtree(scratch)


if __name__ == '__main__':
    unittest.main()
