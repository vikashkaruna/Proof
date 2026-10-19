"""Launcher configuration only; no Docker writes or retained credentials."""

import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "discovery_launcher", ROOT / "scripts/local-discovery-controller.py"
)
assert SPEC and SPEC.loader
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def test_configuration_has_no_credentials_and_pins_private_broker_path(self):
        config = launcher.configuration(
            "sha256:" + "a" * 64, "axiom-workload-api-local", 4000
        )
        self.assertEqual(
            config["brokerUrl"], "http://127.0.0.1:4000/internal/discovery/retained"
        )
        self.assertEqual(config["socket"]["socketGroup"], 20112)
        self.assertNotIn("backend", str(config))
        self.assertNotIn("password", str(config))

    def test_worker_socket_volume_and_port_are_not_caller_urls(self):
        for volume in ["/var/run/docker.sock", "axiom-spire-data", "../escape"]:
            with self.assertRaisesRegex(ValueError, "deployment refused"):
                launcher.configuration("sha256:" + "a" * 64, volume, 4000)
        with self.assertRaisesRegex(ValueError, "deployment refused"):
            launcher.configuration("sha256:" + "a" * 64, "axiom-workload-api-local", 0)

    def test_launch_has_dedicated_identity_and_no_backend_environment(self):
        with patch.object(launcher, "image_id", lambda value: value):
            args = launcher.runtime_args("sha256:" + "b" * 64, 0, True)
        self.assertIn("20105:20105", args)
        self.assertIn("20112", args)
        self.assertIn("container:axiom-bff", args)
        self.assertIn("--read-only", args)
        self.assertIn("no-new-privileges:true", args)
        self.assertNotIn("-e", args)
        self.assertEqual(args[-1], "/etc/axiom/discovery-controller/config.json")

    def test_check_runs_readonly_prerequisite_check_in_ephemeral_container(self):
        with patch.object(launcher, "image_id", lambda value: value):
            args = launcher.runtime_args("sha256:" + "b" * 64, 0, False)
        self.assertIn("--rm", args)
        self.assertNotIn("--restart", args)
        self.assertEqual(args[-1], "--check")


if __name__ == "__main__":
    unittest.main()
