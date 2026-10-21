"""Namespace repair authority, idle-worker and failure guards; no Docker calls."""

import importlib.util
import json
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "namespace_renewal",
    Path(__file__).resolve().parents[2] / "scripts/local-runtime-renewal.py",
)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class NamespaceTests(unittest.TestCase):
    def setUp(self):
        self.bff = {
            "id": "a" * 64,
            "image": "sha256:" + "b" * 64,
            "name": "/axiom-bff",
            "running": True,
            "started": "now",
            "restarts": 1,
            "labels": {"ai.axiom.local.source": "c" * 40},
            "network": "bridge",
        }
        self.peer = {
            "name": "axiom-assessment-producer",
            "purpose": "local-assessment-producer",
            "kind": "producer",
            "image": "sha256:" + "d" * 64,
        }
        self.value = {
            "id": "e" * 64,
            "name": "/" + self.peer["name"],
            "image": self.peer["image"],
            "running": True,
            "network": "container:" + self.bff["id"],
            "labels": {"axiom.purpose": self.peer["purpose"]},
        }
        self.config = {
            "workspace": "/reviewed",
            "python": "/python",
            "dockerExecutable": "/docker",
            "environment": {},
            "tenants": ["kosha"],
            "runtimeBindings": {
                "bffId": self.bff["id"],
                "bffImage": self.bff["image"],
                "peers": [self.peer],
            },
        }

    def test_metadata_never_requests_environment_and_rejects_foreign_label(self):
        with patch.object(
            m, "docker_read", return_value=json.dumps(self.value)
        ) as read:
            self.assertEqual(
                m.metadata(self.config, self.peer["name"], self.peer["purpose"]),
                self.value,
            )
            self.assertNotIn("Env", read.call_args.args[1][-1])
        self.value["labels"] = {}
        with (
            patch.object(m, "docker_read", return_value=json.dumps(self.value)),
            self.assertRaises(ValueError),
        ):
            m.metadata(self.config, self.peer["name"], self.peer["purpose"])

    def test_minimal_bff_uses_node_without_external_readlink(self):
        with patch.object(m, "docker_read", return_value="net:[123]") as read:
            self.assertEqual(m.namespace(self.config, self.value), "net:[123]")
            self.assertEqual(
                read.call_args.args[1],
                [
                    "exec",
                    "--user",
                    "0",
                    self.value["id"],
                    "node",
                    "-e",
                    "console.log(require('node:fs').readlinkSync('/proc/self/ns/net'))",
                ],
            )
            self.value["running"] = False
            with self.assertRaises(ValueError):
                m.namespace(self.config, self.value)
            self.assertEqual(read.call_count, 1)

    def test_scheduler_uses_reviewed_python_reader_and_no_unknown_fallback(self):
        with patch.object(m, "docker_read", return_value="net:[88]") as read:
            self.assertEqual(
                m.namespace(self.config, self.value, "scheduler"), "net:[88]"
            )
            self.assertEqual(
                read.call_args.args[1][4:],
                ["python", "-c", "import os;print(os.readlink('/proc/self/ns/net'))"],
            )
            with self.assertRaises(ValueError):
                m.namespace(self.config, self.value, "shell")
            self.assertEqual(read.call_count, 1)

    def test_recreated_bff_requires_reinstall_without_health_exec(self):
        self.bff["id"] = "f" * 64
        with (
            patch.object(m, "metadata", return_value=self.bff),
            patch.object(m, "run") as run,
            self.assertRaises(ValueError),
        ):
            m.stable_bff(self.config)
        run.assert_not_called()

    def test_health_failure_or_restart_race_refuses(self):
        for unhealthy in (True, False):
            changed = dict(self.bff, restarts=2)
            with (
                patch.object(m, "metadata", side_effect=[self.bff, changed]),
                patch.object(m, "namespace", return_value="net:[1]"),
                patch.object(m, "run", return_value=int(unhealthy)),
                self.assertRaises(ValueError),
            ):
                m.stable_bff(self.config)

    def test_backend_health_uses_project_service_key_without_exposing_value(self):
        with (
            patch.object(m, "metadata", return_value=self.bff),
            patch.object(m, "namespace", return_value="net:[9]"),
            patch.object(m, "run", return_value=0) as run,
        ):
            m.stable_bff(self.config)
        command = run.call_args.args[0]
        self.assertEqual(command[:4], ["/docker", "exec", self.bff["id"], "node"])
        self.assertIn("process.env.SUPABASE_SERVICE_KEY", command[-1])
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", command[-1])
        self.assertNotIn("Config.Env", command[-1])

    def test_same_id_restart_with_stable_current_namespace_passes(self):
        with (
            patch.object(m, "metadata", return_value=self.bff),
            patch.object(m, "namespace", return_value="net:[9]"),
            patch.object(m, "run", return_value=0),
        ):
            self.assertEqual(m.stable_bff(self.config), (self.bff, "net:[9]"))

    def test_unknown_workers_defer_but_known_controllers_do_not(self):
        for output, expected in [
            ("axiom-assessment-producer\n", True),
            ("axiom-assessment-unlabelled-job\n", False),
        ]:
            with patch.object(m, "docker_read", return_value=output):
                self.assertEqual(m.idle_workers(self.config), expected)
        with (
            patch.object(
                m, "docker_read", side_effect=subprocess.TimeoutExpired("docker", 30)
            ),
            self.assertRaises(subprocess.TimeoutExpired),
        ):
            m.idle_workers(self.config)

    def reconciliation(
        self, *, busy=False, failure=False, wrong_image=False, fresh=False
    ):
        state = {"restarted": False, "stopped": False}

        def meta(config, name, purpose=None):
            value = dict(self.value)
            if state["stopped"]:
                value["running"] = False
            if state["restarted"]:
                value.update(id="f" * 64, running=True)
            if wrong_image:
                value["image"] = "sha256:" + "0" * 64
            return value

        def net(config, value, kind="node"):
            return "net:[9]" if state["restarted"] or fresh else "net:[1]"

        def run(command, **kwargs):
            if "stop" in command:
                state["stopped"] = True
            if "serve" in command:
                state["restarted"] = True
            return int(failure)

        with (
            patch.object(m, "stable_bff", return_value=(self.bff, "net:[9]")),
            patch.object(
                m,
                "peer_specs",
                return_value=[{k: v for k, v in self.peer.items() if k != "image"}],
            ),
            patch.object(m, "metadata", side_effect=meta),
            patch.object(m, "namespace", side_effect=net),
            patch.object(m, "idle_workers", return_value=not busy),
            patch.object(m, "run", side_effect=run) as command,
        ):
            result = m.reconcile_namespaces(self.config)
            return result, command.call_args_list

    def test_stale_actual_namespace_repaired_despite_same_networkmode(self):
        result, calls = self.reconciliation()
        self.assertTrue(result[0]["repaired"])
        commands = [call.args[0] for call in calls]
        self.assertEqual(commands[0], ["/docker", "stop", "--time", "95", "e" * 64])
        self.assertEqual(commands[1], ["/docker", "rm", "e" * 64])
        self.assertTrue(all("-f" not in command for command in commands))
        self.assertIn("stage", commands[2])
        self.assertIn(self.peer["image"], commands[2])

    def test_runtime_image_drift_refuses_repair_before_stop(self):
        for kind in ("controller", "scheduler"):
            self.peer.update(kind=kind, tenant="kosha")
            with patch.object(
                m, "validate_runtime_images", side_effect=ValueError("drift")
            ):
                result, calls = self.reconciliation()
            self.assertFalse(calls)
            self.assertTrue(result[0]["runtimeConfigurationUnconfirmed"])

    def unavailable_reconciliation(self, namespace_error=None, metadata_error=None):
        with (
            patch.object(m, "stable_bff", return_value=(self.bff, "net:[9]")),
            patch.object(m, "peer_specs", return_value=[
                {k: v for k, v in self.peer.items() if k != "image"}
            ]),
            patch.object(m, "metadata", side_effect=metadata_error,
                         return_value=self.value),
            patch.object(m, "namespace", side_effect=namespace_error),
            patch.object(m, "run") as command,
            patch.object(m, "worker_idle_state") as workers,
        ):
            result = m.reconcile_namespaces(self.config)
        command.assert_not_called()
        workers.assert_not_called()
        return result

    def test_unavailable_namespace_reports_reviewed_peer_without_private_diagnostics(self):
        for error in (
            ValueError("Runtime peer is not running"),
            subprocess.CalledProcessError(1, ["PRIVATE_TOKEN"]),
            subprocess.TimeoutExpired(["PRIVATE_TOKEN"], 30),
            OSError("PRIVATE_TOKEN"),
        ):
            with self.subTest(error=type(error).__name__):
                result = self.unavailable_reconciliation(namespace_error=error)
                self.assertEqual(result, [{
                    "component": "network", "peer": self.peer["name"],
                    "ok": False, "namespaceUnavailable": True,
                }])
                self.assertNotIn("PRIVATE_TOKEN", json.dumps(result))

    def test_missing_peer_reports_unavailable_without_inferring_identity_or_repair(self):
        result = self.unavailable_reconciliation(
            metadata_error=subprocess.CalledProcessError(1, ["PRIVATE_TOKEN"])
        )
        self.assertTrue(result[0]["peerUnavailable"])
        self.assertTrue(result[0]["namespaceUnavailable"])
        self.assertNotIn("PRIVATE_TOKEN", json.dumps(result))

    def test_unknown_namespace_defers_even_a_proven_stale_peer(self):
        controller = dict(self.peer, name="axiom-assessment-controller-kosha",
                          kind="controller", tenant="kosha")
        scheduler = dict(controller, name=controller["name"] + "-scheduler",
                         kind="scheduler")
        peers = [self.peer, controller, scheduler]
        self.config["runtimeBindings"]["peers"] = peers
        with (
            patch.object(m, "stable_bff", return_value=(self.bff, "net:[9]")),
            patch.object(m, "peer_specs", return_value=[
                {k: v for k, v in peer.items() if k != "image"} for peer in peers
            ]),
            patch.object(m, "metadata", return_value=self.value),
            patch.object(m, "namespace", side_effect=[
                "net:[1]", subprocess.CalledProcessError(1, ["private"]),
                ValueError("Runtime peer is not running"),
            ]),
            patch.object(m, "run") as command,
            patch.object(m, "worker_idle_state") as workers,
        ):
            result = m.reconcile_namespaces(self.config)
        command.assert_not_called()
        workers.assert_not_called()
        self.assertEqual([r["peer"] for r in result],
                         [controller["name"], scheduler["name"], self.peer["name"]])
        self.assertTrue(all(not r["ok"] for r in result))
        self.assertTrue(result[-1]["stale"])
        self.assertTrue(result[-1]["deferredForRuntime"])

    def test_unavailable_peer_does_not_relax_binding_or_metadata_guards(self):
        for field, wrong in (("image", "sha256:" + "0" * 64),
                             ("network", "container:" + "0" * 64)):
            with self.subTest(field=field):
                old = self.value[field]
                self.value[field] = wrong
                with self.assertRaises(ValueError):
                    self.unavailable_reconciliation(
                        namespace_error=subprocess.CalledProcessError(1, ["private"])
                    )
                self.value[field] = old
        with self.assertRaises(ValueError):
            self.unavailable_reconciliation(metadata_error=ValueError("foreign identity"))

    def test_current_namespace_does_not_restart(self):
        result, calls = self.reconciliation(fresh=True)
        self.assertEqual((result, calls), ([], []))

    def test_busy_worker_defers_all_stops(self):
        result, calls = self.reconciliation(busy=True)
        self.assertFalse(result[0]["ok"])
        self.assertTrue(result[0]["deferredForWorkers"])
        self.assertFalse(calls)

    def test_stop_failure_records_uncertain_and_never_removes(self):
        result, calls = self.reconciliation(failure=True)
        self.assertFalse(result[0]["ok"])
        self.assertEqual(len(calls), 1)

    def test_changed_peer_image_refuses_before_mutation(self):
        with self.assertRaises(ValueError):
            self.reconciliation(wrong_image=True)

    def test_key_repair_keeps_pin_distinct_from_old_bff(self):
        peer = dict(self.peer, kind="key", tenant="kosha")
        args = m.repair_command(self.config, peer, "serve")
        self.assertEqual(args[-2:], ["--image", peer["image"]])
        self.assertNotEqual(peer["image"], self.bff["image"])

    def test_registry_peer_injection_refused(self):
        with (
            patch.object(m, "stable_bff", return_value=(self.bff, "net:[9]")),
            self.assertRaises(ValueError),
        ):
            m.reconcile_namespaces(self.config)


if __name__ == "__main__":
    unittest.main()
