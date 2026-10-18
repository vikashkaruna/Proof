"""Key helper cleanup cannot delete foreign names; subprocesses are mocked."""

import importlib.util
import json
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "key_service_ownership",
    Path(__file__).resolve().parents[2] / "scripts/local-key-service.py",
)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class OwnershipTests(unittest.TestCase):
    def setUp(self):
        self.name = "axiom-key-service-kosha-stage"
        self.purpose = "local-key-service-stage"
        self.value = {
            "id": "a" * 64,
            "name": "/" + self.name,
            "running": True,
            "labels": {"axiom.purpose": self.purpose},
        }

    def response(self, value):
        return subprocess.CompletedProcess([], 0, value, "")

    def test_absent_name_never_removed(self):
        with patch.object(m, "run", return_value=self.response("foreign\n")) as run:
            m.remove_owned(self.name, self.purpose)
            self.assertEqual(run.call_count, 1)

    def test_unlabelled_or_wrong_name_never_stopped(self):
        for value in [dict(self.value, labels={}), dict(self.value, name="/foreign")]:
            with (
                patch.object(
                    m,
                    "run",
                    side_effect=[
                        self.response(self.name + "\n"),
                        self.response(json.dumps(value)),
                    ],
                ) as run,
                self.assertRaises(ValueError),
            ):
                m.remove_owned(self.name, self.purpose)
            self.assertEqual(run.call_count, 2)

    def test_owned_helper_stops_gracefully_and_removes_full_id(self):
        stopped = dict(self.value, running=False)
        with patch.object(
            m,
            "run",
            side_effect=[
                self.response(self.name + "\n"),
                self.response(json.dumps(self.value)),
                self.response(""),
                self.response(json.dumps(stopped)),
                self.response(""),
            ],
        ) as run:
            m.remove_owned(self.name, self.purpose)
            self.assertEqual(
                run.call_args_list[2].args[0],
                ["docker", "stop", "--time", "95", "a" * 64],
            )
            self.assertEqual(run.call_args_list[-1].args[0], ["docker", "rm", "a" * 64])

    def test_unconfirmed_stop_preserves_container(self):
        with (
            patch.object(
                m,
                "run",
                side_effect=[
                    self.response(self.name + "\n"),
                    self.response(json.dumps(self.value)),
                    self.response(""),
                    self.response(json.dumps(self.value)),
                ],
            ) as run,
            self.assertRaises(ValueError),
        ):
            m.remove_owned(self.name, self.purpose)
        self.assertFalse(any(call.args[0][1] == "rm" for call in run.call_args_list))

    def test_helper_creation_has_separate_owner_label(self):
        source = Path(m.__file__).read_text()
        self.assertIn('"axiom.purpose=local-key-service-stage"', source)
        self.assertNotIn('"rm", "-f"', source)


if __name__ == "__main__":
    unittest.main()
