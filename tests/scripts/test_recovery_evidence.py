"""Signed scheduled-backup and exact-version restore refusal tests."""

import hashlib
import hmac
import importlib.util
import io
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("recovery_evidence", ROOT / "scripts/recovery-evidence.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
KEY = "ab" * 32
NOW = datetime(2026, 10, 1, 12, tzinfo=timezone.utc)


class S3Fixture:
    def __init__(self):
        self.objects = {}
        self.lock_mode = "COMPLIANCE"

    def get_bucket_location(self, **_):
        return {"LocationConstraint": "ap-south-1"}

    def get_object_lock_configuration(self, **_):
        return {"ObjectLockConfiguration": {"ObjectLockEnabled": "Enabled", "Rule": {
            "DefaultRetention": {"Mode": self.lock_mode, "Years": 7}}}}

    def list_objects_v2(self, **_):
        return {"KeyCount": len(self.objects)}

    def list_object_versions(self, **_):
        return {"Versions": list(self.objects)}

    def put_object(self, **request):
        version = "restored-exact-version"
        self.objects[version] = request
        return {"VersionId": version}

    def head_object(self, **reference):
        request = self.objects[reference["VersionId"]]
        return {"VersionId": reference["VersionId"], "ContentLength": len(request["Body"]),
                "ServerSideEncryption": request["ServerSideEncryption"], "Metadata": request["Metadata"]}

    def get_object_retention(self, **reference):
        request = self.objects[reference["VersionId"]]
        return {"Retention": {"Mode": request["ObjectLockMode"],
                              "RetainUntilDate": request["ObjectLockRetainUntilDate"]}}

    def get_object_legal_hold(self, **reference):
        request = self.objects[reference["VersionId"]]
        return {"LegalHold": {"Status": request["ObjectLockLegalHoldStatus"]}}

    def get_object(self, **reference):
        return {"Body": io.BytesIO(self.objects[reference["VersionId"]]["Body"])}


class RecoveryEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="axiom-recovery-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.dump = self.root / "database.sql"
        self.dump.write_bytes(b"S" * 60000)
        self.evidence_root = self.root / "evidence"
        (self.evidence_root / "tenant").mkdir(parents=True)
        self.content = b"source-bound retained object"
        (self.evidence_root / "tenant" / "object.bin").write_bytes(self.content)
        self.manifest = self.root / "manifest.json"
        self.backup_at = NOW - timedelta(minutes=30)
        self.payload = {
            "schemaVersion": 1, "sourceDatabase": "axiom_onprem", "sourceBucket": "original-evidence",
            "backupAt": self.backup_at.isoformat(),
            "database": {"sha256": hashlib.sha256(self.dump.read_bytes()).hexdigest(),
                         "byteSize": self.dump.stat().st_size, "ledgerFingerprint": "5:" + "a" * 64,
                         "tableCount": 86, "rlsCount": 84},
            "evidence": [{"path": "tenant/object.bin", "key": "tenants/t1/evidence/object.bin",
                          "sourceVersionId": "original-v1", "sha256": hashlib.sha256(self.content).hexdigest(),
                          "byteSize": len(self.content),
                          "retainUntil": (NOW + timedelta(days=2555)).isoformat(),
                          "legalHold": True}],
        }
        self.env = patch.dict(os.environ, {
            "AXIOM_RECOVERY_MANIFEST_KEY": KEY,
            "AXIOM_RESTORE_S3_ENDPOINT": "http://minio:9000",
            "AXIOM_RESTORE_S3_BUCKET": "isolated-restore",
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.sign()

    def sign(self):
        wire = json.dumps(self.payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        signature = hmac.new(bytes.fromhex(KEY), wire, hashlib.sha256).hexdigest()
        self.manifest.write_text(json.dumps({**self.payload, "signature": signature}))
        self.manifest.chmod(0o600)

    def validate(self, incident=NOW):
        return MODULE.validate(self.manifest, self.dump, self.evidence_root,
                               "axiom_onprem", incident.isoformat(), now=NOW)

    def test_signed_schedule_and_exact_evidence_restore(self):
        result = self.validate()
        self.assertEqual((result["rpoSeconds"], result["evidenceCount"]), (1800, 1))
        rows = self.root / "rows.json"
        rows.write_text(json.dumps([{"bucket": "original-evidence", "key": self.payload["evidence"][0]["key"],
                                     "versionId": "original-v1", "sha256": self.payload["evidence"][0]["sha256"],
                                     "byteSize": len(self.content)}]))
        self.assertEqual(MODULE.check_inventory(self.manifest, rows), 1)
        s3 = S3Fixture()
        self.assertEqual(MODULE.restore_evidence(self.manifest, self.evidence_root, s3=s3, now=NOW), 1)
        self.assertEqual(s3.objects["restored-exact-version"]["Body"], self.content)
        self.assertEqual(s3.objects["restored-exact-version"]["ObjectLockLegalHoldStatus"], "ON")
        self.assertGreaterEqual(s3.objects["restored-exact-version"]["ObjectLockRetainUntilDate"],
                                NOW + timedelta(days=2557))

    def test_rejects_age_tamper_and_missing_evidence(self):
        self.payload["backupAt"] = (NOW - timedelta(minutes=61)).isoformat()
        self.sign()
        with self.assertRaisesRegex(ValueError, "one-hour RPO"):
            self.validate()
        self.payload["backupAt"] = self.backup_at.isoformat()
        self.sign()
        self.dump.write_bytes(b"T" * 60000)
        with self.assertRaisesRegex(ValueError, "Database backup bytes"):
            self.validate()
        self.dump.write_bytes(b"S" * 60000)
        (self.evidence_root / "tenant" / "object.bin").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "Evidence backup bytes"):
            self.validate()
        self.payload["evidence"] = []
        self.sign()
        with self.assertRaisesRegex(ValueError, "nonempty evidence inventory"):
            self.validate()
        self.payload["evidence"] = [{"path": "tenant/object.bin", "key": "tenants/t1/evidence/object.bin",
                                     "sourceVersionId": "null", "sha256": hashlib.sha256(self.content).hexdigest(),
                                     "byteSize": len(self.content),
                                     "retainUntil": (NOW + timedelta(days=2555)).isoformat(), "legalHold": True}]
        (self.evidence_root / "tenant" / "object.bin").write_bytes(self.content)
        self.sign()
        with self.assertRaisesRegex(ValueError, "identity is invalid"):
            self.validate()

    def test_rejects_manifest_signature_escape_and_inventory_gap(self):
        damaged = json.loads(self.manifest.read_text())
        damaged["database"]["tableCount"] = 87
        self.manifest.write_text(json.dumps(damaged))
        with self.assertRaisesRegex(ValueError, "signature mismatch"):
            self.validate()
        self.sign()
        self.payload["evidence"][0]["path"] = "../outside"
        self.sign()
        with self.assertRaisesRegex(ValueError, "escapes"):
            self.validate()
        self.payload["evidence"][0]["path"] = "tenant/object.bin"
        self.sign()
        rows = self.root / "rows.json"
        rows.write_text("[]")
        with self.assertRaisesRegex(ValueError, "does not cover every"):
            MODULE.check_inventory(self.manifest, rows)

    def test_rejects_unlocked_or_populated_restore_bucket(self):
        s3 = S3Fixture()
        s3.lock_mode = "GOVERNANCE"
        with self.assertRaisesRegex(ValueError, "Compliance lock"):
            MODULE.restore_evidence(self.manifest, self.evidence_root, s3=s3, now=NOW)
        s3.lock_mode = "COMPLIANCE"
        s3.get_object_lock_configuration = lambda **_: {"ObjectLockConfiguration": {
            "ObjectLockEnabled": "Enabled", "Rule": {"DefaultRetention": {
                "Mode": "COMPLIANCE", "Days": 2555}}}}
        with self.assertRaisesRegex(ValueError, "Compliance lock"):
            MODULE.restore_evidence(self.manifest, self.evidence_root, s3=s3, now=NOW)
        s3.get_object_lock_configuration = S3Fixture().get_object_lock_configuration
        s3.objects["old"] = {}
        with self.assertRaisesRegex(ValueError, "start empty"):
            MODULE.restore_evidence(self.manifest, self.evidence_root, s3=s3, now=NOW)
        s3.objects.clear()
        s3.list_object_versions = lambda **_: {"DeleteMarkers": [{"VersionId": "hidden-old"}]}
        with self.assertRaisesRegex(ValueError, "start empty"):
            MODULE.restore_evidence(self.manifest, self.evidence_root, s3=s3, now=NOW)

    def test_rejects_legal_hold_readback_mismatch(self):
        s3 = S3Fixture()
        s3.get_object_legal_hold = lambda **_: {"LegalHold": {"Status": "OFF"}}
        with self.assertRaisesRegex(ValueError, "failed readback"):
            MODULE.restore_evidence(self.manifest, self.evidence_root, s3=s3, now=NOW)


if __name__ == "__main__":
    unittest.main()
