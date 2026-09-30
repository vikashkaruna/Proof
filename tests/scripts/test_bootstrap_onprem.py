"""Bootstrap ordering and fail-closed paths with every external command stubbed."""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class BootstrapOnpremTests(unittest.TestCase):
    def run_bootstrap(self, fail=''):
        with tempfile.TemporaryDirectory(prefix='axiom-onprem-bootstrap-') as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            (root / 'bin').mkdir()
            env_dir = root / 'infra/docker/environments'
            env_dir.mkdir(parents=True)
            (root / 'infra/docker/docker-compose.onprem.yml').touch()
            (root / 'infra/supabase').mkdir()
            (root / 'infra/supabase/bootstrap-selfhosted.sql').write_text('select 1;\n')
            shutil.copyfile(ROOT / 'scripts/bootstrap-onprem.sh', root / 'scripts/bootstrap-onprem.sh')
            (env_dir / '.env.onprem').write_text(
                'AXIOM_OFFLINE_LICENSE=v1.synthetic.token\n'
                'POSTGRES_PASSWORD=synthetic-password\n'
            )
            stub = '''#!/bin/sh
printf '%s %s\\n' "${0##*/}" "$*" >> "$STUB_LOG"
case "${0##*/} $*" in
  "docker compose "*" config --images") echo 'local/axiom:test'; exit 0 ;;
  "docker compose "*" logs --no-color supabase-auth") echo 'GoTrue API started'; exit 0 ;;
  "docker compose "*" run --rm --no-deps minio-init") [ "$STUB_FAIL" != worm ]; exit $? ;;
  "docker compose "*" run --rm --no-deps --entrypoint /app/node_modules/.bin/tsx bff "*) [ "$STUB_FAIL" != controls ]; exit $? ;;
  "pnpm tsx scripts/verify-license.ts") [ "$STUB_FAIL" != license ]; exit $? ;;
  "python3 scripts/migrate-database.py "*) [ "$STUB_FAIL" != migration ]; exit $? ;;
  "python3 scripts/onprem-preflight.py "*) [ "$STUB_FAIL" != preflight ]; exit $? ;;
esac
exit 0
'''
            for name in ('docker', 'pnpm', 'python3', 'node', 'psql'):
                executable = root / 'bin' / name
                executable.write_text(stub)
                executable.chmod(0o700)
            log = root / 'calls.log'
            env = {'PATH': f"{root / 'bin'}:/usr/bin:/bin", 'STUB_LOG': str(log), 'STUB_FAIL': fail}
            result = subprocess.run(['/bin/bash', str(root / 'scripts/bootstrap-onprem.sh')],
                                    cwd=root, env=env, text=True, capture_output=True, timeout=15, check=False)
            calls = log.read_text().splitlines() if log.exists() else []
            return result, calls

    def test_success_order_and_no_demo_users(self):
        result, calls = self.run_bootstrap()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('On-prem bootstrap stages passed', result.stdout)
        self.assertNotIn('pnpm seed:users', calls)
        self.assertLess(next(i for i, c in enumerate(calls) if 'up -d --no-deps --wait supabase-auth' in c),
                        next(i for i, c in enumerate(calls) if 'migrate-database.py' in c))
        self.assertLess(next(i for i, c in enumerate(calls) if 'minio-init' in c),
                        next(i for i, c in enumerate(calls) if 'up -d --no-deps agent-runtime bff' in c))

    def test_fail_closed_stages(self):
        for stage in ('preflight', 'license', 'migration', 'controls', 'worm'):
            with self.subTest(stage=stage):
                result, calls = self.run_bootstrap(stage)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('On-prem bootstrap stages passed', result.stdout)
                self.assertFalse(any('up -d --no-deps agent-runtime bff' in c for c in calls))


if __name__ == '__main__':
    unittest.main()
