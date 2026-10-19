"""Launcher configuration only; no Docker writes or retained credentials."""

import importlib.util
import json
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "owned_execution_launcher", ROOT / "scripts/local-owned-execution-controller.py"
)
assert SPEC and SPEC.loader
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(
            launcher, "NAME", "axiom-proof-local-owned-execution-controller"
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_unreviewed_resource_name_refused_before_docker(self):
        with (
            patch.object(launcher, "NAME", "foreign-controller"),
            patch.object(launcher, "run") as command,
        ):
            with self.assertRaisesRegex(ValueError, "resource name"):
                launcher.runtime_args("sha256:" + "b" * 64, 0, True)
            command.assert_not_called()

    def test_configuration_has_no_credentials_and_pins_private_broker_path(self):
        config = launcher.configuration(
            "sha256:" + "a" * 64, "axiom-workload-api-local", 4000
        )
        self.assertEqual(
            config["brokerUrl"], "http://127.0.0.1:4000/internal/owned-execution/run"
        )
        self.assertEqual(config["socket"]["socketGroup"], 20113)
        self.assertNotIn("backend", str(config))
        self.assertNotIn("password", str(config))

    def test_worker_socket_volume_and_port_are_not_caller_urls(self):
        for volume in ["/var/run/docker.sock", "axiom-spire-data", "../escape"]:
            with self.assertRaisesRegex(ValueError, "deployment refused"):
                launcher.configuration("sha256:" + "a" * 64, volume, 4000)
        with self.assertRaisesRegex(ValueError, "deployment refused"):
            launcher.configuration("sha256:" + "a" * 64, "axiom-workload-api-local", 0)

    def test_exact_bff_identity_refuses_same_image_replacement_before_launch(self):
        expected = "b" * 64
        inspected = [
            {
                "Id": "a" * 64,
                "Image": "sha256:" + "c" * 64,
                "State": {"Running": True},
                "Config": {"Labels": {"com.docker.compose.service": "bff"}},
            }
        ]
        with patch.object(
            launcher,
            "run",
            return_value=subprocess.CompletedProcess([], 0, json.dumps(inspected), ""),
        ) as command:
            with self.assertRaisesRegex(ValueError, "namespace changed"):
                launcher.bff_identity(expected, "sha256:" + "c" * 64)
            inspected[0]["Id"] = expected
            command.return_value = subprocess.CompletedProcess(
                [], 0, json.dumps(inspected), ""
            )
            self.assertEqual(
                launcher.bff_identity(expected, "sha256:" + "c" * 64), expected
            )

    def test_launch_has_dedicated_identity_and_no_backend_environment(self):
        with (
            patch.object(launcher, "image_id", lambda value: value),
            patch.object(launcher, "bff_identity", return_value="a" * 64),
        ):
            args = launcher.runtime_args("sha256:" + "b" * 64, 0, True)
        self.assertIn("20106:20106", args)
        self.assertIn("20113", args)
        self.assertIn("container:" + "a" * 64, args)
        self.assertIn("--read-only", args)
        self.assertIn("no-new-privileges:true", args)
        self.assertNotIn("-e", args)
        self.assertEqual(args[-1], "/etc/axiom/owned-execution-controller/config.json")

    def test_check_runs_readonly_prerequisite_check_in_ephemeral_container(self):
        with (
            patch.object(launcher, "image_id", lambda value: value),
            patch.object(launcher, "bff_identity", return_value="a" * 64),
        ):
            args = launcher.runtime_args("sha256:" + "b" * 64, 0, False)
        self.assertIn("--rm", args)
        self.assertNotIn("--restart", args)
        self.assertEqual(args[-1], "--check")


if __name__ == "__main__":
    unittest.main()
