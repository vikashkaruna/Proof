"""Protected issuer/launcher conformance without Docker, database or network IO."""

import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from lib.local_controller_runtime import (
    DOMAIN,
    TENANTS,
    WORKLOAD_ALIAS,
    alias_options,
    build_configuration,
    issue_request,
    renewal_due,
)

spec = importlib.util.spec_from_file_location(
    "local_controller_launcher", ROOT / "scripts/local-assessment-controller.py"
)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)
ID = "11111111-1111-4111-8111-111111111111"
NEXT = "22222222-2222-4222-8222-222222222222"
IMAGE = "sha256:" + "a" * 64
NODE = f"spiffe://{DOMAIN}/spire/agent/join_token/local"


def policy(slug="kosha"):
    value = {
        "tenantId": TENANTS[slug][0],
        "policyId": ID,
        "targetWorkloadId": NEXT,
        "keyPolicySha256": "b" * 64,
        "deploymentBindingSha256": "c" * 64,
        "servicePrincipals": {
            "producer": f"spiffe://{DOMAIN}/service/assessment-dispatch-producer",
            "controller": f"spiffe://{DOMAIN}/controller/assessment",
        },
    }
    text = json.dumps(value, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(text.encode()).hexdigest()
    return {
        "policyText": text,
        "policySha256": digest,
        "epoch": 2,
        "activationEventId": NEXT,
    }, {"policyText": text, "policySha256": digest}


def runtime(slug="kosha"):
    return {
        "controllerImage": IMAGE,
        "workerImage": IMAGE,
        "schedulerImage": IMAGE,
        "namespace": "axiom-proof-local-assessment-" + slug,
        "temporalAddress": "host.docker.internal:17233",
        "supabaseUrl": "http://host.docker.internal:57121",
        "dockerGid": 0,
    }


def completed(stdout="", code=0):
    return subprocess.CompletedProcess([], code, stdout, "private-error-marker")


class ConfigurationTests(unittest.TestCase):
    def test_derived_service_file_is_accepted_by_libpq_parser(self):
        executable = shutil.which("psql")
        if not executable and Path("/opt/homebrew/opt/libpq/bin/psql").is_file():
            executable = "/opt/homebrew/opt/libpq/bin/psql"
        if not executable:
            self.skipTest("native libpq client unavailable")
        with tempfile.TemporaryDirectory(
            prefix="axiom-controller-service-"
        ) as temporary:
            base = Path(temporary) / "issuer"
            custody = SimpleNamespace(
                SERVICE="original-issuer",
                configuration=lambda *_args: {"version": 1, "service": {}},
                source=lambda _value: (
                    b"[original-issuer]\nhost=/nonexistent-axiom-controller-test\nconnect_timeout=1\n"
                ),
            )
            with (
                patch.object(launcher, "BASE", base),
                patch.object(launcher, "load_module", return_value=custody),
                patch.object(
                    launcher,
                    "private_directory",
                    side_effect=lambda path: path.mkdir(mode=0o700),
                ),
                patch.object(
                    launcher.issuer,
                    "create",
                    side_effect=lambda path, data: path.write_bytes(data),
                ),
                patch.object(launcher.issuer, "configuration", return_value={}),
            ):
                launcher.prepare_issuer(Path("/reviewed/source.json"), "a" * 64)
            result = subprocess.run(
                [executable, "-X", "-w", "--dbname=service=axiom-controller-issuer"],
                env={
                    "PGSERVICEFILE": str(base / "controller-db.service"),
                    "PGPASSFILE": "/nonexistent",
                },
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("syntax error in service file", result.stderr)
            self.assertIn("nonexistent-axiom-controller-test", result.stderr)

    def test_requests_pass_unchanged_protected_issuer_validator(self):
        for tenant, _ in TENANTS.values():
            raw, digest = issue_request(
                tenant, "a" * 64, ID, 1800000000, credential_id=NEXT
            )
            value = launcher.issuer.request(raw, digest, "issue")
            self.assertEqual(value["tenantId"], tenant)
            self.assertEqual(value["expiresAt"] - value["issuedAt"], 3600)
            self.assertIsNone(value["predecessorId"])
        raw, digest = issue_request(
            TENANTS["kosha"][0],
            "a" * 64,
            ID,
            1800000000,
            predecessor=ID,
            credential_id=NEXT,
        )
        self.assertEqual(
            launcher.issuer.request(raw, digest, "issue")["predecessorId"], ID
        )

    def test_expired_predecessors_cannot_auto_reissue(self):
        self.assertFalse(renewal_due({"expiresAt": 3601}, 1))
        self.assertTrue(renewal_due({"expiresAt": 1201}, 1))
        for expiry in (1, 0):
            with self.assertRaises(ValueError):
                renewal_due({"expiresAt": expiry}, 1)
        with self.assertRaises(ValueError):
            renewal_due({"expiresAt": 3601}, 1, 3600)

    def test_configs_preserve_exact_custody_and_workload_gates(self):
        for slug, (tenant, port) in TENANTS.items():
            active, manifest = policy(slug)
            config = build_configuration(
                slug, active, manifest, NODE, IMAGE, runtime(slug)["namespace"]
            )
            controller = config["controller"]
            self.assertEqual(controller["tenantId"], tenant)
            self.assertEqual(
                controller["keys"]["custody"]["activationEventId"],
                active["activationEventId"],
            )
            self.assertEqual(controller["keys"]["custody"]["activationEpoch"], 2)
            self.assertEqual(controller["keys"]["keyService"]["endpoint"]["port"], port)
            self.assertEqual(
                controller["launcher"]["workloadApiVolume"], WORKLOAD_ALIAS
            )
            self.assertTrue(WORKLOAD_ALIAS.startswith("axiom-workload-api-"))
            self.assertEqual(
                controller["keys"]["workload"]["spiffeId"],
                f"spiffe://{DOMAIN}/controller/assessment",
            )

    def test_active_policy_text_and_hash_must_match_manifest(self):
        active, manifest = policy()
        for field, changed in (
            ("policyText", "{}"),
            ("policySha256", "0" * 64),
            ("epoch", 0),
            ("epoch", True),
            ("activationEventId", "foreign"),
        ):
            with self.subTest(field=field), self.assertRaises(ValueError):
                build_configuration(
                    "kosha",
                    {**active, field: changed},
                    manifest,
                    NODE,
                    IMAGE,
                    "namespace",
                )

    def test_workload_alias_uses_same_pinned_daemon_directory(self):
        source = {
            "Name": "axiom-spire-workload",
            "Driver": "local",
            "Labels": {"axiom.purpose": "local-spire"},
            "Mountpoint": "/var/lib/docker/volumes/axiom-spire-workload/_data",
        }
        options = alias_options(source)
        self.assertEqual(
            options, {"type": "none", "o": "bind", "device": source["Mountpoint"]}
        )
        for field, value in (
            ("Name", "foreign"),
            ("Driver", "foreign"),
            ("Mountpoint", "/tmp/../../foreign"),
            ("Labels", {}),
        ):
            with self.subTest(field=field), self.assertRaises(ValueError):
                alias_options({**source, field: value})


class LauncherTests(unittest.TestCase):
    def test_controller_grants_daemon_only_to_trusted_uid_and_preserves_secret_files(
        self,
    ):
        args = launcher.controller_args("kosha", runtime(), "serve")
        self.assertIn("20103:20103", args)
        self.assertIn("--cap-drop", args)
        self.assertNotIn("--cap-add", args)
        self.assertIn("--read-only", args)
        self.assertIn("no-new-privileges:true", args)
        self.assertIn(
            "type=bind,src=/var/run/docker.sock,dst=/run/docker.sock,readonly", args
        )
        self.assertIn(
            f"type=volume,src={WORKLOAD_ALIAS},dst=/run/workload,readonly", args
        )
        self.assertEqual(args[-2:], ["--serve", launcher.CONF + "/config.json"])
        self.assertNotIn("SUPABASE_SERVICE_KEY", str(args))
        self.assertNotIn("--add-host", args)
        self.assertIn("20111", args)

    def test_scheduled_reads_default_off_and_mount_only_reviewed_socket_when_explicit(
        self,
    ):
        self.assertNotIn("20112", launcher.controller_args("kosha", runtime(), "serve"))
        self.assertNotIn(
            "--monitoring-read-pump", launcher.scheduler_args("kosha", runtime())
        )
        approved = dict(runtime(), monitoringReadDispatch=True)
        volume = {
            "Name": "axiom-discovery-controller-socket",
            "Driver": "local",
            "Labels": {"axiom.purpose": "local-discovery-controller"},
        }
        with patch.object(
            launcher, "run", return_value=SimpleNamespace(stdout=json.dumps([volume]))
        ):
            controller = launcher.controller_args("kosha", approved, "serve")
        self.assertIn("20112", controller)
        self.assertIn(
            "type=volume,src=axiom-discovery-controller-socket,dst=/run/axiom-discovery,readonly",
            controller,
        )
        scheduler = launcher.scheduler_args("kosha", approved)
        self.assertIn("--monitoring-read-pump", scheduler)
        self.assertNotIn("20112", scheduler)
        self.assertNotIn("axiom-discovery-controller-socket", str(scheduler))

    def test_missing_foreign_monitoring_socket_refuses_before_stop(self):
        approved = dict(runtime(), monitoringReadDispatch=True)
        for volume in (
            [],
            [{"Name": "foreign"}],
            [
                {
                    "Name": "axiom-discovery-controller-socket",
                    "Driver": "local",
                    "Labels": {},
                }
            ],
        ):
            with (
                patch.object(
                    launcher,
                    "run",
                    return_value=SimpleNamespace(stdout=json.dumps(volume)),
                ),
                patch.object(launcher, "remove_owned") as remove,
            ):
                with self.assertRaises(ValueError):
                    launcher.serve("kosha", approved, "serve")
                remove.assert_not_called()
        with self.assertRaises(TypeError):
            launcher.validate_runtime(dict(runtime(), monitoringReadDispatch="true"))

    def test_scheduler_receives_no_backend_or_docker_credentials(self):
        args = launcher.scheduler_args("kosha", runtime())
        self.assertIn("20104:20104", args)
        self.assertIn("TEMPORAL_NAMESPACE=" + runtime()["namespace"], args)
        self.assertIn("--assessment-controller-uid", args)
        self.assertIn("20103", args)
        self.assertIn("--assessment-outbox-pump", args)
        self.assertNotIn("docker.sock", str(args))
        self.assertNotIn("backend.key", str(args))
        self.assertNotIn("SUPABASE", str(args))
        self.assertNotIn("/run/workload", str(args))
        self.assertIn(
            "type=volume,src=axiom-assessment-controller-kosha-socket,dst=/run/assessment-controller,readonly",
            args,
        )

    def test_rejects_invalid_runtime_before_any_mutation(self):
        for field, value in (
            ("workerImage", "latest"),
            ("dockerGid", -1),
            ("dockerGid", True),
            ("temporalAddress", "foreign.example:7233"),
            ("namespace", "bad namespace"),
            ("supabaseUrl", "http://username:password@localhost"),
        ):
            with (
                patch.object(launcher, "run") as execute,
                self.subTest(field=field),
                self.assertRaises(ValueError),
            ):
                launcher.stage("kosha", {**runtime(), field: value})
            execute.assert_not_called()

    def test_never_removes_foreign_containers(self):
        with patch.object(launcher, "run") as execute:
            with self.assertRaises(ValueError):
                launcher.remove_owned("axiom-bff")
            execute.assert_not_called()
        with patch.object(
            launcher,
            "run",
            return_value=completed(
                json.dumps([{"Config": {"Labels": {"axiom.purpose": "foreign"}}}])
            ),
        ) as execute:
            with self.assertRaises(ValueError):
                launcher.remove_owned(launcher.name("kosha"))
            self.assertEqual(execute.call_count, 1)

    def test_live_owned_controller_stops_gracefully_before_removal(self):
        info = {"Config": {"Labels": {"axiom.purpose": launcher.PURPOSE}}}
        with patch.object(
            launcher, "run", return_value=completed(json.dumps([info]))
        ) as execute:
            launcher.remove_owned(launcher.name("kosha"))
        self.assertEqual(
            execute.call_args_list[1].args[0],
            ["docker", "stop", "--time", "95", launcher.name("kosha")],
        )
        self.assertEqual(
            execute.call_args_list[2].args[0], ["docker", "rm", launcher.name("kosha")]
        )
        self.assertNotIn("-f", str(execute.call_args_list))

    def test_existing_alias_must_have_exact_mount_options(self):
        source = {
            "Name": "axiom-spire-workload",
            "Driver": "local",
            "Labels": {"axiom.purpose": "local-spire"},
            "Mountpoint": "/var/lib/docker/volumes/axiom-spire-workload/_data",
        }
        with patch.object(
            launcher,
            "run",
            side_effect=[
                completed(json.dumps([source])),
                completed(
                    json.dumps(
                        [
                            {
                                "Driver": "local",
                                "Labels": {"axiom.purpose": launcher.PURPOSE},
                                "Options": {"type": "tmpfs"},
                            }
                        ]
                    )
                ),
            ],
        ) as execute:
            with self.assertRaises(ValueError):
                launcher.provision_workload_alias()
            self.assertEqual(execute.call_count, 2)

    def test_provision_namespace_is_local_and_uses_only_explicit_namespace(self):
        with (
            patch.object(launcher, "run", return_value=completed()) as execute,
            patch("builtins.print"),
        ):
            launcher.provision_namespace(runtime())
        args = execute.call_args.args[0]
        self.assertIn("--rm", args)
        self.assertIn("container:axiom-bff", args)
        self.assertEqual(
            args[-2:], [runtime()["temporalAddress"], runtime()["namespace"]]
        )
        self.assertIn("RegisterNamespaceRequest", args[-3])
        self.assertNotIn("SUPABASE", str(args))

    def test_uncertain_issuance_fences_new_request_and_explicit_resume_reuses_exact_request(
        self,
    ):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with (
                patch.object(launcher, "BASE", root),
                patch.object(launcher, "settings", return_value=({}, "a" * 64)),
                patch.object(launcher.issuer, "ancestry"),
                patch.object(
                    launcher, "run", side_effect=RuntimeError("uncertain")
                ) as execute,
            ):
                with self.assertRaises(RuntimeError):
                    launcher.issue("kosha", ID)
                pending_file = root / "kosha/credentials/pending.json"
                pending = json.loads(pending_file.read_bytes())
                request_file = pending_file.parent / (
                    pending["credentialId"] + ".request.json"
                )
                original = request_file.read_bytes()
                with self.assertRaisesRegex(ValueError, "resume"):
                    launcher.issue("kosha", ID)
                self.assertEqual(execute.call_count, 1)

                def success(args):
                    self.assertIn("--resume-issue", args)
                    self.assertEqual(request_file.read_bytes(), original)
                    value = json.loads(original)
                    target = Path(args[-1])
                    target.mkdir(mode=0o700)
                    ready = {
                        key: value[key]
                        for key in (
                            "schemaVersion",
                            "credentialId",
                            "tenantId",
                            "predecessorId",
                            "issuedAt",
                            "expiresAt",
                        )
                    }
                    ready.update(
                        requestSha256=pending["requestSha256"], status="active"
                    )
                    for name, data in (
                        ("ready.json", json.dumps(ready).encode()),
                        ("backend.key", b'{"protectedIssuerOutput":true}'),
                    ):
                        path = target / name
                        path.write_bytes(data)
                        path.chmod(0o600)
                    return completed()

                execute.side_effect = success
                with patch("builtins.print"):
                    launcher.issue("kosha", None, resume=pending["credentialId"])
                self.assertFalse(pending_file.exists())
                self.assertEqual(
                    (pending_file.parent / "current.json").read_bytes(), original
                )
                self.assertEqual(
                    (pending_file.parent / "backend.key").stat().st_mode & 0o777, 0o600
                )


if __name__ == "__main__":
    unittest.main()
