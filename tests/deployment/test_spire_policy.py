"""Deployment policy refuses broadened node/image authority before rendering."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from lib.spire_deployment import deployment_bundle  # noqa: E402


class SpirePolicyTests(unittest.TestCase):
    def setUp(self):
        self.policy = json.loads((ROOT / "infra/workload/spire-policy.example.json").read_text())

    def reject(self, field, values):
        for value in values:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                deployment_bundle({**self.policy, field: value})

    def test_exact_parent_and_both_selectors(self):
        bundle = deployment_bundle(self.policy)
        commands = json.loads(bundle["registration-argv.json"])
        self.assertEqual(len(commands), 2)
        for command, uid, field in zip(commands, (20000, 20003), ("controllerImageConfigDigest", "assessmentImageConfigDigest")):
            self.assertEqual(command[command.index("-parentID") + 1], "spiffe://preprod.axiomproof.test/spire/agent/gcp_iit/replace-project/1")
            selectors = [command[i + 1] for i, arg in enumerate(command) if arg == "-selector"]
            self.assertEqual(selectors, [f"unix:uid:{uid}", f"docker:image_config_digest:{self.policy[field]}"])
            self.assertNotIn("-admin", command)
            self.assertNotIn("-node", command)
            self.assertNotIn("-downstream", command)

    def test_instance_replacement_changes_all_parents(self):
        commands = json.loads(deployment_bundle({**self.policy, "runnerInstanceId": "2"})["registration-argv.json"])
        self.assertTrue(all(c[c.index("-parentID") + 1].endswith("/2") for c in commands))

    def test_strict_manifest(self):
        for value in (None, [], {**self.policy, "joinToken": "unused"}, {**self.policy, "schemaVersion": True}, {**self.policy, "schemaVersion": 2}):
            with self.assertRaises(ValueError):
                deployment_bundle(value)
        for key in self.policy:
            with self.assertRaises(ValueError):
                deployment_bundle({k: v for k, v in self.policy.items() if k != key})

    def test_trust_domain_injection(self):
        self.reject("trustDomain", ["Mixed.example", "../node", "x\n", 'x"\nplugins {}', "x..y", "-x.y", "x-.y", "a" * 64 + ".test", "x." ])

    def test_project_is_canonical(self):
        self.reject("projectId", ["short", "project-x\n", "../project-x", "Project-x", "project-x-", 123, "a" * 31])

    def test_instance_is_immutable_numeric_id(self):
        self.reject("runnerInstanceId", ["vm-name", "0", "01", "-1", "1\n", str(2**64), 1])

    def test_only_private_ipv4_issuer(self):
        self.reject("issuerPrivateIp", ["127.0.0.1", "169.254.169.254", "100.64.0.1", "8.8.8.8", "::1", "issuer.example", "10.1.1.1\n", "10.001.1.1", "10.1.1.999"])

    def test_digest_is_not_tag_or_registry_manifest(self):
        for field in ("controllerImageConfigDigest", "assessmentImageConfigDigest"):
            self.reject(field, ["image:latest", "registry/image@sha256:" + "a" * 64, "sha256:" + "A" * 64, "sha256:" + "a" * 63, self.policy[field] + "\n"])

    def test_persistent_keys_and_secure_bootstrap(self):
        bundle = deployment_bundle(self.policy)
        self.assertIn('keys_path = "/var/lib/spire/server/keys.json"', bundle["server.conf"])
        for text in ('directory = "/var/lib/spire/agent"', 'rebootstrap_mode = "never"', 'insecure_bootstrap = false', 'allow_unauthenticated_verifiers = false', 'log_selectors = []', 'trust_bundle_path = "/etc/axiom/spire/bootstrap.pem"'):
            self.assertIn(text, bundle["agent.conf"])
        for content in (bundle["server.conf"], bundle["agent.conf"]):
            self.assertNotIn("join_token", content)
            self.assertNotIn("authorized_delegates", content)
            self.assertNotIn("service_account_file", content)

    def test_cli_refuses_duplicate_keys_without_output(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "policy.json"
            target = Path(directory) / "bundle"
            source.write_text(json.dumps(self.policy)[:-1] + ', "schemaVersion": 1}')
            result = subprocess.run([sys.executable, str(ROOT / "scripts/prepare-workload-spire.py"), str(source), str(target)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stderr, b"SPIRE review bundle preparation refused.\n")
            self.assertFalse(target.exists())

    def test_cli_never_overwrites_reviewed_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "policy.json"
            target = Path(directory) / "bundle"
            source.write_text(json.dumps(self.policy))
            command = [sys.executable, str(ROOT / "scripts/prepare-workload-spire.py"), str(source), str(target)]
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
            snapshot = {p.name: p.read_bytes() for p in target.iterdir()}
            source.write_text(json.dumps({**self.policy, "runnerInstanceId": "2"}))
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            self.assertEqual({p.name: p.read_bytes() for p in target.iterdir()}, snapshot)
            self.assertEqual(target.stat().st_mode & 0o777, 0o700)
            self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in target.iterdir()))


if __name__ == "__main__":
    unittest.main()
