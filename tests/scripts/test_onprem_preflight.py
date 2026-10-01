"""Security regressions in the sovereign operator environment gate."""
import base64
import hashlib
import hmac
import importlib.util
import json
import secrets
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('onprem_preflight', ROOT / 'scripts/onprem-preflight.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def jwt(role, secret, *, alg='HS256', exp=None):
    enc = lambda x: base64.urlsafe_b64encode(json.dumps(x).encode()).decode().rstrip('=')
    now = int(time.time())
    body = enc({'alg': alg, 'typ': 'JWT'}) + '.' + enc({'role': role, 'iat': now, 'exp': exp if exp is not None else now + 3600})
    signature = base64.urlsafe_b64encode(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return body + '.' + signature


class OnpremPreflightTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / '.env.onprem'
        self.values = {}
        for name in MODULE.REQUIRED:
            self.values[name] = secrets.token_hex(32)
        self.values.update({
            'AXIOM_BIND_ADDRESS': '127.0.0.1',
            'NEXT_PUBLIC_APP_URL': 'http://127.0.0.1:3001',
            'NEXT_PUBLIC_BFF_URL': 'http://127.0.0.1:4000',
            'NEXT_PUBLIC_SUPABASE_URL': 'http://127.0.0.1:55321',
            'BFF_CORS_ORIGINS': 'http://127.0.0.1:3001',
            'AXIOM_EVIDENCE_BUCKET': 'evidence',
            'AXIOM_OFFLINE_LICENSE': 'v1.test.signature',
            'AXIOM_WORM_SERVER_IMAGE': 'registry.local/worm-server@sha256:' + 'a' * 64,
            'AXIOM_WORM_CLIENT_IMAGE': 'registry.local/worm-client@sha256:' + 'b' * 64,
        })
        self.values['SUPABASE_ANON_KEY'] = jwt('anon', self.values['SUPABASE_JWT_SECRET'])
        self.values['SUPABASE_SERVICE_KEY'] = jwt('service_role', self.values['SUPABASE_JWT_SECRET'])
        for name in (name for name in MODULE.REQUIRED if name.endswith('_IMAGE')):
            self.values[name] = 'registry.local/reviewed@sha256:' + secrets.token_hex(32)

    def tearDown(self):
        self.tmp.cleanup()

    def check(self):
        self.path.write_text(''.join(f'{k}={v}\n' for k, v in self.values.items()))
        self.path.chmod(0o600)
        return MODULE.read_env(self.path)

    def test_valid_private_environment(self):
        self.assertEqual(self.check()['AXIOM_BIND_ADDRESS'], '127.0.0.1')

    def test_demo_secret_and_hosted_key_fail(self):
        self.values['POSTGRES_PASSWORD'] = 'postgres'
        with self.assertRaisesRegex(ValueError, 'weak'):
            self.check()
        self.values['POSTGRES_PASSWORD'] = secrets.token_hex(32)
        self.values['OPENAI_API_KEY'] = 'hosted'
        with self.assertRaisesRegex(ValueError, 'prohibited'):
            self.check()

    def test_mismatched_jwt_secret_fails(self):
        self.values['SUPABASE_JWT_SECRET'] = secrets.token_hex(32)
        with self.assertRaisesRegex(ValueError, 'not signed'):
            self.check()

    def test_public_bind_and_egress_model_fail(self):
        self.values['AXIOM_BIND_ADDRESS'] = '0.0.0.0'
        with self.assertRaisesRegex(ValueError, 'private'):
            self.check()
        self.values['AXIOM_BIND_ADDRESS'] = '127.0.0.1'
        self.values['SELF_HOSTED_BASE_URL'] = 'https://models.example.com'
        with self.assertRaisesRegex(ValueError, 'local-model'):
            self.check()

    def test_world_readable_and_duplicate_key_fail(self):
        self.check()
        self.path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'mode 0600'):
            MODULE.read_env(self.path)
        self.path.chmod(0o600)
        with self.path.open('a') as file:
            file.write('POSTGRES_PASSWORD=duplicate\n')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            MODULE.read_env(self.path)

    def test_mutable_application_image_fails(self):
        self.values['AXIOM_BFF_IMAGE'] = 'axiom-bff:latest'
        with self.assertRaisesRegex(ValueError, 'immutable image digest'):
            self.check()

    def test_refuses_external_or_credentialed_origins_and_unapproved_cors(self):
        for candidate in ('http://public.example.com:3001', 'http://evil:3001',
                          'http://user:password@127.0.0.1:3001', 'http://127.0.0.1:3001/path'):
            with self.subTest(candidate=candidate):
                self.values['NEXT_PUBLIC_APP_URL'] = candidate
                with self.assertRaises(ValueError):
                    self.check()
        self.values['NEXT_PUBLIC_APP_URL'] = 'http://127.0.0.1:3001'
        self.values['BFF_CORS_ORIGINS'] = 'http://127.0.0.1:3001,http://evil.internal:3001'
        with self.assertRaisesRegex(ValueError, 'BFF_CORS_ORIGINS'):
            self.check()

    def test_refuses_wrong_jwt_algorithm_and_expiry(self):
        secret = self.values['SUPABASE_JWT_SECRET']
        self.values['SUPABASE_ANON_KEY'] = jwt('anon', secret, alg='none')
        with self.assertRaisesRegex(ValueError, 'HS256'):
            self.check()
        self.values['SUPABASE_ANON_KEY'] = jwt('anon', secret, exp=int(time.time()) - 1)
        with self.assertRaisesRegex(ValueError, 'expired'):
            self.check()


if __name__ == '__main__':
    unittest.main()
