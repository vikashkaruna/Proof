"""Pure launch/config tests; Docker/database are always mocked."""

import copy
import hashlib
import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "axiom_local_assessment_producer", ROOT / "scripts/local-assessment-producer.py"
)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)
NODE = "spiffe://local.axiomproof.test/spire/agent/join_token/local"
IMAGE = "sha256:" + "a" * 64


def fixture():
    manifests, rows = {}, []
    for index, (slug, (tenant, _)) in enumerate(launcher.TENANTS.items(), 1):
        policy = {
            "policyId": f"15150000-0000-4000-8000-{index:012d}",
            "tenantId": tenant,
            "targetWorkloadId": f"25250000-0000-4000-8000-{index:012d}",
            "keyPolicySha256": "b" * 64,
            "deploymentBindingSha256": "c" * 64,
            "servicePrincipals": {
                "producer": f"spiffe://{launcher.DOMAIN}/service/assessment-dispatch-producer",
                "controller": f"spiffe://{launcher.DOMAIN}/controller/assessment",
            },
        }
        text = json.dumps(policy, separators=(",", ":"), sort_keys=True)
        digest = hashlib.sha256(text.encode()).hexdigest()
        manifests[slug] = {"policyText": text, "policySha256": digest}
        rows.append(
            {
                "tenantId": tenant,
                "policyId": policy["policyId"],
                "policyText": text,
                "policySha256": digest,
                "keyPolicySha256": policy["keyPolicySha256"],
                "activationEventId": f"35350000-0000-4000-8000-{index:012d}",
                "activationEpoch": index,
            }
        )
    return rows, manifests


def result(args=(), stdout="", returncode=0):
    return subprocess.CompletedProcess(args, returncode, stdout, "private-error-marker")


class ProducerConfigTests(unittest.TestCase):
    def test_exact_active_policy_pins_and_tenant_ports(self):
        rows, manifests = fixture()
        producer, client = launcher.build_config(rows, manifests, NODE)
        self.assertEqual(
            producer["socket"], {"directory": launcher.SOCKET, "socketGroup": 20110}
        )
        self.assertEqual(client["producerUid"], 20102)
        self.assertEqual(client["socketPath"], "/run/axiom-producer/producer.sock")
        for entry, row, (_, port) in zip(
            producer["producer"]["tenants"], rows, launcher.TENANTS.values()
        ):
            self.assertEqual(
                entry["keys"]["custody"]["activationEventId"], row["activationEventId"]
            )
            self.assertEqual(
                entry["keys"]["custody"]["activationEpoch"], row["activationEpoch"]
            )
            self.assertEqual(
                entry["keys"]["custody"]["custodyPolicySha256"], row["policySha256"]
            )
            self.assertEqual(
                entry["keys"]["keyService"]["endpoint"],
                {"host": "127.0.0.1", "port": port},
            )
            self.assertEqual(entry["keys"]["workload"]["issuerNodeId"], NODE)
        self.assertEqual(client["tenantIds"], [row["tenantId"] for row in rows])

    def test_refuses_missing_or_duplicate_active_tenant(self):
        rows, manifests = fixture()
        for changed in (rows[:-1], rows + rows[:1], [rows[0], rows[0], rows[2]]):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                launcher.build_config(changed, manifests, NODE)

    def test_refuses_manifest_or_database_tampering(self):
        rows, manifests = fixture()
        for field, value in (
            ("policyText", "{}"),
            ("policySha256", "0" * 64),
            ("keyPolicySha256", "0" * 64),
            ("activationEpoch", 0),
            ("activationEpoch", True),
            ("activationEventId", "not-uuid"),
        ):
            changed = copy.deepcopy(rows)
            changed[0][field] = value
            with self.subTest(field=field), self.assertRaises((ValueError, KeyError)):
                launcher.build_config(changed, manifests, NODE)
        manifests["kosha"]["policySha256"] = "0" * 64
        with self.assertRaises(ValueError):
            launcher.build_config(rows, manifests, NODE)

    def test_refuses_issuer_from_other_trust_domain(self):
        rows, manifests = fixture()
        with self.assertRaises(ValueError):
            launcher.build_config(
                rows, manifests, NODE.replace("local.axiomproof.test", "other.test")
            )

    def test_database_read_is_enforced_read_only(self):
        rows, _ = fixture()
        with patch.object(
            launcher, "run", return_value=result(stdout=json.dumps(rows))
        ) as execute:
            self.assertEqual(launcher.active_policies(), rows)
        args = execute.call_args.args[0]
        self.assertIn("PGOPTIONS=-c default_transaction_read_only=on", args)
        sql = execute.call_args.kwargs["input"]
        self.assertIn("a.transition='activate'", sql)
        self.assertIn("a.activation_epoch=h.activation_epoch", sql)
        self.assertNotIn("update ", sql.lower())

    def test_backend_reads_secrets_only_into_protected_file_model(self):
        mapping = {
            "SUPABASE_URL": "http://host.docker.internal:57121",
            "SUPABASE_ANON_KEY": "a" * 64,
            "SUPABASE_SERVICE_KEY": "b" * 64,
            "SUPABASE_HUMAN_ACTION_WRITER_KEY": "c" * 64,
            "SUPABASE_CONTROLLER_KEY": "never-copied",
        }
        with patch.object(
            launcher,
            "run",
            return_value=result(
                stdout=json.dumps([f"{key}={value}" for key, value in mapping.items()])
            ),
        ):
            backend = launcher.backend_config()
        self.assertEqual(
            set(backend), {"url", "anonKey", "serviceKey", "humanWriterKey"}
        )
        self.assertNotIn("never-copied", json.dumps(backend))


class ProducerLaunchTests(unittest.TestCase):
    def test_serving_is_hardened_and_secrets_are_not_environment(self):
        args = launcher.container_args("serve", IMAGE)
        self.assertEqual(args[:4], ["docker", "run", "--pull", "never"])
        self.assertIn("20102:20102", args)
        self.assertEqual(args[args.index("--group-add") + 1], "20110")
        self.assertIn("container:axiom-bff", args)
        self.assertNotIn("--add-host", args)
        self.assertNotIn("--dns", args)
        self.assertIn("--read-only", args)
        self.assertIn("no-new-privileges:true", args)
        self.assertEqual(args[args.index("--cap-drop") + 1], "ALL")
        self.assertNotIn("--cap-add", args)
        self.assertNotIn("-e", args)
        self.assertNotIn("--env-file", args)
        self.assertIn(
            f"type=volume,src={launcher.CONF_VOLUME},dst={launcher.CONF},readonly", args
        )
        self.assertIn(
            f"type=volume,src={launcher.SOCKET_VOLUME},dst={launcher.SOCKET}", args
        )
        self.assertNotIn("/var/run/docker.sock", " ".join(args))
        self.assertEqual(args[-2:], ["--serve", f"{launcher.CONF}/config.json"])
        self.assertIn("/sbin/tini", args)

    def test_check_is_ephemeral_and_cannot_replace_service(self):
        args = launcher.container_args("check", IMAGE)
        self.assertIn("--rm", args)
        self.assertNotIn("--name", args)
        self.assertNotIn("--restart", args)
        self.assertIn("--check", args)
        with (
            patch.object(launcher, "reviewed_image", return_value=IMAGE),
            patch.object(launcher, "remove_owned") as remove,
            patch.object(launcher, "run", return_value=result()),
            patch("builtins.print"),
        ):
            launcher.container("check", None)
        remove.assert_not_called()

    def test_only_labelled_launcher_names_can_be_removed(self):
        with patch.object(
            launcher,
            "run",
            return_value=result(
                stdout=json.dumps(
                    [{"Config": {"Labels": {"axiom.purpose": "somebody-else"}}}]
                )
            ),
        ):
            with self.assertRaises(ValueError):
                launcher.remove_owned(launcher.NAME)
        with patch.object(launcher, "run") as execute:
            with self.assertRaises(ValueError):
                launcher.remove_owned("axiom-bff")
        execute.assert_not_called()

    def test_existing_foreign_volume_cannot_be_reused(self):
        with patch.object(
            launcher,
            "run",
            return_value=result(
                stdout=json.dumps([{"Labels": {"axiom.purpose": "foreign"}}])
            ),
        ) as execute:
            with self.assertRaises(ValueError):
                launcher.ensure_volume(launcher.CONF_VOLUME)
        self.assertEqual(execute.call_count, 1)

    def test_image_is_resolved_immutably_before_service_replacement(self):
        with patch.object(
            launcher, "run", return_value=result(stdout=IMAGE)
        ) as execute:
            self.assertEqual(launcher.reviewed_image(None), IMAGE)
        self.assertEqual(
            execute.call_args_list[0].args[0],
            ["docker", "inspect", "axiom-bff", "--format", "{{.Image}}"],
        )
        self.assertEqual(
            execute.call_args_list[1].args[0],
            ["docker", "image", "inspect", IMAGE, "--format", "{{.Id}}"],
        )
        with patch.object(launcher, "run") as execute:
            for image in ("-danger", "image with space", ""):
                with self.assertRaises(ValueError):
                    launcher.reviewed_image(image)
            execute.assert_not_called()

    def test_stage_refuses_running_producer_before_any_writes(self):
        with (
            patch.object(
                launcher, "owned_container", return_value={"State": {"Running": True}}
            ),
            patch.object(launcher, "run") as execute,
        ):
            with self.assertRaises(ValueError):
                launcher.stage()
        execute.assert_not_called()

    def test_stage_files_are_0600_and_backend_never_enters_argv_or_logs(self):
        rows, manifests = fixture()
        secret = "private-backend-marker"
        copies = []
        commands = []

        def execute(args, **kwargs):
            commands.append(args)
            if args[:3] == ["docker", "volume", "inspect"]:
                return result(returncode=1)
            if args[:3] == ["docker", "exec", "axiom-spire"]:
                return result(stdout=NODE)
            if args[:2] == ["docker", "cp"]:
                local = Path(args[3])
                self.assertEqual(local.stat().st_mode & 0o777, 0o600)
                copies.append((local, local.read_text()))
            return result()

        with (
            patch.object(launcher, "owned_container", return_value=None),
            patch.object(launcher, "remove_owned"),
            patch.object(launcher, "active_policies", return_value=rows),
            patch.object(
                launcher, "read_manifest", side_effect=lambda slug: manifests[slug]
            ),
            patch.object(
                launcher, "backend_config", return_value={"serviceKey": secret}
            ),
            patch.object(launcher, "run", side_effect=execute),
            patch("builtins.print") as output,
        ):
            launcher.stage()
        self.assertEqual(len(copies), 3)
        self.assertTrue(any(secret in text for _, text in copies))
        self.assertTrue(all(not path.exists() for path, _ in copies))
        self.assertNotIn(secret, str(commands))
        self.assertNotIn(secret, str(output.call_args_list))
        helper = next(args for args in commands if args[:2] == ["docker", "create"])
        self.assertIn("none", helper)
        self.assertIn("chmod 0600", helper[-1])

    def test_cli_sanitizes_failures(self):
        with (
            patch.object(sys, "argv", ["launcher", "stage"]),
            patch.object(
                launcher, "stage", side_effect=RuntimeError("private-secret-marker")
            ),
            patch("builtins.print") as output,
        ):
            with self.assertRaises(SystemExit) as refusal:
                launcher.main()
        self.assertEqual(refusal.exception.code, 1)
        self.assertNotIn("private-secret-marker", str(output.call_args_list))


if __name__ == "__main__":
    unittest.main()
