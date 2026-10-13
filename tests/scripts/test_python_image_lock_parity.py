"""Causal lock comparison tests; no Docker or dependency installation."""

import importlib.util
import json
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[2] / "scripts/check-python-image-lock-parity.py"
SPEC = importlib.util.spec_from_file_location("image_lock_parity", PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ImageLockParityTests(unittest.TestCase):
    def test_probe_timeout_removes_only_owned_immutable_id(self):
        calls = []
        labels = {
            "com.axiom.fixture": "python-image-lock-parity",
            "com.axiom.owner-worktree": str(MODULE.ROOT),
        }

        def command(args):
            calls.append(args)
            if args[:3] == ["docker", "image", "inspect"]:
                return json.dumps(
                    [{"Id": "sha256:owned-image", "Config": {"Labels": labels}}]
                )
            if args[0] == "uv":
                return ".\n"
            if args[:2] == ["docker", "run"]:
                raise subprocess.TimeoutExpired(args, 120)
            if args[:2] == ["docker", "inspect"]:
                return json.dumps(
                    [{"Id": "owned-container-id", "Config": {"Labels": labels}}]
                )
            if args == ["docker", "rm", "-f", "owned-container-id"]:
                return "owned-container-id"
            self.fail("Unexpected command")

        with (
            patch.object(MODULE, "command", side_effect=command),
            patch(
                "sys.argv",
                [
                    str(PATH),
                    "--service",
                    "temporal-workers",
                    "--image",
                    "axiom-python-lock-temporal-workers-123456abcdef",
                ],
            ),
            self.assertRaises(subprocess.TimeoutExpired),
        ):
            MODULE.main()
        self.assertEqual(calls[-1], ["docker", "rm", "-f", "owned-container-id"])

    def test_foreign_probe_not_removed(self):
        with (
            patch.object(
                MODULE,
                "command",
                return_value=json.dumps([{"Id": "foreign", "Config": {"Labels": {}}}]),
            ) as command,
            self.assertRaisesRegex(ValueError, "Foreign probe"),
        ):
            MODULE.remove_probe("axiom-python-lock-probe-123456abcdef")
        self.assertEqual(command.call_count, 1)

    def test_already_removed_probe_and_unavailable_daemon_distinguished(self):
        name = "axiom-python-lock-probe-123456abcdef"
        missing = subprocess.CalledProcessError(
            1, ["docker"], stderr="error: no such object: " + name
        )
        with patch.object(MODULE, "command", side_effect=missing):
            MODULE.remove_probe(name)
        failure = subprocess.CalledProcessError(
            1, ["docker"], stderr="daemon unavailable"
        )
        with (
            patch.object(MODULE, "command", side_effect=failure),
            self.assertRaisesRegex(ValueError, "cleanup unconfirmed"),
        ):
            MODULE.remove_probe(name)

    def fixture(self):
        return {
            "markers": {"sys_platform": "linux", "python_version": "3.14"},
            "distributions": [
                {"name": "sample-service", "version": "0.1.0", "editable": False},
                {"name": "httpx", "version": "0.28.1", "editable": False},
            ],
            "prefix": "/app/services/agent-runtime/.venv",
            "executable": "/app/services/agent-runtime/.venv/bin/python",
            "uid": 1000,
            "offline_license_imported": True,
        }

    def verify(self, observed, export=".\nhttpx==0.28.1\n"):
        return MODULE.verify(
            export,
            {"name": "sample-service", "version": "0.1.0"},
            observed,
            "agent-runtime",
        )

    def test_exact_noneditable_production_environment(self):
        self.assertEqual(self.verify(self.fixture())["mismatches"], 0)

    def test_target_markers_exclude_other_platform(self):
        self.verify(
            self.fixture(),
            '.\nhttpx==0.28.1\nwindows-only==1.0 ; sys_platform == "win32"\n',
        )

    def test_active_marker_dependency_must_exist(self):
        with self.assertRaisesRegex(ValueError, "Installed/lock mismatch"):
            self.verify(
                self.fixture(),
                '.\nhttpx==0.28.1\nlinux-only==1.0 ; sys_platform == "linux"\n',
            )

    def test_wrong_missing_extra_versions_refused(self):
        for mutation in ("wrong", "missing", "extra"):
            with self.subTest(mutation=mutation):
                f = self.fixture()
                if mutation == "wrong":
                    f["distributions"][1]["version"] = "0.29.0"
                elif mutation == "missing":
                    f["distributions"].pop()
                else:
                    f["distributions"].append(
                        {"name": "pytest", "version": "9.0.0", "editable": False}
                    )
                with self.assertRaisesRegex(ValueError, "Installed/lock mismatch"):
                    self.verify(f)

    def test_editable_and_duplicate_refused(self):
        for mutation in ("editable", "duplicate"):
            f = self.fixture()
            if mutation == "editable":
                f["distributions"][0]["editable"] = True
            else:
                f["distributions"].append(f["distributions"][0])
            with self.assertRaisesRegex(ValueError, "Duplicate or editable"):
                self.verify(f)

    def test_system_python_root_or_missing_offline_import_refused(self):
        for key, value in [
            ("prefix", "/usr/local"),
            ("executable", "/usr/local/bin/python"),
            ("uid", 0),
            ("offline_license_imported", False),
        ]:
            f = self.fixture()
            f[key] = value
            with self.assertRaisesRegex(ValueError, "Runtime virtual"):
                self.verify(f)

    def test_unpinned_export_refused(self):
        with self.assertRaisesRegex(ValueError, "exact versions"):
            self.verify(self.fixture(), "httpx>=0.28.1")


if __name__ == "__main__":
    unittest.main()
