"""Offline process-level guard tests. The executable named Docker is our fake."""

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HELPER = Path(__file__).with_name("preprovision-local-custody-verifier.py").resolve()
ROOT = HELPER.parents[3]
SPEC = importlib.util.spec_from_file_location("custody_fixture", HELPER)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Fixture helper unavailable")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
CID = "a" * 64
IMAGE = "sha256:" + "b" * 64
FAKE = """import json, os, sys
from pathlib import Path
args = sys.argv[1:]
log = Path(os.environ['FAKE_LOG'])
prior = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
entry = {'args': args}
if args[0] == 'exec':
    entry['sql'] = sys.stdin.read()
with log.open('a') as stream:
    stream.write(json.dumps(entry) + '\\n')
mode = os.environ.get('FAKE_MODE', '')
if args[:2] == ['image', 'inspect']:
    print(json.dumps('sha256:' + 'b' * 64) if mode != 'short_image' else '"sha256:abc"')
elif args[:2] == ['container', 'inspect']:
    # Validate the actual generated template does not request Env/full inspect.
    fmt = args[3]
    if 'Env' in fmt or '{{json index' in fmt or 'json (index .Config.Labels' not in fmt:
        raise SystemExit(19)
    value = {'id': 'a' * 64, 'name': '/' + os.environ.get('FAKE_NAME', 'axiom-db-test-123'),
      'running': True, 'image': 'sha256:' + 'b' * 64, 'fixture': 'database-policy-test',
      'project': 'axiom-db-tests', 'owner': os.environ['FAKE_OWNER']}
    count = sum(call['args'][:2] == ['container', 'inspect'] for call in prior)
    if mode == 'wrong_owner': value['owner'] = '/another/worktree'
    if mode == 'empty_owner': value['owner'] = ''
    if mode == 'missing_owner': del value['owner']
    if mode == 'wrong_fixture': value['fixture'] = 'operator'
    if mode == 'wrong_project': value['project'] = 'carry'
    if mode == 'stopped': value['running'] = False
    if mode == 'string_running': value['running'] = 'true'
    if mode == 'wrong_image': value['image'] = 'sha256:' + 'c' * 64
    if mode == 'short_id': value['id'] = 'abc'
    if mode == 'wrong_name': value['name'] = '/supabase_db_axiom-owner-test'
    if mode == 'extra_field': value['Env'] = ['synthetic-secret']
    if mode == 'drift_id' and count: value['id'] = 'd' * 64
    if mode == 'drift_name' and count: value['name'] = '/axiom-db-test-124'
    if mode == 'drift_image' and count: value['image'] = 'sha256:' + 'd' * 64
    print('{not JSON' if mode == 'invalid_json' else json.dumps(value))
elif args[0] == 'exec':
    if mode in ('unsafe_role', 'not_superuser'):
        print('synthetic-secret internal SQL details', file=sys.stderr)
        raise SystemExit(1)
    print('unexpected output' if mode == 'bad_receipt' else 'axiom-local-custody-fixture-ready')
else:
    raise SystemExit(20)
"""


class PreprovisionTests(unittest.TestCase):
    def run_fake(
        self,
        *,
        mode="",
        container="axiom-db-test-123",
        image="supabase/postgres:17.6.1.127",
        name=None,
        cwd=ROOT,
    ):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            executable = folder / "docker"
            executable.write_text(f"#!{sys.executable}\n" + FAKE)
            executable.chmod(0o700)
            log = folder / "calls.jsonl"
            env = {
                **os.environ,
                "PATH": str(folder) + os.pathsep + os.environ["PATH"],
                "FAKE_LOG": str(log),
                "FAKE_OWNER": str(ROOT),
                "FAKE_MODE": mode,
                "FAKE_NAME": name or container,
            }
            result = subprocess.run(
                [
                    sys.executable,
                    str(HELPER),
                    "--container",
                    container,
                    "--image",
                    image,
                ],
                env=env,
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            calls = (
                [json.loads(line) for line in log.read_text().splitlines()]
                if log.exists()
                else []
            )
            return result, calls

    def test_exact_pinned_role_block_and_trusted_single_transaction(self):
        self.assertEqual(
            hashlib.sha256(MODULE.ROLE_DO.encode()).hexdigest(), MODULE.ROLE_DO_SHA256
        )
        self.assertEqual(
            MODULE.ROLE_DO_SHA256,
            "61d8482b107a873b06b5664ab44abccd3d284438267a9ef83f0221cced7838cc",
        )
        result, calls = self.run_fake()
        self.assertEqual(result.returncode, 0, result.stderr)
        sql_calls = [c for c in calls if c["args"][0] == "exec"]
        self.assertEqual(len(sql_calls), 1)
        command = sql_calls[0]
        self.assertEqual(
            command["args"],
            [
                "exec",
                "-i",
                CID,
                "psql",
                "-X",
                "-U",
                "supabase_admin",
                "-d",
                "postgres",
                "-v",
                "ON_ERROR_STOP=1",
                "-Atq",
            ],
        )
        self.assertIn("session_user <> 'supabase_admin'", command["sql"])
        self.assertIn("rolname=current_user and rolsuper", command["sql"])
        self.assertIn(MODULE.ROLE_DO, command["sql"])
        self.assertTrue(command["sql"].startswith("begin;\n"))
        self.assertIn("commit;\nselect", command["sql"])
        self.assertNotIn("to postgres", command["sql"].lower())
        self.assertNotIn(
            "to authenticator",
            command["sql"].lower().replace(MODULE.ROLE_DO.lower(), ""),
        )
        # Repeated invocation uses the exact guarded DO, whose exists branch never GRANTs.
        again, again_calls = self.run_fake()
        self.assertEqual(again.returncode, 0)
        self.assertEqual(sql_calls, [c for c in again_calls if c["args"][0] == "exec"])
        self.assertLess(
            MODULE.ROLE_DO.index("if not exists"), MODULE.ROLE_DO.index("create role")
        )
        self.assertLess(
            MODULE.ROLE_DO.index("grant axiom_"), MODULE.ROLE_DO.index("end if;")
        )

    def test_each_explicit_owned_fixture_family_and_full_id(self):
        for name in (
            "axiom-db-test-123",
            "axiom-dsn-test-123",
            "axiom-sh-db-123",
            "axiom-prativedan-0123456789ab",
            "axiom-prativedan-controller-0123456789ab",
        ):
            with self.subTest(name=name):
                for container in (name, CID):
                    result, calls = self.run_fake(container=container, name=name)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(
                        [
                            c["args"][-1]
                            for c in calls
                            if c["args"][:2] == ["container", "inspect"]
                        ],
                        [container, CID],
                    )

    def test_identity_refusals_have_zero_privileged_sql(self):
        for mode in (
            "short_image",
            "wrong_owner",
            "empty_owner",
            "missing_owner",
            "wrong_fixture",
            "wrong_project",
            "stopped",
            "string_running",
            "wrong_image",
            "short_id",
            "wrong_name",
            "extra_field",
            "invalid_json",
            "drift_id",
            "drift_name",
            "drift_image",
        ):
            with self.subTest(mode=mode):
                result, calls = self.run_fake(mode=mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any(c["args"][0] == "exec" for c in calls))
                self.assertNotIn("synthetic-secret", result.stderr)

    def test_operator_and_partial_ids_refused_before_any_docker(self):
        for container in (
            "supabase_db_axiom-owner-test",
            "axiom-db-test-123-extra",
            "a" * 12,
            "-x",
            "carry",
            "axiom-sh-auth-123",
        ):
            result, calls = self.run_fake(container=container)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(calls, [])

    def test_invalid_image_and_foreign_cwd_refused_before_docker(self):
        for image in ("", "bad image", "bad\nimage", "-bad", "a" * 513):
            result, calls = self.run_fake(image=image)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(calls, [])
        with tempfile.TemporaryDirectory() as folder:
            result, calls = self.run_fake(cwd=folder)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(calls, [])

    def test_sql_privilege_or_unsafe_role_refusal_is_sanitized(self):
        for mode in ("not_superuser", "unsafe_role", "bad_receipt"):
            result, calls = self.run_fake(mode=mode)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(sum(c["args"][0] == "exec" for c in calls), 1)
            self.assertNotIn("synthetic-secret", result.stdout + result.stderr)
            self.assertNotIn("Traceback", result.stderr)

    def test_mismatched_full_id_is_not_retargeted(self):
        result, calls = self.run_fake(container="f" * 64, name="axiom-db-test-123")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(c["args"][0] == "exec" for c in calls))

    def test_five_owned_entrypoints_hook_before_migration_without_escalating_migrator(
        self,
    ):
        for name in (
            "scripts/test-database.sh",
            "tests/database/prativedan-assessment-codec-fixture.sh",
            "tests/database/prativedan-assessment-runtime-fixture.sh",
            "tests/database/migration-dsn.sh",
            "tests/deployment/selfhosted-supabase.sh",
        ):
            with self.subTest(name=name):
                source = (ROOT / name).read_text()
                hook = source.index(
                    "python3 tests/database/lib/preprovision-local-custody-verifier.py"
                )
                migration = source.index("python3 scripts/migrate-database.py")
                self.assertLess(hook, migration)
                self.assertEqual(
                    source.count("preprovision-local-custody-verifier.py"), 1
                )
                self.assertIn("--user postgres", source) if "--container" in source[
                    migration : source.index("\n", migration)
                ] else self.assertNotIn(
                    "supabase_admin", source[migration : source.index("\n", migration)]
                )
                for label in (
                    "com.axiom.fixture",
                    "com.axiom.fixture.project",
                    "com.axiom.owner-worktree",
                ):
                    self.assertIn(label, source)


if __name__ == "__main__":
    unittest.main()
