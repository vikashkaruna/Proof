"""Offline issuer guards; fake Docker only, no database or resource access."""

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Guard test unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GUARD = load("issuer_guard", HERE / "preprovision-local-custody-issuer.py")
BASE = load("issuer_fake_tests", HERE / "test_preprovision_local_custody_verifier.py")
BASE.HELPER = HERE / "preprovision-local-custody-issuer.py"
BASE.MODULE = GUARD
BASE.FAKE = BASE.FAKE.replace("axiom-local-custody-fixture-ready", GUARD.READY)


class IssuerGuards(BASE.PreprovisionTests):
    def test_exact_pinned_role_block_and_trusted_single_transaction(self):
        self.assertEqual(
            hashlib.sha256(GUARD.ROLE_DO.encode()).hexdigest(), GUARD.ROLE_DO_SHA256
        )
        result, calls = self.run_fake()
        self.assertEqual(result.returncode, 0, result.stderr)
        sql_calls = [c for c in calls if c["args"][0] == "exec"]
        self.assertEqual(len(sql_calls), 1)
        sql = sql_calls[0]["sql"].lower()
        self.assertIn("session_user <> 'supabase_admin'", sql)
        self.assertIn("rolname=current_user and rolsuper", sql)
        self.assertIn("create role axiom_local_custody_issuer nologin noinherit", sql)
        self.assertNotIn("grant ", sql)
        self.assertIn("r.oid=m.member", sql)
        self.assertIn("r.oid=m.roleid", sql)
        self.assertEqual(sql_calls[0]["args"][2], BASE.CID)
        self.assertEqual(
            sum(c["args"][:2] == ["container", "inspect"] for c in calls), 2
        )

    def test_all_hooks_and_delegated_entrypoints_reach_guard(self):
        for name in (
            "scripts/test-database.sh",
            "tests/database/prativedan-assessment-codec-fixture.sh",
            "tests/database/prativedan-assessment-runtime-fixture.sh",
            "tests/database/migration-dsn.sh",
            "tests/deployment/selfhosted-supabase.sh",
        ):
            source = (BASE.ROOT / name).read_text()
            self.assertEqual(source.count("preprovision-local-custody-issuer.py"), 1)
            self.assertLess(
                source.index("preprovision-local-custody-verifier.py"),
                source.index("preprovision-local-custody-issuer.py"),
            )
            self.assertLess(
                source.index("preprovision-local-custody-issuer.py"),
                source.index("python3 scripts/migrate-database.py"),
            )
        for name, child in (
            (
                "scripts/test-prativedan-assessment-interoperability.sh",
                "prativedan-assessment-codec-fixture.sh",
            ),
            (
                "scripts/test-prativedan-assessment-controller-interoperability.sh",
                "prativedan-assessment-runtime-fixture.sh",
            ),
        ):
            self.assertIn(child, (BASE.ROOT / name).read_text())
        source = (BASE.ROOT / "scripts/start-parity-supabase.sh").read_text()
        self.assertLess(
            source.index("preprovision-local-custody-issuer.py"),
            source.index("python3 scripts/migrate-database.py"),
        )
        self.assertLess(
            source.index("preprovision-local-custody-issuer.py"),
            source.index("supabase status"),
        )


class ParityIdentity(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.owner = Path(temp.name).resolve()
        self.owner.chmod(0o700)
        self.project = "axiom-w0-parity"
        self.state = self.owner / ".axiom-runtime/parity"
        self.state.mkdir(parents=True, mode=0o700)
        self.state.parent.chmod(0o700)
        (self.state / "supabase").mkdir(mode=0o700)
        self.config = self.state / "supabase/config.toml"
        self.write_config()

    def write_config(self):
        self.config.write_text(
            f'project_id="{self.project}"\n[db]\nport=56322\n[api]\nport=56321\n'
        )
        self.config.chmod(0o600)

    def identity(self, api=False):
        return {
            "id": ("c" if api else "a") * 64,
            "name": f"/supabase_{'kong' if api else 'db'}_{self.project}",
            "running": True,
            "image": BASE.IMAGE,
            "project": self.project,
            "workdir": str(self.state),
            "ports": {
                "8000/tcp" if api else "5432/tcp": [
                    {"HostPort": "56321" if api else "56322", "HostIp": "127.0.0.1"}
                ]
            },
        }

    def inspect(self, value, *, api=False, target=None):
        with patch.object(GUARD, "command", return_value=json.dumps(value)) as command:
            result = GUARD.parity_inspect(
                "fake",
                target or value["id"],
                BASE.IMAGE,
                self.owner,
                self.state,
                self.project,
                "563",
                api=api,
            )
        self.assertNotIn("Env", command.call_args.args[1][3])
        return result

    def test_known_families_exact_nonce_and_both_component_identity(self):
        for registered in (False, True):
            if registered:
                self.project = "axiom-report-0123456789ab"
                self.state = (
                    self.owner / ".axiom-runtime/registered-report-0123456789ab/parity"
                )
                self.state.mkdir(parents=True, mode=0o700)
                self.state.parent.chmod(0o700)
                (self.state / "supabase").mkdir(mode=0o700)
                self.config = self.state / "supabase/config.toml"
                self.write_config()
            for api in (False, True):
                value = self.identity(api)
                self.assertEqual(self.inspect(value, api=api), value)
                self.assertEqual(
                    self.inspect(value, api=api, target=value["name"][1:]), value
                )

    def test_public_identity_changes_and_foreign_project_zero_sql(self):
        for api in (False, True):
            for key, bad in (
                ("id", "abc"),
                ("name", "/supabase_db_retained"),
                ("running", False),
                ("image", "sha256:" + "d" * 64),
                ("project", "carry"),
                ("workdir", "/other"),
                ("ports", {}),
            ):
                with self.subTest(api=api, key=key):
                    value = self.identity(api)
                    value[key] = bad
                    with self.assertRaises(GUARD.Refused):
                        self.inspect(value, api=api, target=("c" if api else "a") * 64)
        for project in (
            "axiom-owner-test",
            "axiom-assessment-request-acceptance",
            "axiom-report-ffffffffffff",
        ):
            self.project = project
            with (
                patch.object(GUARD, "command") as command,
                self.assertRaises(GUARD.Refused),
            ):
                GUARD.parity_inspect(
                    "fake", BASE.CID, BASE.IMAGE, self.owner, self.state, project, "563"
                )
            command.assert_not_called()

    def test_config_permissions_symlink_and_port_mismatch_refused_before_docker(self):
        for mode in ("public", "wrong_port", "bad_shape", "symlink"):
            self.write_config()
            if mode == "public":
                self.config.chmod(0o644)
            if mode == "wrong_port":
                self.config.write_text(
                    self.config.read_text().replace("56322", "56325")
                )
            if mode == "bad_shape":
                self.config.write_text(
                    f'project_id="{self.project}"\ndb="hostile-shape"\n'
                )
            if mode == "symlink":
                other = self.state / "other.toml"
                self.config.rename(other)
                self.config.symlink_to(other)
            with (
                patch.object(GUARD, "command") as command,
                self.assertRaises((GUARD.Refused, OSError)),
            ):
                GUARD.parity_inspect(
                    "fake",
                    BASE.CID,
                    BASE.IMAGE,
                    self.owner,
                    self.state,
                    self.project,
                    "563",
                )
            command.assert_not_called()
            if self.config.is_symlink():
                self.config.unlink()

    def test_both_components_reinspected_before_only_sql_and_drift_refuses(self):
        # The call-site preprovision function, not merely the pure identity parser.
        owner = GUARD.Path(__file__).resolve().parents[3]
        state = owner / ".axiom-runtime/parity"
        db, api = self.identity(), self.identity(True)
        for drift in (False, True):
            with (
                patch.object(GUARD.Path, "cwd", return_value=owner),
                patch.object(GUARD.shutil, "which", return_value="fake"),
                patch.object(
                    GUARD,
                    "parity_inspect",
                    side_effect=[
                        db,
                        api,
                        db,
                        {**api, "id": "d" * 64} if drift else api,
                    ],
                ) as inspect,
                patch.object(
                    GUARD,
                    "command",
                    side_effect=[
                        json.dumps(BASE.IMAGE),
                        json.dumps(BASE.IMAGE),
                        GUARD.READY,
                    ],
                ) as command,
            ):
                if drift:
                    with self.assertRaises(GUARD.Refused):
                        GUARD.preprovision(
                            "supabase_db_axiom-w0-parity",
                            BASE.IMAGE,
                            state=state,
                            project=self.project,
                            prefix="563",
                            api_image_ref=BASE.IMAGE,
                        )
                    self.assertEqual(command.call_count, 2)
                else:
                    GUARD.preprovision(
                        "supabase_db_axiom-w0-parity",
                        BASE.IMAGE,
                        state=state,
                        project=self.project,
                        prefix="563",
                        api_image_ref=BASE.IMAGE,
                    )
                    self.assertEqual(command.call_count, 3)
                    self.assertEqual(command.call_args.args[1][0], "exec")
                    self.assertEqual(command.call_args.args[1][2], db["id"])
                self.assertEqual(inspect.call_count, 4)
                self.assertEqual(inspect.call_args_list[2].args[1], db["id"])
                self.assertEqual(inspect.call_args_list[3].args[1], api["id"])


if __name__ == "__main__":
    unittest.main()
