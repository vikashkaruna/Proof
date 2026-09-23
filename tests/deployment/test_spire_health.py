import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("spire_health", ROOT / "infra/workload/spire_health.py")
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)
NODE = "spiffe://health.axiomproof.test/spire/agent/gcp_iit/fixture-project/123"
NOW = 1800000000000


class SpireHealthTests(unittest.TestCase):
    def info(self, **values):
        return {"last_sync_success": str(NOW // 1000 - 2), "svid_chain": [{
            "id": {"trust_domain": "health.axiomproof.test", "path": "/spire/agent/gcp_iit/fixture-project/123"},
            "expires_at": str(NOW // 1000 + 300), "subject": "private subject must not be copied",
        }], **values}

    def test_projects_only_bound_metadata(self):
        value = health.snapshot(self.info(extra="private"), NODE, NOW)
        self.assertEqual(value, {"schemaVersion": 1, "healthy": True, "nodeId": NODE,
            "observedAtMs": NOW, "syncAtMs": NOW - 2000, "certificateExpiresAtMs": NOW + 300000})

    def test_stale_future_zero_or_noncanonical_sync(self):
        for value in [str(NOW // 1000 - 30), str(NOW // 1000 + 1), "0", "01", "1\n", 1800000000, True, None, "9" * 15]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                health.snapshot(self.info(last_sync_success=value), NODE, NOW)

    def test_wrong_node(self):
        with self.assertRaises(ValueError):
            health.snapshot(self.info(), NODE + "4", NOW)

    def test_expired_node(self):
        info = self.info(); info["svid_chain"][0]["expires_at"] = str(NOW // 1000)
        with self.assertRaises(ValueError):
            health.snapshot(info, NODE, NOW)

    def test_invalid_chain(self):
        for chain in (None, [], [None], [{}], [self.info()["svid_chain"][0]] * 9):
            with self.assertRaises(ValueError):
                health.snapshot(self.info(svid_chain=chain), NODE, NOW)

    def test_node_canonicalization(self):
        for value in (NODE + "\n", NODE.replace("spiffe:", "https:"), NODE.replace("/123", "/../123"), NODE.replace("health.", "Health."), NODE.replace("/123", "/%31")):
            with self.assertRaises(ValueError):
                health.node_id(value)

    def test_atomic_publication_permissions_and_replacement(self):
        with tempfile.TemporaryDirectory() as parent:
            directory = Path(parent).resolve() / "health"
            first = health.snapshot(self.info(), NODE, NOW)
            health.publish(first, directory)
            target = directory / "status.json"; inode = target.stat().st_ino
            self.assertEqual(target.stat().st_mode & 0o777, 0o644)
            self.assertEqual(directory.stat().st_mode & 0o777, 0o755)
            health.publish({"healthy": False}, directory)
            self.assertNotEqual(target.stat().st_ino, inode)
            self.assertEqual(json.loads(target.read_text()), {"healthy": False})
            self.assertEqual(len(list(directory.iterdir())), 1)

    def test_unsafe_directory_or_symlink_refused(self):
        with tempfile.TemporaryDirectory() as parent:
            directory = Path(parent).resolve() / "health"; directory.mkdir(); directory.chmod(0o777)
            with self.assertRaises(ValueError): health.publish({}, directory)
            directory.chmod(0o755)
            link = directory.parent / "link"; link.symlink_to(directory)
            with self.assertRaises(ValueError): health.publish({}, link)

    def test_failed_query_replaces_previous_health_with_denial(self):
        with patch.object(health, "query", side_effect=RuntimeError("private provider diagnostic")), patch.object(health, "publish") as publish:
            self.assertFalse(health.observe(NODE))
            value = publish.call_args.args[0]
            self.assertFalse(value["healthy"])
            self.assertEqual(set(value), {"schemaVersion", "healthy", "nodeId", "observedAtMs"})

    def test_oversized_or_stalled_provider_is_reaped(self):
        for command in (["/bin/sh", "-c", "head -c 70000 /dev/zero"], ["/bin/sleep", "5"]):
            with patch.object(health, "COMMAND", command), self.assertRaises(ValueError):
                health.query()


if __name__ == "__main__": unittest.main()
