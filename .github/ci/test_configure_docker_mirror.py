"""Failure-boundary tests; all Docker/systemd calls are fake, never local mutations."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import configure_docker_mirror as mirror

CI = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux"}


class ConfigureMirrorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.config = Path(self.directory.name) / "daemon.json"
        self.original = b'{"log-driver":"local","registry-mirrors":["https://existing.example"]}\n'
        self.config.write_bytes(self.original)
        self.commands = []
        self.containers = ""
        self.failure = None
        self.active = [mirror.MIRROR + "/"]
        self.enterContext(patch.dict(os.environ, CI, clear=True))
        self.enterContext(patch.object(mirror.platform, "system", return_value="Linux"))
        self.enterContext(patch.object(mirror.os, "geteuid", return_value=0))
        self.enterContext(patch.object(mirror.time, "sleep"))
        self.enterContext(patch.object(mirror, "run", side_effect=self.fake_run))

    def fake_run(self, argv):
        self.commands.append(argv)
        if argv == [*mirror.DOCKER, "ps", "--all", "--quiet"]:
            return self.containers
        if argv[0] == "dockerd":
            # The proposed file is valid and the original is still untouched.
            json.loads(Path(argv[-1]).read_text())
            self.assertEqual(self.config.read_bytes(), self.original)
            if self.failure == "validation":
                raise subprocess.CalledProcessError(1, argv)
        if argv == ["systemctl", "reload", "docker"] and self.failure == "reload":
            self.failure = None
            raise subprocess.CalledProcessError(1, argv)
        if "info" in argv:
            return json.dumps(self.active)
        return ""

    def test_success_preserves_settings_and_existing_mirrors(self):
        mirror.configure(self.config)
        settings = json.loads(self.config.read_bytes())
        self.assertEqual(settings["log-driver"], "local")
        self.assertEqual(settings["registry-mirrors"], [mirror.MIRROR, "https://existing.example"])
        self.assertFalse(any("restart" in command for command in self.commands))

    def test_non_ci_self_hosted_other_os_and_unprivileged_refuse_before_commands(self):
        for values in ({"GITHUB_ACTIONS": "false"}, {"RUNNER_ENVIRONMENT": "self-hosted"}, {"RUNNER_OS": "macOS"}):
            with self.subTest(values=values), patch.dict(os.environ, values):
                with self.assertRaises(RuntimeError):
                    mirror.configure(self.config)
        with patch.object(mirror.os, "geteuid", return_value=1000):
            with self.assertRaises(RuntimeError):
                mirror.configure(self.config)
        with patch.object(mirror.platform, "system", return_value="Darwin"):
            with self.assertRaises(RuntimeError):
                mirror.configure(self.config)
        self.assertEqual(self.commands, [])
        self.assertEqual(self.config.read_bytes(), self.original)

    def test_existing_container_refuses_before_file_change_or_reload(self):
        self.containers = "service-container-id\n"
        with self.assertRaises(RuntimeError):
            mirror.configure(self.config)
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertEqual(len(self.commands), 1)

    def test_symlink_refuses_without_touching_target(self):
        target = self.config.with_name("original.json")
        self.config.rename(target)
        self.config.symlink_to(target)
        with self.assertRaises(RuntimeError):
            mirror.configure(self.config)
        self.assertEqual(target.read_bytes(), self.original)

    def test_bad_config_refuses_without_repairing_or_reloading(self):
        for contents in (b'{', b'[]', b'{"registry-mirrors":"https://bad.example"}', b'{"registry-mirrors":[1]}'):
            with self.subTest(contents=contents):
                self.config.write_bytes(contents)
                self.commands.clear()
                with self.assertRaises((RuntimeError, ValueError)):
                    mirror.configure(self.config)
                self.assertEqual(self.config.read_bytes(), contents)
                self.assertEqual(len(self.commands), 1)

    def test_daemon_validation_failure_keeps_original_and_cleans_candidate(self):
        self.failure = "validation"
        with self.assertRaises(subprocess.CalledProcessError):
            mirror.configure(self.config)
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertEqual(list(self.config.parent.iterdir()), [self.config])
        self.assertFalse(any(command[0] == "systemctl" for command in self.commands))

    def test_failed_reload_or_activation_restores_original_and_fails(self):
        for failure in ("reload", "activation"):
            with self.subTest(failure=failure):
                self.failure = failure
                self.active = []
                with self.assertRaises((RuntimeError, subprocess.CalledProcessError)):
                    mirror.configure(self.config)
                self.assertEqual(self.config.read_bytes(), self.original)
                self.assertEqual(self.commands[-1], ["systemctl", "reload", "docker"])

    def test_absent_config_restored_to_absent_after_failed_activation(self):
        self.config.unlink()
        self.original = None
        self.active = []
        # This fixture intentionally starts without an original configuration.
        with patch.object(mirror, "run", side_effect=lambda argv: "[]" if "info" in argv else ""):
            with self.assertRaises(RuntimeError):
                mirror.configure(self.config)
        self.assertFalse(self.config.exists())


if __name__ == "__main__":
    unittest.main()
