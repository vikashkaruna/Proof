"""Protected filesystem/private-pipe preflight only; no live Docker or approval."""

import base64
import copy
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
        self.assertEqual(MODULE.parse_json(MODULE.protected_bytes(path)), {"example": True})
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
                return subprocess.CompletedProcess(args, 0, json.dumps(self.inspection(config)), "")
            self.assertEqual(args[:4], ["docker", "exec", "-i", "b" * 64])
            self.assertNotIn("existing-operator-transport-fixture-only", str(args))
            self.assertNotIn("existing-operator-transport-fixture-only", str(kwargs.get("env")))
            self.assertIn("existing-operator-transport-fixture-only", kwargs["private_input"])
            return subprocess.CompletedProcess(args, 0, '{"data":{"task":null}}', "")

        with patch.object(MODULE, "run", side_effect=fake):
            self.assertEqual(
                MODULE.operator_request(config, "/internal/owned-deployments/tasks/claim", {}),
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
                    MODULE.operator_request(config, "/internal/owned-deployments/tasks/claim", {})
                self.assertEqual(run.call_count, 1)

    def test_off_by_default_and_no_arbitrary_endpoint(self):
        config = self.config()
        for changed in [
            {**config, "enabled": False},
            {**config, "internalBffPort": True},
        ]:
            with patch.object(MODULE, "run") as run:
                with self.assertRaises(ValueError):
                    MODULE.operator_request(changed, "/internal/owned-deployments/tasks/claim", {})
                run.assert_not_called()
        with patch.object(MODULE, "run") as run:
            with self.assertRaises(ValueError):
                MODULE.operator_request(config, "https://foreign.test", {})
            run.assert_not_called()

    def test_one_original_deadline_shrinks_and_refuses_without_spawning(self):
        with (
            patch.object(MODULE.time, "monotonic", side_effect=[10, 29.5, 31]),
            patch.object(MODULE.subprocess, "run") as spawn,
        ):
            MODULE.run(["docker", "inspect", "fixture"], deadline=30)
            self.assertEqual(spawn.call_args.kwargs["timeout"], 20)
            MODULE.run(["docker", "inspect", "fixture"], deadline=30)
            self.assertEqual(spawn.call_args.kwargs["timeout"], 0.5)
            with self.assertRaisesRegex(ValueError, "deadline elapsed"):
                MODULE.run(["docker", "inspect", "fixture"], deadline=30)
            self.assertEqual(spawn.call_count, 2)

    def test_readonly_preflight_uses_one_fixed_overall_bound(self):
        with (
            patch.object(MODULE.time, "monotonic", return_value=100),
            patch.object(MODULE, "_readonly_host_preflight", return_value={}) as body,
        ):
            self.assertEqual(MODULE.readonly_host_preflight({}, {}), {})
            body.assert_called_once_with({}, {}, 130)

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

    def test_prepare_config_stages_only_reviewed_registry_and_existing_transport_over_private_stdin(
        self,
    ):
        config = self.config()
        registry = {
            "schemaVersion": 1,
            "manifests": [
                {
                    "purpose": "owned_synthetic_enrollment_v1",
                    "source": {"hostInstallerSha256": config["hostInstallerSha256"]},
                    "deployment": {
                        "bffContainerId": config["bffContainerId"],
                        "bffImage": config["bffImage"],
                    },
                }
            ],
        }
        file = self.private("registry.json", registry)
        config["manifestRegistryFile"] = str(file)

        def spawn(arguments, **kwargs):
            if arguments[:2] == ["docker", "inspect"]:
                return subprocess.CompletedProcess(
                    arguments, 0, json.dumps(self.inspection(config)), ""
                )
            self.assertEqual(arguments[:4], ["docker", "exec", "-i", config["bffContainerId"]])
            self.assertNotIn("existing-operator-transport-fixture-only", str(arguments))
            payload = MODULE.parse_json(kwargs["private_input"].encode())
            self.assertEqual(set(payload), {"manifests.json", "transport.json"})
            self.assertIn(
                "existing-operator-transport-fixture-only",
                MODULE.base64.b64decode(payload["transport.json"]["base64"]).decode(),
            )
            return subprocess.CompletedProcess(
                arguments,
                0,
                json.dumps({name: value["sha256"] for name, value in payload.items()}),
                "",
            )

        with patch.object(MODULE, "run", side_effect=spawn):
            self.assertEqual(MODULE.prepare_configuration(config)["state"], "prepared")
        registry["manifests"][0]["deployment"]["bffContainerId"] = "foreign"
        file.write_text(json.dumps(registry))
        with patch.object(MODULE, "run") as run:
            with self.assertRaisesRegex(ValueError, "pins refused"):
                MODULE.prepare_configuration(config)
            run.assert_not_called()


class OwnedPollerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name).resolve()
        self.directory.chmod(0o700)
        self.state = self.directory / "state"
        MODULE.owned_directory(self.state, create=True)
        self.configuration_file = self.directory / "config.json"
        MODULE.write_private(self.configuration_file, {"reviewed": True}, exclusive=True)
        self.config = {
            "stateDirectory": str(self.state),
            "hostInstallerSha256": MODULE.host_source_sha256(),
        }

    def test_actual_owner_marker_lock_overlap_and_foreign_directory_refusal(self):
        with MODULE.journal_lock(self.state):
            with self.assertRaises(BlockingIOError):
                with MODULE.journal_lock(self.state):
                    pass
        (self.state / "owner.json").write_text("{}")
        with self.assertRaises(ValueError):
            with MODULE.journal_lock(self.state):
                pass

    def task(self, claim_id):
        manifest = {
            "deployment": {},
            "tenantId": "89110000-0000-4000-8000-000000000001",
        }
        return {
            "taskId": "89110000-0000-4000-8000-000000000002",
            "tenantId": manifest["tenantId"],
            "requestId": "89110000-0000-4000-8000-000000000003",
            "claimId": claim_id,
            "manifest": manifest,
            "manifestSha256": MODULE.hashlib.sha256(MODULE.canonical(manifest)).hexdigest(),
            "reviewedHost": {"runtime": {"containerId": "reviewed-runtime"}},
        }

    def test_lost_effect_reply_retains_journal_and_never_reexecutes(self):
        calls = []

        def api(config, path, body):
            calls.append(path)
            if path == "tasks/claim":
                return {"kind": "installation", "task": self.task(body["claimId"])}
            if path.endswith("/authorize"):
                return {
                    "authorization": {
                        "step": body["step"],
                        "state": "confirmed",
                        "readback": {"actual": True},
                    }
                }
            return None

        effects = []

        def effect(config, file, directory, task, step, authorization, prior):
            effects.append(step)
            if step == "publish_scoped_credential":
                raise ValueError("uncertain child reply")
            return {"actual": True}

        with (
            patch.object(MODULE, "load_configuration", return_value=self.config),
            patch.object(MODULE, "call", side_effect=api),
            patch.object(MODULE, "fixed_effect", side_effect=effect),
            patch.object(
                MODULE,
                "readonly_host_preflight",
                return_value={"runtime": {"containerId": "reviewed-runtime"}},
            ),
        ):
            with self.assertRaisesRegex(ValueError, "unconfirmed"):
                MODULE.once(self.configuration_file)
            before = len(calls)
            with self.assertRaisesRegex(ValueError, "requires exact readback"):
                MODULE.once(self.configuration_file)
            self.assertEqual(len(calls), before)
        saved = MODULE.parse_json(MODULE.protected_bytes(self.state / "current.json"))
        self.assertEqual(saved["state"], "unconfirmed")
        self.assertEqual(effects.count("publish_scoped_credential"), 1)
        self.assertTrue(calls[-1].endswith("/unconfirmed"))
        self.assertEqual((self.state / "current.json").stat().st_mode & 0o777, 0o600)

    def test_replacement_runtime_refused_before_first_authorization_or_effect(self):
        def api(config, path, body):
            if path == "tasks/claim":
                return {"kind": "installation", "task": self.task(body["claimId"])}
            if path.endswith("/unconfirmed"):
                return None
            self.fail("Changed runtime reached authorization")

        with (
            patch.object(MODULE, "load_configuration", return_value=self.config),
            patch.object(MODULE, "call", side_effect=api),
            patch.object(MODULE, "fixed_effect") as effect,
            patch.object(
                MODULE,
                "readonly_host_preflight",
                return_value={"runtime": {"containerId": "replacement-runtime"}},
            ),
        ):
            with self.assertRaisesRegex(ValueError, "unconfirmed"):
                MODULE.once(self.configuration_file)
            effect.assert_not_called()

    def test_readonly_preflight_publishes_actual_observation_and_retains_receipt(self):
        def api(config, path, body):
            if path == "tasks/claim":
                return {"kind": "preflight", "task": self.task(body["claimId"])}
            self.assertEqual(body["observation"], {"actual": "read-only"})
            return {"state": "preflight_ready"}

        with (
            patch.object(MODULE, "load_configuration", return_value=self.config),
            patch.object(MODULE, "call", side_effect=api),
            patch.object(MODULE, "readonly_host_preflight", return_value={"actual": "read-only"}),
            patch.object(MODULE, "fixed_effect") as effect,
        ):
            self.assertEqual(MODULE.once(self.configuration_file), "completed")
            effect.assert_not_called()
        self.assertEqual(
            MODULE.parse_json(MODULE.protected_bytes(self.state / "current.json"))["state"],
            "completed",
        )

    def test_fixed_publish_uses_private_stdin_and_exact_full_container(self):
        file = self.directory / "backend.key"
        scope = {
            key: "89110000-0000-4000-8000-000000000001"
            for key in ("bindingId", "credentialId", "tenantId", "enrollmentId")
        }
        MODULE.write_private(
            file, {**scope, "accessToken": "private-fixture-token"}, exclusive=True
        )

        def spawn(arguments, **kwargs):
            self.assertEqual(arguments[:4], ["docker", "exec", "-i", "a" * 64])
            self.assertNotIn("private-fixture-token", str(arguments))
            payload = MODULE.parse_json(kwargs["private_input"].encode())
            self.assertNotIn("private-fixture-token", kwargs["private_input"])
            self.assertIn(
                "private-fixture-token",
                MODULE.base64.b64decode(payload["base64"]).decode(),
            )
            return subprocess.CompletedProcess(arguments, 0, '{"filePublished":true}', "")

        with (
            patch.object(MODULE, "bff_container", return_value="a" * 64),
            patch.object(MODULE, "run", side_effect=spawn),
        ):
            self.assertEqual(
                MODULE.publish_credential(self.config, scope, file),
                {"filePublished": True},
            )

    def renewal_installation(self, expiry):
        task = self.task("89110000-0000-4000-8000-000000000004")
        installation = {
            "state": "completed",
            "task": task,
            "steps": {
                "verify_installed_scope": {"confirmed": True},
                "publish_scoped_credential": {
                    "authorization": {"reservation": {"expiresAt": expiry}}
                },
            },
        }
        MODULE.write_private(self.state / (task["claimId"] + ".json"), installation, exclusive=True)
        return task

    def test_due_renewal_requires_exact_recorded_pins_and_retains_new_once_receipt(
        self,
    ):
        task = self.renewal_installation("2030-01-01T00:01:00+00:00")
        now = MODULE.datetime.fromisoformat("2030-01-01T00:00:00+00:00").timestamp()

        def api(config, path, body):
            self.assertEqual(path, "credentials/renew")
            return {
                "reservation": {
                    "expiresAt": "2030-01-01T00:15:00+00:00",
                    "credentialId": body["credentialId"],
                },
                "reviewedHost": task["reviewedHost"],
            }

        with (
            patch.object(MODULE, "load_configuration", return_value=self.config),
            patch.object(MODULE, "call", side_effect=api) as call,
            patch.object(MODULE, "same_reviewed_host") as pins,
            patch.object(MODULE, "fixed_effect", return_value={"filePublished": True}),
        ):
            self.assertEqual(
                MODULE.renew_due(self.configuration_file, now=now),
                {"renewed": 1, "expired": 0},
            )
            self.assertEqual(pins.call_count, 2)
            self.assertEqual(
                MODULE.renew_due(self.configuration_file, now=now),
                {"renewed": 0, "expired": 0},
            )
            self.assertEqual(call.call_count, 1)
        self.assertEqual(
            len(list(self.state.glob("renewal-????????-????-????-????-????????????.json"))),
            1,
        )

    def test_expired_and_uncertain_renewals_never_automatically_issue_again(self):
        self.renewal_installation("2030-01-01T00:01:00+00:00")
        now = MODULE.datetime.fromisoformat("2030-01-01T00:00:00+00:00").timestamp()
        with (
            patch.object(MODULE, "load_configuration", return_value=self.config),
            patch.object(MODULE, "call") as call,
            patch.object(MODULE, "same_reviewed_host"),
        ):
            self.assertEqual(
                MODULE.renew_due(self.configuration_file, now=now + 61),
                {"renewed": 0, "expired": 1},
            )
            call.assert_not_called()
            call.side_effect = ValueError("lost reservation reply")
            with self.assertRaises(ValueError):
                MODULE.renew_due(self.configuration_file, now=now)
            self.assertEqual(call.call_count, 1)
            with self.assertRaisesRegex(ValueError, "exact readback"):
                MODULE.renew_due(self.configuration_file, now=now)
            self.assertEqual(call.call_count, 1)

    def test_completed_renewal_head_is_durable_before_pending_retirement(self):
        task = self.renewal_installation("2030-01-01T00:01:00+00:00")
        now = MODULE.datetime.fromisoformat("2030-01-01T00:00:00+00:00").timestamp()

        def api(config, path, body):
            return {
                "reservation": {
                    "expiresAt": "2030-01-01T00:15:00+00:00",
                    "credentialId": body["credentialId"],
                },
                "reviewedHost": task["reviewedHost"],
            }

        with (
            patch.object(MODULE, "load_configuration", return_value=self.config),
            patch.object(MODULE, "call", side_effect=api) as call,
            patch.object(MODULE, "same_reviewed_host"),
            patch.object(MODULE, "fixed_effect", return_value={"filePublished": True}),
            patch.object(MODULE.os, "rename", side_effect=OSError("controlled crash after head")),
        ):
            with self.assertRaises(OSError):
                MODULE.renew_due(self.configuration_file, now=now)
            head = self.state / ("renewal-head-" + task["requestId"] + ".json")
            pending = self.state / ("renewal-pending-" + task["requestId"] + ".json")
            self.assertEqual(
                MODULE.parse_json(MODULE.protected_bytes(head)),
                MODULE.parse_json(MODULE.protected_bytes(pending)),
            )
            self.assertEqual(MODULE.parse_json(MODULE.protected_bytes(head))["state"], "completed")
            with self.assertRaisesRegex(ValueError, "exact readback"):
                MODULE.renew_due(self.configuration_file, now=now)
            self.assertEqual(call.call_count, 1)

    def reconciliation_fixture(self):
        claim_id = "89110000-0000-4000-8000-000000000004"
        task = self.task(claim_id)
        state = {
            "claimId": claim_id,
            "task": task,
            "state": "unconfirmed",
            "steps": {"publish_scoped_credential": {"state": "unknown_original_effect"}},
        }
        MODULE.write_private(self.state / "current.json", state, exclusive=True)
        receipt = {
            "claimId": claim_id,
            "kind": "installation",
            "tenantId": task["tenantId"],
            "requestId": task["requestId"],
            "taskId": task["taskId"],
            "manifestSha256": task["manifestSha256"],
            "terminal": "authority_revoked_with_original_effect_history",
            "receiptId": "52",
            "hostSha256": None,
            "stepReceipts": [
                {
                    "step": "publish_scoped_credential",
                    "state": "unconfirmed",
                    "receiptId": "50",
                }
            ],
        }
        return state, receipt

    def test_stop_readback_retains_unknown_history_and_never_reexecutes(self):
        original, receipt = self.reconciliation_fixture()

        def api(config, path, body):
            self.assertEqual(path, "tasks/read")
            self.assertEqual(body, {"claimId": original["claimId"]})
            return receipt

        with (
            patch.object(MODULE, "load_configuration", return_value=self.config),
            patch.object(MODULE, "call", side_effect=api) as call,
            patch.object(MODULE, "fixed_effect") as effect,
        ):
            result = MODULE.reconcile(self.configuration_file)
            self.assertEqual(result["state"], "authority_revoked_with_original_effect_history")
            self.assertEqual(MODULE.reconcile(self.configuration_file), result)
            self.assertEqual(call.call_count, 2)
            effect.assert_not_called()
        saved = MODULE.parse_json(MODULE.protected_bytes(self.state / "current.json"))
        self.assertEqual(saved["steps"], original["steps"])
        evidence = next(self.state.glob("reconciled-*.json"))
        self.assertEqual(MODULE.parse_json(MODULE.protected_bytes(evidence))["original"], original)
        self.assertNotEqual(saved["state"], "completed")

    def test_foreign_or_unknown_readback_never_clears_original_intent(self):
        original, receipt = self.reconciliation_fixture()
        before = MODULE.protected_bytes(self.state / "current.json")
        for key in ("tenantId", "requestId", "claimId", "manifestSha256"):
            with (
                patch.object(MODULE, "load_configuration", return_value=self.config),
                patch.object(MODULE, "call", return_value={**receipt, key: "foreign"}),
            ):
                with self.assertRaisesRegex(ValueError, "Foreign"):
                    MODULE.reconcile(self.configuration_file)
            self.assertEqual(MODULE.protected_bytes(self.state / "current.json"), before)
        with (
            patch.object(MODULE, "load_configuration", return_value=self.config),
            patch.object(
                MODULE,
                "call",
                return_value={**receipt, "terminal": "blocked", "receiptId": None},
            ),
        ):
            self.assertEqual(MODULE.reconcile(self.configuration_file)["state"], "blocked")
        self.assertEqual(MODULE.protected_bytes(self.state / "current.json"), before)
        self.assertEqual(list(self.state.glob("reconciled-*.json")), [])

    def test_completion_requires_six_distinct_actual_confirmation_receipts(self):
        original, receipt = self.reconciliation_fixture()
        receipt.update(
            terminal="installation_confirmed_history",
            stepReceipts=[
                {"step": step, "state": "confirmed", "receiptId": str(10 + n)}
                for n, step in enumerate(MODULE.STEPS)
            ],
        )
        with (
            patch.object(MODULE, "load_configuration", return_value=self.config),
            patch.object(MODULE, "call", return_value=receipt),
        ):
            receipt["stepReceipts"][1]["step"] = MODULE.STEPS[0]
            with self.assertRaisesRegex(ValueError, "six-step"):
                MODULE.reconcile(self.configuration_file)
            receipt["stepReceipts"][1]["step"] = MODULE.STEPS[1]
            self.assertEqual(
                MODULE.reconcile(self.configuration_file)["disposition"],
                "installation_confirmed_history",
            )

    def test_archived_claim_stop_preserves_unknown_renewal_and_fences_new_mints(self):
        original, receipt = self.reconciliation_fixture()
        archive = self.state / (original["claimId"] + ".json")
        (self.state / "current.json").rename(archive)
        pending = {
            "state": "effect_pending",
            "intent": {
                "tenantId": receipt["tenantId"],
                "enrollmentId": receipt["requestId"],
                "credentialId": "89110000-0000-4000-8000-000000000099",
            },
        }
        file = self.state / ("renewal-pending-" + receipt["requestId"] + ".json")
        MODULE.write_private(file, pending, exclusive=True)

        def api(config, path, body):
            self.assertEqual(path, "tasks/read")
            return receipt

        with (
            patch.object(MODULE, "load_configuration", return_value=self.config),
            patch.object(MODULE, "call", side_effect=api) as call,
            patch.object(MODULE, "fixed_effect") as effect,
        ):
            self.assertEqual(
                MODULE.reconcile(self.configuration_file, original["claimId"])["state"],
                "authority_revoked_with_original_effect_history",
            )
            MODULE.reconcile(self.configuration_file, original["claimId"])
            self.assertEqual(
                MODULE.renew_due(self.configuration_file), {"renewed": 0, "expired": 0}
            )
            self.assertEqual(call.call_count, 2)
            effect.assert_not_called()
        self.assertEqual(
            MODULE.parse_json(MODULE.protected_bytes(file))["state"],
            "authority_revoked_with_original_effect_history",
        )
        proof = next(self.state.glob("renewal-stopped-*.json"))
        self.assertEqual(MODULE.parse_json(MODULE.protected_bytes(proof))["original"], pending)
        self.assertFalse((self.state / "current.json").exists())

    def test_foreign_pending_renewal_never_gets_cleared_by_another_scope_stop(self):
        original, receipt = self.reconciliation_fixture()
        pending = {
            "state": "unconfirmed",
            "intent": {
                "tenantId": "foreign",
                "enrollmentId": receipt["requestId"],
                "credentialId": "89110000-0000-4000-8000-000000000099",
            },
        }
        file = self.state / ("renewal-pending-" + receipt["requestId"] + ".json")
        MODULE.write_private(file, pending, exclusive=True)
        before = MODULE.protected_bytes(self.state / "current.json")
        with (
            patch.object(MODULE, "load_configuration", return_value=self.config),
            patch.object(MODULE, "call", return_value=receipt),
        ):
            with self.assertRaisesRegex(ValueError, "Foreign renewal"):
                MODULE.reconcile(self.configuration_file)
        self.assertEqual(MODULE.protected_bytes(self.state / "current.json"), before)
        self.assertEqual(MODULE.parse_json(MODULE.protected_bytes(file)), pending)
        self.assertEqual(list(self.state.glob("renewal-stopped-*.json")), [])


class SharedControllerTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            "bffContainerId": "b" * 64,
            "bffImage": "sha256:" + "d" * 64,
            "internalBffPort": 4000,
            "dockerGid": 0,
        }
        self.deployment = {
            "controllerName": "axiom-proof-local-owned-execution-controller",
            "controllerImage": "sha256:" + "c" * 64,
            "workerImage": "sha256:" + "e" * 64,
            "workloadApiVolume": "axiom-workload-api-local",
            "brokerPort": 4000,
            "dockerGid": 0,
            **self.config,
        }
        self.manifest = {"deployment": self.deployment}
        self.observed = MODULE.expected_controller_configuration(self.config, self.manifest)
        name = self.deployment["controllerName"]
        self.info = {
            "Id": "a" * 64,
            "Image": self.deployment["controllerImage"],
            "State": {"Running": True},
            "Config": {
                "User": "20106:20106",
                "Labels": {"axiom.purpose": "local-owned-execution-controller"},
                "Entrypoint": ["node"],
                "Cmd": [
                    "--import",
                    "tsx",
                    "src/local-owned-execution-controller.ts",
                    "/etc/axiom/owned-execution-controller/config.json",
                ],
                "Env": ["PATH=/usr/bin"],
            },
            "HostConfig": {
                "NetworkMode": "container:" + "b" * 64,
                "Privileged": False,
                "ReadonlyRootfs": True,
                "CapDrop": ["ALL"],
                "GroupAdd": ["20113", "0"],
                "SecurityOpt": ["no-new-privileges:true"],
                "PidsLimit": 128,
                "Memory": 512 * 1024 * 1024,
            },
            "Mounts": [
                {
                    "Type": "volume",
                    "Name": name + "-conf",
                    "Destination": "/etc/axiom/owned-execution-controller",
                    "RW": False,
                },
                {
                    "Type": "volume",
                    "Name": name + "-socket",
                    "Destination": "/run/axiom-proof-local-owned-execution",
                    "RW": True,
                },
                {
                    "Type": "bind",
                    "Source": "/var/run/docker.sock",
                    "Destination": "/var/run/docker.sock",
                    "RW": True,
                },
            ],
        }

    def run_command(self, argv, **kwargs):
        if argv[1:3] == ["container", "ls"]:
            output = "a" * 64
        elif argv[1] == "inspect":
            output = json.dumps([self.info])
        elif argv[1:3] == ["image", "inspect"]:
            output = json.dumps([{"Config": {"Env": ["PATH=/usr/bin"]}}])
        elif MODULE.CONTROLLER_CONFIGURATION in argv:
            output = json.dumps(
                {"base64": base64.b64encode(json.dumps(self.observed).encode()).decode()}
            )
        elif MODULE.BFF_SOCKET in argv:
            output = '{"socketReady":true}'
        else:
            self.fail("Unexpected effectful command")
        return subprocess.CompletedProcess(argv, 0, stdout=output)

    def proof(self):
        with (
            patch.object(MODULE, "run", side_effect=self.run_command),
            patch.object(MODULE, "bff_container", return_value="b" * 64),
        ):
            return MODULE.controller_proof(self.config, self.manifest)

    def test_second_tenant_reuses_exact_controller_without_effects(self):
        readback, digest = self.proof()
        reviewed = {
            "containerId": readback["containerId"],
            "configurationSha256": digest,
        }
        with (
            patch.object(MODULE, "controller_observation", return_value=reviewed),
            patch.object(MODULE, "controller_proof", return_value=(readback, digest)),
            patch.object(MODULE, "child") as child,
        ):
            self.assertEqual(
                MODULE.fixed_effect(
                    self.config,
                    Path("/fixture/config.json"),
                    Path("/fixture"),
                    {
                        "manifest": self.manifest,
                        "reviewedHost": {"controller": reviewed},
                    },
                    "stage_owned_controller",
                    {},
                    {},
                ),
                readback,
            )
            child.assert_not_called()
        for field in ("containerId", "configurationSha256"):
            altered = {**reviewed, field: "f" * 64}
            with (
                self.subTest(field=field),
                patch.object(MODULE, "controller_observation", return_value=altered),
                patch.object(MODULE, "child") as child,
            ):
                with self.assertRaises(ValueError):
                    MODULE.fixed_effect(
                        self.config,
                        Path("/fixture/config.json"),
                        Path("/fixture"),
                        {
                            "manifest": self.manifest,
                            "reviewedHost": {"controller": reviewed},
                        },
                        "stage_owned_controller",
                        {},
                        {},
                    )
                child.assert_not_called()

    def test_actual_image_configuration_environment_mounts_and_isolation_refused(self):
        original = copy.deepcopy(self.info)
        original_config = copy.deepcopy(self.observed)
        mutations = [
            lambda: self.info.update(Image="sha256:" + "f" * 64),
            lambda: self.observed["container"].update(image="sha256:" + "f" * 64),
            lambda: self.info["Config"]["Env"].append("UNREVIEWED=value"),
            lambda: self.info["Mounts"].append(
                {
                    "Type": "bind",
                    "Source": "/foreign",
                    "Destination": "/foreign",
                    "RW": True,
                }
            ),
            lambda: self.info["HostConfig"].update(CapAdd=["SYS_ADMIN"]),
            lambda: self.info["HostConfig"].update(
                SecurityOpt=["no-new-privileges:true", "seccomp=unconfined"]
            ),
            lambda: self.info.update(Id="f" * 64),
        ]
        for index, mutate in enumerate(mutations):
            self.info = copy.deepcopy(original)
            self.observed = copy.deepcopy(original_config)
            mutate()
            with self.subTest(case=index), self.assertRaises(ValueError):
                self.proof()

    def test_first_install_creates_only_when_observation_was_absent(self):
        readback, _ = self.proof()
        task = {"manifest": self.manifest, "reviewedHost": {"controller": None}}
        with (
            patch.object(MODULE, "controller_observation", return_value=None),
            patch.object(MODULE, "controller_readback", return_value=readback),
            patch.object(MODULE, "child") as child,
        ):
            self.assertEqual(
                MODULE.fixed_effect(
                    self.config,
                    Path("/fixture/config.json"),
                    Path("/fixture"),
                    task,
                    "stage_owned_controller",
                    {},
                    {},
                ),
                readback,
            )
            self.assertEqual(
                [call.args[2][0] for call in child.call_args_list],
                ["stage", "check", "serve"],
            )
        with (
            patch.object(MODULE, "controller_observation", return_value={"containerId": "a" * 64}),
            patch.object(MODULE, "child") as child,
        ):
            with self.assertRaises(ValueError):
                MODULE.fixed_effect(
                    self.config,
                    Path("/fixture/config.json"),
                    Path("/fixture"),
                    task,
                    "stage_owned_controller",
                    {},
                    {},
                )
            child.assert_not_called()

    def test_controller_replaced_between_observation_and_readback_refused(self):
        readback, digest = self.proof()
        reviewed = {
            "containerId": readback["containerId"],
            "configurationSha256": digest,
        }
        with (
            patch.object(MODULE, "controller_observation", return_value=reviewed),
            patch.object(
                MODULE,
                "controller_proof",
                return_value=({**readback, "containerId": "f" * 64}, digest),
            ),
            patch.object(MODULE, "child") as child,
        ):
            with self.assertRaises(ValueError):
                MODULE.fixed_effect(
                    self.config,
                    Path("/fixture/config.json"),
                    Path("/fixture"),
                    {
                        "manifest": self.manifest,
                        "reviewedHost": {"controller": reviewed},
                    },
                    "stage_owned_controller",
                    {},
                    {},
                )
            child.assert_not_called()


if __name__ == "__main__":
    unittest.main()
