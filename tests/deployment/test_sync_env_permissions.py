"""Execute the sync entrypoint against a fake gcloud; never load local secrets."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PRIVATE = 'synthetic-private-fixture-must-not-be-printed'


class SyncPermissionsTests(unittest.TestCase):
    def run_sync(self, action, mode='exists', rotation=False):
        with tempfile.TemporaryDirectory(prefix='axiom-sync-test-') as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            (root / 'bin').mkdir()
            shutil.copyfile(ROOT / 'scripts/sync-env.sh', root / 'scripts/sync-env.sh')
            config = root / 'infra/docker/environments'
            config.mkdir(parents=True)
            (config / '.env.preprod').write_text(
                'AXIOM_PROJECT_ID=axiom-sync-fixture\nAXIOM_REGION=asia-south1\n'
                'RESEND_FROM_EMAIL=sender@test.invalid\nCONTACT_RECIPIENT_EMAIL=receiver@test.invalid\n'
                'CONTACT_FALLBACK_RECIPIENT_EMAIL=fallback@test.invalid\n'
                + f'RESEND_API_KEY={PRIVATE}\n'
                + (f'AXIOM_MFA_ENCRYPTION_KEYS_PREVIOUS={PRIVATE}\n' if rotation else '')
            )
            stub = root / 'bin/gcloud'
            stub.write_text(f'#!{sys.executable}\n' + '''import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with Path(os.environ['STUB_LOG']).open('a') as out:
    out.write(json.dumps(args) + '\\n')
mode = os.environ['STUB_MODE']
if args[:2] == ['secrets', 'describe']:
    sys.exit(1 if mode in ['create', 'fail_create'] else 0)
if args[:3] == ['secrets', 'versions', 'add']:
    sys.stdin.read()
    sys.exit(1 if mode == 'fail_update' else 0)
if args[:2] == ['secrets', 'create']:
    sys.stdin.read()
    sys.exit(1 if mode == 'fail_create' else 0)
if args[:3] == ['run', 'services', 'update']:
    sys.exit(1 if mode == 'fail_service' else 0)
sys.exit(99)
''')
            stub.chmod(0o700)
            log = root / 'calls.jsonl'
            result = subprocess.run(
                ['/bin/bash', str(root / 'scripts/sync-env.sh'), 'preprod', action],
                cwd=root, capture_output=True, text=True, stdin=subprocess.DEVNULL,
                env={'PATH': str(root / 'bin') + os.pathsep + '/usr/bin:/bin',
                     'STUB_LOG': str(log), 'STUB_MODE': mode},
                timeout=30,
            )
            calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            self.assertNotIn(PRIVATE, result.stdout + result.stderr + json.dumps(calls))
            self.assertFalse(any('iam' in argument for call in calls for argument in call))
            return result, calls

    def test_existing_secret_sync_never_grants_iam(self):
        result, calls = self.run_sync('secrets')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertTrue(any(call[:3] == ['secrets', 'versions', 'add'] for call in calls))

    def test_new_secret_sync_leaves_iam_to_terraform(self):
        result, calls = self.run_sync('secrets', mode='create')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertTrue(any(call[:2] == ['secrets', 'create'] for call in calls))

    def test_rotating_key_sync_does_not_grant_shared_access(self):
        result, calls = self.run_sync('secrets', rotation=True)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertTrue(any('axiom-preprod-mfa-encryption-keys-previous' in call for call in calls))

    def test_version_failure_is_not_success(self):
        result, _ = self.run_sync('secrets', mode='fail_update')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Updated secret version:', result.stdout)
        self.assertNotIn('Secret Manager sync complete', result.stdout)

    def test_creation_failure_is_not_success(self):
        result, _ = self.run_sync('secrets', mode='fail_create')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Created new secret:', result.stdout)
        self.assertNotIn('Secret Manager sync complete', result.stdout)

    def test_cloud_run_update_preserves_other_env_and_service_identity(self):
        result, calls = self.run_sync('cloudrun')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(len(calls), 1)
        self.assertTrue(any(arg.startswith('--update-env-vars=') for arg in calls[0]))
        self.assertFalse(any(arg.startswith(('--set-env-vars', '--service-account')) for arg in calls[0]))

    def test_cloud_run_failure_is_not_success(self):
        result, _ = self.run_sync('cloudrun', mode='fail_service')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Cloud Run environment synchronization complete', result.stdout)


if __name__ == '__main__':
    unittest.main()
