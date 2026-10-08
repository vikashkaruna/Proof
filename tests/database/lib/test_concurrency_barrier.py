"""Exercise failure deadlines against owned fake Docker processes, without Docker."""

import importlib.util
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "barrier", Path(__file__).with_name("concurrency-barrier.py")
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Concurrency helper could not be loaded")
BARRIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BARRIER)


class FailureDeadlineTests(unittest.TestCase):
    def run_fake(self, body: str) -> tuple[int, float, list[int]]:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            executable = folder / "docker"
            executable.write_text(f"#!{sys.executable}\n" + body)
            executable.chmod(0o700)
            pid_file = folder / "clients"
            argv = [
                "barrier",
                "owned-disposable",
                "postgres",
                "select 1",
                "select 2",
                str(folder / "first"),
                str(folder / "second"),
                str(folder / "status"),
                "blocked",
                "success",
                "",
            ]
            started = time.monotonic()
            with (
                patch.dict(
                    os.environ,
                    {
                        "PATH": str(folder) + os.pathsep + os.environ["PATH"],
                        "RACE_FAKE_PIDS": str(pid_file),
                    },
                ),
                patch.object(sys, "argv", argv),
                patch.object(BARRIER, "PROBE_TIMEOUT", 0.5),
                patch.object(BARRIER, "PHASE_TIMEOUT", 0.8),
            ):
                result = BARRIER.main()
            elapsed = time.monotonic() - started
            pids = [int(value) for value in pid_file.read_text().splitlines()]
            for pid in pids:
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
            return result, elapsed, pids

    def test_startup_failure_is_reported_and_owned_clients_are_reaped(self):
        result, elapsed, pids = self.run_fake(
            "import os\nwith open(os.environ['RACE_FAKE_PIDS'],'a') as f: f.write(str(os.getpid())+'\\n')\nraise SystemExit(17)\n"
        )
        self.assertEqual(result, 1)
        self.assertLess(elapsed, 5)
        self.assertGreaterEqual(len(pids), 2)

    def test_hung_docker_monitors_and_holder_are_bounded_and_reaped(self):
        result, elapsed, pids = self.run_fake(
            "import os,time\nwith open(os.environ['RACE_FAKE_PIDS'],'a') as f: f.write(str(os.getpid())+'\\n')\ntime.sleep(60)\n"
        )
        self.assertEqual(result, 1)
        self.assertLess(elapsed, 5)
        self.assertGreaterEqual(len(pids), 2)


class DatabaseArgumentTests(unittest.TestCase):
    def test_refuses_unsafe_optional_database_before_any_process(self):
        argv = [
            "barrier",
            "owned-disposable",
            "postgres",
            "select 1",
            "select 2",
            "first",
            "second",
            "status",
            "blocked",
            "success",
            "",
            "axiom_policy_test;drop database postgres",
        ]
        with (
            patch.object(sys, "argv", argv),
            patch.object(subprocess, "Popen") as start,
        ):
            with self.assertRaises(BARRIER.BarrierFailure):
                BARRIER.main()
            start.assert_not_called()


if __name__ == "__main__":
    unittest.main()
