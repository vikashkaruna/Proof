"""Native scheduler composition without installing jobs or touching runtime data."""

import argparse
import fcntl
import importlib.util
import json
import plistlib
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "runtime_renewal", ROOT / "scripts/local-runtime-renewal.py"
)
renewal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renewal)
LABEL = "axiom-proof-local-runtime-renewal"
TENANT = "fd5e0001-0000-4000-8000-000000000001"


class RenewalTests(unittest.TestCase):
    def setUp(self):
        mocked = patch.object(renewal, "reconcile_namespaces", return_value=[])
        mocked.start()
        self.addCleanup(mocked.stop)
        workers = patch.object(renewal, "worker_idle_state", return_value="idle")
        workers.start()
        self.addCleanup(workers.stop)

    def fixture(self, base):
        raw_registry = json.dumps(
            {
                "schemaVersion": 1,
                "environment": "local",
                "deployments": [
                    {
                        "alias": "kosha",
                        "tenantId": TENANT,
                        "keyServicePort": 7443,
                        "schedulerPort": 8181,
                        "policySha256": "a" * 64,
                        "deploymentBindingSha256": "b" * 64,
                    }
                ],
            }
        ).encode()
        renewal.write_private(base / "registry.json", raw_registry)
        source = "scripts/lib/local_tenant_registry.py"
        (base / "bin").mkdir(mode=0o700)
        binary = base / "bin/docker"
        binary.write_text("test-only placeholder")
        binary.chmod(0o700)
        config = {
            "schemaVersion": 1,
            "label": LABEL,
            "workspace": str(ROOT),
            "python": str(Path(sys.executable).resolve()),
            "tenants": ["kosha"],
            "runtimeBindings": {
                "peers": [
                    {"kind": kind, "tenant": "kosha", "image": "sha256:" + "c" * 64}
                    for kind in ("key", "controller", "scheduler")
                ]
            },
            "sources": {source: renewal.digest((ROOT / source).read_bytes())},
            "tools": {str(binary): renewal.digest(binary.read_bytes())},
            "dockerExecutable": str(binary),
            "environment": {
                "HOME": str(base),
                "PATH": str(base / "bin") + ":/usr/bin:/bin",
                "AXIOM_LOCAL_TENANT_REGISTRY_FILE": str(base / "registry.json"),
                "AXIOM_LOCAL_TENANT_REGISTRY_SHA256": renewal.digest(raw_registry),
                "AXIOM_LOCAL_CUSTODY_ISSUER_DIR": str(base / "custody"),
                "AXIOM_LOCAL_CONTROLLER_DIR": str(base / "controller"),
            },
        }
        for component in ("custody", "controller"):
            (base / component).mkdir(mode=0o700)
        (base / "controller/kosha").mkdir(mode=0o700)
        renewal.write_private(
            base / "controller/kosha/runtime.json",
            json.dumps(
                {
                    "controllerImage": "sha256:" + "c" * 64,
                    "schedulerImage": "sha256:" + "c" * 64,
                }
            ).encode(),
        )
        raw = json.dumps(config).encode()
        renewal.write_private(base / "config.json", raw)
        renewal.write_private(base / "renewal.lock", b"")
        return config, base / "config.json", renewal.digest(raw)

    def test_cycle_composes_only_existing_due_commands_and_continues_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            config, record, sha = self.fixture(base)
            with (
                patch.object(renewal, "unexpired", return_value=True),
                patch.object(renewal, "run", side_effect=[1, 0]) as command,
            ):
                self.assertEqual(renewal.once(record, sha), 1)
            self.assertEqual(command.call_count, 2)
            custody, controller = [call.args[0] for call in command.call_args_list]
            self.assertIn("--tenant-id", custody)
            self.assertIn(TENANT, custody)
            self.assertIn("--key-service-image", custody)
            self.assertIn("sha256:" + "c" * 64, custody)
            self.assertIn("--tenant", controller)
            self.assertIn("kosha", controller)
            self.assertEqual(custody[-2:], ["--margin", "1200"])
            self.assertEqual(controller[-2:], ["--renew-margin", "1200"])
            for call in command.call_args_list:
                self.assertEqual(call.kwargs["env"], config["environment"])
                self.assertNotIn("--watch", call.args[0])
                self.assertNotIn("issue", call.args[0])
            state = json.loads(renewal.read_private(base / "status.json"))
            self.assertEqual([item["ok"] for item in state["outcomes"]], [False, True])
            self.assertEqual((base / "status.json").stat().st_mode & 0o777, 0o600)

    def test_runtime_image_drift_refuses_controller_helper_before_any_restart(self):
        for field in ("controllerImage", "schedulerImage"):
            with tempfile.TemporaryDirectory() as temp:
                base = Path(temp).resolve()
                _config, record, sha = self.fixture(base)
                runtime = base / "controller/kosha/runtime.json"
                value = json.loads(runtime.read_bytes())
                value[field] = "sha256:" + "d" * 64
                runtime.write_text(json.dumps(value))
                with (
                    patch.object(renewal, "unexpired", return_value=True),
                    patch.object(renewal, "run", return_value=0) as command,
                ):
                    self.assertEqual(renewal.once(record, sha), 1)
                self.assertEqual(command.call_count, 1)
                self.assertIn(
                    "local-custody-credentials.py", command.call_args.args[0][2]
                )
                status = json.loads((base / "status.json").read_bytes())
                self.assertTrue(
                    status["outcomes"][1]["runtimeConfigurationUnconfirmed"]
                )

    def test_runtime_pin_guard_rejects_missing_duplicate_and_unprotected_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            config, _, _ = self.fixture(base)
            renewal.validate_runtime_images(config, "kosha")
            runtime = base / "controller/kosha/runtime.json"
            runtime.chmod(0o644)
            with self.assertRaises(ValueError):
                renewal.validate_runtime_images(config, "kosha")
            runtime.chmod(0o600)
            peers = config["runtimeBindings"]["peers"]
            config["runtimeBindings"]["peers"] = peers[:-1]
            with self.assertRaises(ValueError):
                renewal.validate_runtime_images(config, "kosha")
            config["runtimeBindings"]["peers"] = peers + [peers[-1]]
            with self.assertRaises(ValueError):
                renewal.validate_runtime_images(config, "kosha")
            runtime.write_text("[]")
            with self.assertRaises(TypeError):
                renewal.validate_runtime_images(config, "kosha")
            runtime.unlink()
            with self.assertRaises(OSError):
                renewal.validate_runtime_images(config, "kosha")

    def test_overlap_skips_entire_cycle(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            _, record, sha = self.fixture(base)
            with (base / "renewal.lock").open("r+") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with patch.object(renewal, "run") as command:
                    self.assertEqual(renewal.once(record, sha), 0)
                command.assert_not_called()
            self.assertFalse((base / "status.json").exists())

    def test_changed_sources_and_registry_refuse_and_record_safe_failure(self):
        for change in ("source", "registry"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temp:
                base = Path(temp).resolve()
                config, record, sha = self.fixture(base)
                if change == "registry":
                    (base / "registry.json").write_text("changed PRIVATE_TOKEN")
                else:
                    config["sources"]["scripts/lib/local_tenant_registry.py"] = "0" * 64
                    record.write_text(json.dumps(config))
                    sha = renewal.digest(record.read_bytes())
                with patch.object(renewal, "run") as command:
                    self.assertEqual(renewal.once(record, sha), 1)
                command.assert_not_called()
                state = renewal.read_private(base / "status.json")
                self.assertTrue(json.loads(state)["refused"])
                self.assertNotIn(b"PRIVATE_TOKEN", state)

    def test_foreign_or_unprotected_config_and_lock_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            _, record, sha = self.fixture(base)
            for target in (record, base / "renewal.lock"):
                target.chmod(0o644)
                with self.assertRaises(ValueError):
                    renewal.once(record, sha)
                target.chmod(0o600)
            with self.assertRaises(ValueError):
                renewal.once(record, "0" * 64)
            link = base / "link.json"
            link.symlink_to(record)
            with self.assertRaises(ValueError):
                renewal.load(link, sha)

    def test_expired_and_missing_authority_never_invokes_child(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            config, record, sha = self.fixture(base)
            directory = base / "controller/kosha/credentials"
            directory.mkdir(parents=True, mode=0o700)
            renewal.write_private(
                directory / "current.json",
                json.dumps({"expiresAt": int(time.time()) - 1}).encode(),
            )
            self.assertFalse(renewal.unexpired(config, "kosha", TENANT, "controller"))
            self.assertFalse(renewal.unexpired(config, "kosha", TENANT, "custody"))
            with patch.object(renewal, "run") as command:
                self.assertEqual(renewal.once(record, sha), 1)
            command.assert_not_called()
            state = json.loads(renewal.read_private(base / "status.json"))
            self.assertTrue(
                all(item["requiresFreshIssue"] for item in state["outcomes"])
            )

    def test_published_unexpired_metadata_allows_existing_renewal_only(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            config, _, _ = self.fixture(base)
            directory = base / "custody/credentials" / TENANT
            directory.mkdir(parents=True, mode=0o700)
            credential = "10000000-0000-4000-8000-000000000001"
            renewal.write_private(directory / "producer.last", credential.encode())
            request = {
                "credentialId": credential,
                "purpose": "local-custody-credential-issue",
                "issuedAt": int(time.time()) - 100,
                "expiresAt": int(time.time()) + 1000,
            }
            renewal.write_private(
                directory / (credential + ".request.json"), json.dumps(request).encode()
            )
            self.assertTrue(renewal.unexpired(config, "kosha", TENANT, "custody"))
            request["credentialId"] = "different"
            (directory / (credential + ".request.json")).write_text(json.dumps(request))
            self.assertFalse(renewal.unexpired(config, "kosha", TENANT, "custody"))

    def test_subprocess_discards_secret_output_and_timeout(self):
        for result in (
            subprocess.CompletedProcess([], 1),
            subprocess.TimeoutExpired(["PRIVATE_TOKEN"], 1),
        ):
            with patch.object(
                renewal.subprocess,
                "run",
                **(
                    {"return_value": result}
                    if isinstance(result, subprocess.CompletedProcess)
                    else {"side_effect": result}
                ),
            ) as execute:
                self.assertEqual(renewal.run(["python", "script"]), 1)
                self.assertEqual(execute.call_args.kwargs["stdout"], subprocess.DEVNULL)
                self.assertEqual(execute.call_args.kwargs["stderr"], subprocess.DEVNULL)

    def test_reviewed_install_plist_and_foreign_job_guards(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            config, _record, _sha = self.fixture(base)
            home = base / "home"
            agents = home / "Library/LaunchAgents"
            agents.mkdir(parents=True, mode=0o700)
            environment = base / "environment"
            renewal.write_private(
                environment, ("LOCAL_RUNTIME_RENEWAL_LABEL=" + LABEL + "\n").encode()
            )
            args = argparse.Namespace(
                source_sha256=renewal.digest(Path(renewal.__file__).read_bytes()),
                environment_file=environment,
                state_dir=base / "installed",
                path="/usr/bin:/bin",
                custody_dir=base / "custody",
                controller_dir=base / "controller",
                registry_file=base / "registry.json",
                registry_sha256=config["environment"][
                    "AXIOM_LOCAL_TENANT_REGISTRY_SHA256"
                ],
                tenant=["kosha"],
                bff_container_id="a" * 64,
            )
            with (
                patch.object(renewal.sys, "platform", "darwin"),
                patch.object(renewal.Path, "home", return_value=home),
                patch.object(renewal.shutil, "which", return_value=sys.executable),
                patch.object(renewal, "job_loaded", return_value=False),
                patch.object(
                    renewal,
                    "capture_runtime_bindings",
                    return_value={"bffId": "a" * 64},
                ),
                patch.object(renewal, "source_hashes", return_value=config["sources"]),
                patch.object(renewal, "run", return_value=0) as command,
            ):
                renewal.install(args)
                self.assertIn("bootstrap", command.call_args.args[0])
                rendered = plistlib.loads((agents / (LABEL + ".plist")).read_bytes())
                self.assertEqual(rendered["Label"], LABEL)
                self.assertTrue(rendered["RunAtLoad"])
                self.assertEqual(rendered["StartInterval"], 300)
                self.assertEqual(rendered["Umask"], 0o077)
                self.assertEqual(
                    rendered["ProgramArguments"][1:4],
                    ["-I", str(args.state_dir / "runner.py"), "once"],
                )
                self.assertFalse(
                    any(
                        "TOKEN" in name or "SECRET" in name
                        for name in rendered["EnvironmentVariables"]
                    )
                )
                for path in args.state_dir.iterdir():
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                with self.assertRaises(ValueError):
                    renewal.install(args)
                installed = args.state_dir / "config.json"
                installed_sha = renewal.digest(installed.read_bytes())
                with patch("builtins.print"):
                    renewal.inspect_job(installed, installed_sha)
                (agents / (LABEL + ".plist")).write_bytes(b"foreign")
                with self.assertRaises(ValueError):
                    renewal.inspect_job(installed, installed_sha, remove=True)
                self.assertTrue((agents / (LABEL + ".plist")).exists())
                destination = agents / (LABEL + ".plist")
                destination.write_bytes((args.state_dir / "job.plist").read_bytes())
                with (
                    patch.object(renewal, "job_loaded", return_value=True),
                    patch.object(renewal, "run", return_value=1),
                    self.assertRaises(ValueError),
                ):
                    renewal.inspect_job(installed, installed_sha, remove=True)
                self.assertTrue(destination.exists())
                with (
                    patch.object(renewal, "job_loaded", return_value=True),
                    patch.object(renewal, "run", return_value=0),
                    patch("builtins.print"),
                ):
                    renewal.inspect_job(installed, installed_sha, remove=True)
                self.assertFalse(destination.exists())
                self.assertTrue(installed.exists())

    def test_loaded_foreign_job_is_never_unloaded(self):
        with (
            patch.object(
                renewal.subprocess,
                "run",
                return_value=subprocess.CompletedProcess(
                    [], 0, "path = /foreign/job.plist\n", ""
                ),
            ),
            self.assertRaises(ValueError),
        ):
            renewal.job_loaded(LABEL, Path("/owned/job.plist"))


class WorkerRenewalGates(unittest.TestCase):
    fixture = RenewalTests.fixture

    def cycle(
        self, base, *, idle="busy", authority=True, network=None, inventory_error=False
    ):
        _config, record, sha = self.fixture(base)
        from contextlib import ExitStack

        with ExitStack() as stack:
            stack.enter_context(
                patch.object(
                    renewal, "reconcile_namespaces", return_value=network or []
                )
            )
            stack.enter_context(
                patch.object(
                    renewal,
                    "unexpired",
                    **(
                        {"side_effect": authority}
                        if isinstance(authority, list)
                        else {"return_value": authority}
                    ),
                )
            )
            if inventory_error:
                stack.enter_context(
                    patch.object(
                        renewal,
                        "idle_workers",
                        side_effect=subprocess.TimeoutExpired("docker", 30),
                    )
                )
            else:
                stack.enter_context(
                    patch.object(
                        renewal,
                        "worker_idle_state",
                        **(
                            {"side_effect": idle}
                            if isinstance(idle, list)
                            else {"return_value": idle}
                        ),
                    )
                )
            command = stack.enter_context(patch.object(renewal, "run", return_value=0))
            result = renewal.once(record, sha)
            state = json.loads(renewal.read_private(base / "status.json"))
            return result, state, command.call_args_list

    def test_busy_worker_blocks_both_restarting_helpers_with_current_namespaces(self):
        with tempfile.TemporaryDirectory() as temp:
            result, state, commands = self.cycle(Path(temp).resolve())
        self.assertEqual(result, 1)
        self.assertFalse(commands)
        self.assertFalse(state["refused"])
        self.assertEqual(len(state["outcomes"]), 2)
        self.assertTrue(
            all(
                item["deferredForWorkers"] and item["workerInventory"] == "busy"
                for item in state["outcomes"]
            )
        )

    def test_unknown_inventory_defers_instead_of_assuming_no_live_work(self):
        with tempfile.TemporaryDirectory() as temp:
            result, state, commands = self.cycle(
                Path(temp).resolve(), inventory_error=True
            )
        self.assertEqual(result, 1)
        self.assertFalse(commands)
        self.assertTrue(
            all(item["workerInventory"] == "unknown" for item in state["outcomes"])
        )

    def test_worker_start_between_components_defers_due_controller_renewal(self):
        with tempfile.TemporaryDirectory() as temp:
            result, state, commands = self.cycle(
                Path(temp).resolve(), idle=["idle", "busy"]
            )
        self.assertEqual(result, 1)
        self.assertEqual(len(commands), 1)
        self.assertIn("local-custody-credentials.py", commands[0].args[0][2])
        self.assertTrue(state["outcomes"][0]["ok"])
        self.assertEqual(state["outcomes"][1]["component"], "controller")
        self.assertTrue(state["outcomes"][1]["deferredForWorkers"])

    def test_expiry_while_deferred_requires_fresh_issuance_without_reviving(self):
        with tempfile.TemporaryDirectory() as temp:
            result, state, commands = self.cycle(
                Path(temp).resolve(), authority=[True, False, True, False]
            )
        self.assertEqual(result, 1)
        self.assertFalse(commands)
        self.assertTrue(
            all(
                item["requiresFreshIssue"] and item["deferredForWorkers"]
                for item in state["outcomes"]
            )
        )

    def test_authority_expiry_during_idle_check_is_rechecked_before_helpers(self):
        with tempfile.TemporaryDirectory() as temp:
            result, state, commands = self.cycle(
                Path(temp).resolve(), idle="idle", authority=[True, False, True, False]
            )
        self.assertEqual(result, 1)
        self.assertFalse(commands)
        self.assertTrue(all(item["requiresFreshIssue"] for item in state["outcomes"]))

    def test_namespace_deferral_preserves_per_component_expiry_status(self):
        with tempfile.TemporaryDirectory() as temp:
            result, state, commands = self.cycle(
                Path(temp).resolve(),
                authority=False,
                network=[
                    {"component": "network", "ok": False, "deferredForWorkers": True}
                ],
            )
        self.assertEqual(result, 1)
        self.assertFalse(commands)
        self.assertTrue(
            all(item["requiresFreshIssue"] for item in state["outcomes"][1:])
        )

    def test_unconfirmed_runtime_defers_live_authority_without_invoking_helpers(self):
        with tempfile.TemporaryDirectory() as temp:
            result, state, commands = self.cycle(
                Path(temp).resolve(), network=[{"component": "network", "ok": False}]
            )
        self.assertEqual(result, 1)
        self.assertFalse(commands)
        self.assertTrue(
            all(item["deferredForRuntime"] for item in state["outcomes"][1:])
        )


if __name__ == "__main__":
    unittest.main()
