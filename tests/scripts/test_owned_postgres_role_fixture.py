"""Protect native role tests from foreign fixtures and misleading refusal results."""

import importlib.util
import subprocess
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "owned_role_fixture", ROOT / "tests/database/lib/owned-postgres-role-fixture.py"
)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class RoleFixtureTests(unittest.TestCase):
    def owned(self):
        target = fixture.Fixture.__new__(fixture.Fixture)
        target.guard = Mock()
        target.original = {"id": "a" * 64, "owner": "test-owner"}
        target.guard.inspect.return_value = target.original
        target.cid = "a" * 64
        target.image = "sha256:" + "b" * 64
        target.docker = "/test/docker"
        target.databases = []
        return target

    def test_changed_fixture_refused_before_subprocess(self):
        target = self.owned()
        target.guard.inspect.return_value = {"id": "c" * 64}
        with (
            patch.object(fixture.subprocess, "run") as run,
            self.assertRaisesRegex(ValueError, "Owned fixture changed"),
        ):
            target.command(["psql"], "select 1;")
        run.assert_not_called()

    def test_refusal_requires_failure_state_and_exact_reason(self):
        target = self.owned()
        for result in (
            subprocess.CompletedProcess(
                [], 0, "", "42501 owned target controller role identity refused"
            ),
            subprocess.CompletedProcess([], 1, "", "42501 unrelated privilege refusal"),
            subprocess.CompletedProcess(
                [], 1, "", "owned target controller role identity refused"
            ),
        ):
            with (
                self.subTest(result=result),
                patch.object(target, "command", return_value=result),
                self.assertRaisesRegex(ValueError, "Unsafe role was not refused"),
            ):
                target.sql("test", "test", refused=True)

    def test_valid_refusal_is_accepted(self):
        target = self.owned()
        result = subprocess.CompletedProcess(
            [], 1, "", "42501 owned target controller role identity refused"
        )
        with patch.object(target, "command", return_value=result):
            self.assertEqual(target.sql("test", "test", refused=True), "")

    def test_database_removed_when_source_guard_fails(self):
        target = self.owned()
        with (
            patch.object(
                target, "command", return_value=subprocess.CompletedProcess([], 0)
            ) as command,
            patch.object(target, "sql", side_effect=ValueError("guard failure")),
            self.assertRaisesRegex(ValueError, "guard failure"),
        ):
            target.verify()
        self.assertEqual(len(target.databases), 1)
        self.assertEqual(
            command.call_args_list[-1].args[0],
            ["dropdb", "-U", "supabase_admin", target.databases[0]],
        )

    def test_command_has_stdin_and_bounded_timeout(self):
        target = self.owned()
        with patch.object(fixture.subprocess, "run") as run:
            target.command(["psql"], "source guard")
        self.assertEqual(run.call_args.kwargs["input"], "source guard")
        self.assertEqual(run.call_args.kwargs["timeout"], 20)
        self.assertEqual(
            run.call_args.args[0], ["/test/docker", "exec", "-i", target.cid, "psql"]
        )
