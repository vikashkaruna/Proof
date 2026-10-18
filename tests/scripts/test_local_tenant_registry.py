"""Reviewed local deployment selection, without Docker, database or network IO."""

import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from lib import local_controller_runtime as controller
from lib import local_tenant_registry as registry

TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
POLICY = {
    "tenantId": TENANT,
    "policyId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "targetWorkloadId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "deploymentBindingSha256": "d" * 64,
    "keyPolicySha256": "e" * 64,
    "servicePrincipals": {
        "producer": "spiffe://local.axiomproof.test/service/assessment-dispatch-producer",
        "controller": "spiffe://local.axiomproof.test/controller/assessment",
    },
}
TEXT = json.dumps(POLICY, sort_keys=True, separators=(",", ":"))
MANIFEST = {
    "policyText": TEXT,
    "policySha256": hashlib.sha256(TEXT.encode()).hexdigest(),
}


def value():
    return {
        "schemaVersion": 1,
        "environment": "local",
        "deployments": [
            {
                "alias": "playground-a",
                "tenantId": TENANT,
                "keyServicePort": 7450,
                "schedulerPort": 8190,
                "policySha256": MANIFEST["policySha256"],
                "deploymentBindingSha256": POLICY["deploymentBindingSha256"],
            }
        ],
    }


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="axiom-registry-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.directory.chmod(0o700)
        self.file = self.directory / "deployments.json"
        self.write(value())
        self.environment = patch.dict(
            os.environ,
            {
                registry.FILE_ENV: str(self.file),
                registry.SHA_ENV: hashlib.sha256(self.file.read_bytes()).hexdigest(),
            },
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def write(self, payload):
        self.file.write_text(json.dumps(payload))
        self.file.chmod(0o600)

    def test_non_demo_deployment_has_explicit_stable_ports_and_manifest_pins(self):
        self.assertEqual(registry.tenant_bindings(), {"playground-a": (TENANT, 7450)})
        self.assertEqual(registry.scheduler_port("playground-a"), 8190)
        self.assertEqual(registry.tenant_alias(TENANT), "playground-a")
        self.assertEqual(registry.validate_manifest("playground-a", MANIFEST), POLICY)
        with self.assertRaises(ValueError):
            registry.tenant_alias("ffffffff-ffff-4fff-8fff-ffffffffffff")

    def test_no_selected_registry_preserves_existing_deployments(self):
        with patch.dict(os.environ):
            os.environ.pop(registry.FILE_ENV)
            os.environ.pop(registry.SHA_ENV)
            self.assertEqual(
                registry.tenant_bindings(),
                {
                    "kosha": ("fd5e0001-0000-4000-8000-000000000001", 7443),
                    "sanjeevani": ("fd5e0002-0000-4000-8000-000000000002", 7444),
                    "nimbus": ("fd5e0003-0000-4000-8000-000000000003", 7445),
                },
            )
            self.assertEqual(
                [
                    registry.scheduler_port(alias)
                    for alias in registry.tenant_bindings()
                ],
                [8181, 8182, 8183],
            )

    def test_partial_selection_and_changed_bytes_never_fall_back(self):
        for missing in (registry.FILE_ENV, registry.SHA_ENV):
            with patch.dict(os.environ):
                os.environ.pop(missing)
                with self.assertRaises(ValueError):
                    registry.deployments()
        self.file.write_text(self.file.read_text() + "\n")
        with self.assertRaises(ValueError):
            registry.deployments()

    def test_public_file_or_directory_and_symlink_are_refused(self):
        self.file.chmod(0o644)
        with self.assertRaises(ValueError):
            registry.deployments()
        self.file.chmod(0o600)
        self.directory.chmod(0o755)
        with self.assertRaises(ValueError):
            registry.deployments()
        self.directory.chmod(0o700)
        link = self.directory / "linked.json"
        link.symlink_to(self.file)
        with (
            patch.dict(os.environ, {registry.FILE_ENV: str(link)}),
            self.assertRaises(OSError),
        ):
            registry.deployments()
        fifo = self.directory / "pipe"
        os.mkfifo(fifo, 0o600)
        with (
            patch.dict(os.environ, {registry.FILE_ENV: str(fifo)}),
            self.assertRaises(ValueError),
        ):
            registry.deployments()

    def test_registry_rejects_ambiguous_and_unbounded_bindings(self):
        for field, change in (
            ("alias", "../foreign"),
            ("alias", "UPPER"),
            ("tenantId", "00000000-0000-0000-0000-000000000000"),
            ("tenantId", TENANT.upper()),
            ("keyServicePort", True),
            ("keyServicePort", 1),
            ("schedulerPort", 7450),
            ("schedulerPort", 65536),
            ("policySha256", "unreviewed"),
            ("deploymentBindingSha256", ""),
        ):
            changed = value()
            changed["deployments"][0][field] = change
            with (
                self.subTest(field=field, change=change),
                self.assertRaises(ValueError),
            ):
                registry.parse_registry(json.dumps(changed).encode())
        for field, change in (
            ("schemaVersion", True),
            ("environment", "production"),
            ("deployments", []),
        ):
            changed = {**value(), field: change}
            with self.subTest(field=field), self.assertRaises(ValueError):
                registry.parse_registry(json.dumps(changed).encode())
        with self.assertRaises(ValueError):
            registry.parse_registry(b'{"schemaVersion":1,"schemaVersion":1}')
        with self.assertRaises(ValueError):
            registry.parse_registry(b" " * (registry.MAX_BYTES + 1))

    def test_duplicate_tenants_ports_aliases_and_unknown_fields_are_refused(self):
        first = value()["deployments"][0]
        for second in (
            first,
            {
                **first,
                "alias": "playground-b",
                "keyServicePort": 7451,
                "schedulerPort": 8191,
            },
            {
                **first,
                "alias": "playground-b",
                "tenantId": "ffffffff-ffff-4fff-8fff-ffffffffffff",
            },
            {**first, "unexpected": True},
        ):
            changed = value()
            changed["deployments"].append(second)
            with self.assertRaises(ValueError):
                registry.parse_registry(json.dumps(changed).encode())

    def test_existing_deployment_alias_identity_and_ports_cannot_be_rebound(self):
        row = value()["deployments"][0]
        for changed in (
            {**row, "alias": "kosha"},
            {**row, "tenantId": registry.LEGACY_DEPLOYMENTS["kosha"].tenant_id},
            {
                **row,
                "alias": "kosha",
                "tenantId": registry.LEGACY_DEPLOYMENTS["kosha"].tenant_id,
            },
        ):
            with self.assertRaises(ValueError):
                registry.parse_registry(
                    json.dumps({**value(), "deployments": [changed]}).encode()
                )

    def test_manifest_must_match_both_reviewed_policy_and_deployment_hashes(self):
        for change in (
            {**POLICY, "tenantId": "ffffffff-ffff-4fff-8fff-ffffffffffff"},
            {**POLICY, "deploymentBindingSha256": "f" * 64},
            {**POLICY, "targetWorkloadId": "ffffffff-ffff-4fff-8fff-ffffffffffff"},
        ):
            text = json.dumps(change)
            manifest = {
                "policyText": text,
                "policySha256": hashlib.sha256(text.encode()).hexdigest(),
            }
            with self.assertRaises(ValueError):
                registry.validate_manifest("playground-a", manifest)
        with self.assertRaises(ValueError):
            registry.validate_manifest(
                "playground-a", {**MANIFEST, "policySha256": "0" * 64}
            )

    def test_producer_and_controller_build_non_demo_pinned_configuration(self):
        producer = module("registry_producer", "local-assessment-producer.py")
        node = "spiffe://local.axiomproof.test/spire/agent/join_token/local"
        active = {
            **MANIFEST,
            "policyId": POLICY["policyId"],
            "tenantId": TENANT,
            "keyPolicySha256": POLICY["keyPolicySha256"],
            "epoch": 1,
            "activationEpoch": 1,
            "activationEventId": "ffffffff-ffff-4fff-8fff-ffffffffffff",
        }
        built, client = producer.build_config(
            [active], {"playground-a": MANIFEST}, node
        )
        self.assertEqual(client["tenantIds"], [TENANT])
        self.assertEqual(
            built["producer"]["tenants"][0]["keys"]["keyService"]["endpoint"]["port"],
            7450,
        )
        with patch.object(controller, "TENANTS", registry.tenant_bindings()):
            config = controller.build_configuration(
                "playground-a",
                active,
                MANIFEST,
                node,
                "sha256:" + "a" * 64,
                "axiom-proof-local-synthetic-a",
            )
        self.assertEqual(config["controller"]["tenantId"], TENANT)
        self.assertEqual(
            config["controller"]["keys"]["keyService"]["endpoint"]["port"], 7450
        )

    def test_key_service_and_due_credential_sync_accept_only_the_reviewed_alias(self):
        keys = module("registry_keys", "local-key-service.py")
        with (
            patch.object(keys, "bff_env", return_value="http://local.invalid"),
            patch.object(keys, "node_id", return_value="node"),
        ):
            config = keys.config("playground-a", MANIFEST, {})
        self.assertEqual(config["endpoint"], {"host": "127.0.0.1", "port": 7450})
        credentials = module("registry_credentials", "local-custody-credentials.py")
        with (
            patch.object(credentials, "ISSUER_ROOT", self.directory),
            patch.object(credentials, "due_kinds", return_value=["producer"]),
            patch.object(credentials, "issue") as issue,
            patch.object(credentials.subprocess, "run") as run,
        ):
            self.assertEqual(credentials.renew_due(TENANT, 1200), 0)
        issue.assert_called_once_with(TENANT, "producer", renew=True)
        self.assertEqual(run.call_args.args[0][-2:], ["--tenant", "playground-a"])
        image = "sha256:" + "a" * 64
        with (
            patch.object(credentials, "ISSUER_ROOT", self.directory),
            patch.object(credentials, "due_kinds", return_value=["producer"]),
            patch.object(credentials, "issue"),
            patch.object(credentials.subprocess, "run") as pinned,
        ):
            self.assertEqual(credentials.renew_due(TENANT, 1200, image), 0)
        self.assertEqual(
            pinned.call_args.args[0][-4:],
            ["--tenant", "playground-a", "--image", image],
        )
        with patch.object(credentials, "issue") as issue, self.assertRaises(ValueError):
            credentials.renew_due(None, 1200, image)
        issue.assert_not_called()

        with (
            patch.object(credentials, "active_policy") as active,
            self.assertRaises(ValueError),
        ):
            credentials.issue("ffffffff-ffff-4fff-8fff-ffffffffffff", "producer", False)
        active.assert_not_called()


if __name__ == "__main__":
    unittest.main()
