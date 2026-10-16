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


class Review141PhaseTests(unittest.TestCase):
    def proof(self):
        return {
            "phase": "tenant",
            "holder": 101,
            "contender": 102,
            "blocked_by_holder": True,
            "holder_phase": True,
            "contender_phase": True,
            "contender_head": False,
            "locks": [],
        }

    def test_existing_default_contract_is_unchanged(self):
        self.assertIsNone(BARRIER.review141_probe_query("", 101, 102))

    def test_allowlisted_queries_bound_tenant_and_require_no_head(self):
        tenant = "99134100-0000-4000-8000-000000000031"
        for phase in ("tenant", "engagement", "head"):
            query = BARRIER.review141_probe_query(
                f"review141:{phase}:{tenant}", 101, 102
            )
            self.assertIn("pg_blocking_pids(102)", query)
            self.assertIn("contender_head", query)
            self.assertNotIn("query,", query)
        self.assertIn(
            "classid=139",
            BARRIER.review141_probe_query(f"review141:tenant:{tenant}", 101, 102),
        )
        self.assertIn(
            "transactionid",
            BARRIER.review141_probe_query(f"review141:engagement:{tenant}", 101, 102),
        )

    def test_head_phase_requires_an_ungranted_head_wait_not_a_held_head(self):
        tenant = "99134100-0000-4000-8000-000000000031"
        query = BARRIER.review141_probe_query(f"review141:head:{tenant}", 101, 102)
        self.assertIn("pid=102 and not granted", query)
        self.assertIn("public-control-review:", query)
        proof = self.proof()
        proof["phase"] = "head"
        self.assertEqual(BARRIER.validate_review141_phase(proof)["phase"], "head")
        proof["contender_head"] = True
        with self.assertRaises(BARRIER.BarrierFailure):
            BARRIER.validate_review141_phase(proof)

    def test_refuses_arbitrary_contract_sql_and_invalid_pids(self):
        for value in (
            "review141:anything:id",
            "review141:tenant:drop database postgres",
        ):
            with self.assertRaises(BARRIER.BarrierFailure):
                BARRIER.review141_probe_query(value, 101, 102)
        with self.assertRaises(BARRIER.BarrierFailure):
            BARRIER.review141_probe_query(
                "review141:tenant:99134100-0000-4000-8000-000000000031", True, 102
            )

    def test_requires_actual_holder_wait_and_no_contender_head(self):
        self.assertEqual(BARRIER.validate_review141_phase(self.proof()), self.proof())
        for key in (
            "blocked_by_holder",
            "holder_phase",
            "contender_phase",
            "contender_head",
        ):
            changed = self.proof()
            changed[key] = key == "contender_head"
            with self.assertRaises(BARRIER.BarrierFailure):
                BARRIER.validate_review141_phase(changed)

    def test_never_retains_unexpected_or_raw_query_fields(self):
        changed = self.proof()
        changed["query"] = "private input must not be written"
        with self.assertRaises(BARRIER.BarrierFailure):
            BARRIER.validate_review141_phase(changed)
        changed = self.proof()
        changed["locks"] = [{"query": "private"}]
        with self.assertRaises(BARRIER.BarrierFailure):
            BARRIER.validate_review141_phase(changed)


if __name__ == "__main__":
    unittest.main()
