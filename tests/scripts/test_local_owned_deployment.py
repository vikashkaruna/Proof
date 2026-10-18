"""Protected filesystem/private-pipe preflight only; no live Docker or approval."""

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "owned_deployment", ROOT / "scripts/local-owned-deployment.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class OwnedDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name).resolve()
        self.directory.chmod(0o700)
        self.addCleanup(self.temporary.cleanup)

    def private(self, name, value):
        path = self.directory / name
        path.write_text(json.dumps(value))
        path.chmod(0o600)
        return path

    def config(self):
        path = self.private(
            "transport.json",
            {
                "schemaVersion": 1,
                "purpose": "owned_synthetic_installer_transport",
                "existingOperatorAccessToken": "existing-operator-transport-fixture-only",
            },
        )
        return {
            "enabled": True,
            "bffContainer": "axiom-proof-bff-1",
            "bffImage": "sha256:" + "a" * 64,
            "bffContainerId": "b" * 64,
            "hostInstallerSha256": MODULE.host_source_sha256(),
            "internalBffPort": 4000,
            "transportFile": str(path),
        }

    def inspection(self, config):
        return [
            {
                "Id": "b" * 64,
                "Image": config["bffImage"],
                "State": {"Running": True},
                "Config": {"Labels": {"com.docker.compose.service": "bff"}},
            }
        ]

    def test_actual_private_file_and_source_integrity(self):
        path = self.private("private.json", {"example": True})
        self.assertEqual(
            MODULE.parse_json(MODULE.protected_bytes(path)), {"example": True}
        )
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            MODULE.protected_bytes(path)
        path.chmod(0o600)
        link = self.directory / "link"
        link.symlink_to(path)
        with self.assertRaises(ValueError):
            MODULE.protected_bytes(link)
        self.directory.chmod(0o777)
        with self.assertRaises(ValueError):
            MODULE.protected_bytes(path)
        self.directory.chmod(0o700)

    def test_duplicate_json_and_escaped_names_refused(self):
        for value in [
            b'{"schemaVersion":1,"schemaVersion":2}',
            b'{"schemaVersion":1,"schema\\u0056ersion":2}',
        ]:
            with self.assertRaises(ValueError):
                MODULE.parse_json(value)

    def test_source_bundle_covers_every_fixed_helper_and_changes_on_any_update(self):
        for name in MODULE.HOST_SOURCES:
            path = self.directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("reviewed source")
            path.chmod(0o644)
        before = MODULE.host_source_sha256(self.directory)
        path.write_text("changed source")
        self.assertNotEqual(before, MODULE.host_source_sha256(self.directory))

    def test_private_transport_uses_exact_running_container_and_stdin_only(self):
        config = self.config()

        def fake(args, **kwargs):
            if args[:2] == ["docker", "inspect"]:
                return subprocess.CompletedProcess(
                    args, 0, json.dumps(self.inspection(config)), ""
                )
            self.assertEqual(args[:4], ["docker", "exec", "-i", "b" * 64])
            self.assertNotIn("existing-operator-transport-fixture-only", str(args))
            self.assertNotIn(
                "existing-operator-transport-fixture-only", str(kwargs.get("env"))
            )
            self.assertIn(
                "existing-operator-transport-fixture-only", kwargs["private_input"]
            )
            return subprocess.CompletedProcess(args, 0, '{"data":{"task":null}}', "")

        with patch.object(MODULE, "run", side_effect=fake):
            self.assertEqual(
                MODULE.operator_request(
                    config, "/internal/owned-deployments/tasks/claim", {}
                ),
                {"data": {"task": None}},
            )

    def test_stopped_wrong_image_foreign_label_refused_before_transport(self):
        config = self.config()
        for key in ["Image", "State", "Config", "Id"]:
            info = self.inspection(config)
            info[0][key] = (
                {"Running": False}
                if key == "State"
                else {}
                if key == "Config"
                else "c" * 64
                if key == "Id"
                else "sha256:" + "f" * 64
            )
            with patch.object(
                MODULE,
                "run",
                return_value=subprocess.CompletedProcess([], 0, json.dumps(info), ""),
            ) as run:
                with self.assertRaises(ValueError):
                    MODULE.operator_request(
                        config, "/internal/owned-deployments/tasks/claim", {}
                    )
                self.assertEqual(run.call_count, 1)

    def test_off_by_default_and_no_arbitrary_endpoint(self):
        config = self.config()
        for changed in [
            {**config, "enabled": False},
            {**config, "internalBffPort": True},
        ]:
            with patch.object(MODULE, "run") as run:
                with self.assertRaises(ValueError):
                    MODULE.operator_request(
                        changed, "/internal/owned-deployments/tasks/claim", {}
                    )
                run.assert_not_called()
        with patch.object(MODULE, "run") as run:
            with self.assertRaises(ValueError):
                MODULE.operator_request(config, "https://foreign.test", {})
            run.assert_not_called()

    def test_subprocess_wrapper_carries_private_input_without_shell(self):
        with patch.object(
            MODULE.subprocess,
            "run",
            return_value=subprocess.CompletedProcess([], 0, "{}", ""),
        ) as run:
            MODULE.run(
                ["docker", "exec", "-i", "b" * 64, "node"],
                private_input="private-fixture",
            )
            self.assertEqual(run.call_args.kwargs["input"], "private-fixture")
            self.assertTrue(run.call_args.kwargs["capture_output"])
            self.assertNotIn("shell", run.call_args.kwargs)


if __name__ == "__main__":
    unittest.main()
