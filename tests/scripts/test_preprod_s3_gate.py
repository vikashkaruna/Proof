"""Live S3 gate tests with a simulated AWS CLI, never touching cloud."""

import importlib.util
import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("s3_gate", ROOT / "scripts/verify-preprod-s3.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PreprodS3GateTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime.now(timezone.utc)
        self.values = {
            "AXIOM_EVIDENCE_BUCKET": "axiom-proof-evidence-preprod",
            "AXIOM_STORAGE_ENDPOINT": "https://s3.ap-south-1.amazonaws.com",
            "AXIOM_EVIDENCE_PROBE_KEY": "axiom-compliance-probe/synthetic.txt",
            "AXIOM_EVIDENCE_PROBE_VERSION_ID": "version-1",
            "AXIOM_STORAGE_ACCESS_KEY_ID": "A" * 20,
            "AXIOM_STORAGE_SECRET_ACCESS_KEY": "b" * 40,
        }
        self.responses = {
            "get-bucket-location": {"LocationConstraint": "ap-south-1"},
            "get-object-lock-configuration": {"ObjectLockConfiguration": {"ObjectLockEnabled": "Enabled", "Rule": {"DefaultRetention": {"Mode": "COMPLIANCE", "Years": 7}}}},
            "head-object": {"VersionId": "version-1", "ContentLength": 16},
            "get-object-retention": {"Retention": {"Mode": "COMPLIANCE", "RetainUntilDate": (self.now + timedelta(days=2556)).isoformat()}},
        }

    def run_cli(self, args, **kwargs):
        self.assertEqual(args[:2], ["aws", "s3api"])
        self.assertEqual(args[args.index("--region") + 1], "ap-south-1")
        self.assertEqual(kwargs["env"]["AWS_ACCESS_KEY_ID"], "A" * 20)
        return SimpleNamespace(returncode=0, stdout=json.dumps(self.responses[args[2]]))

    def check(self):
        MODULE.verify(self.values, run=self.run_cli, now=self.now)

    def test_compliance_bucket_and_exact_version_pass(self):
        self.check()

    def test_refuses_unlocked_short_retention_wrong_region_and_missing_version(self):
        changes = [
            ("get-object-lock-configuration", "ObjectLockConfiguration", "ObjectLockEnabled", "Disabled"),
            ("get-bucket-location", None, "LocationConstraint", "us-east-1"),
            ("head-object", None, "VersionId", "other"),
        ]
        for operation, parent, field, value in changes:
            with self.subTest(operation=operation):
                target = self.responses[operation] if parent is None else self.responses[operation][parent]
                original = target[field]
                target[field] = value
                with self.assertRaises(ValueError):
                    self.check()
                target[field] = original
        self.responses["get-object-lock-configuration"]["ObjectLockConfiguration"]["Rule"]["DefaultRetention"]["Years"] = 1
        with self.assertRaisesRegex(ValueError, "seven years"):
            self.check()

    def test_refuses_gcs_endpoint_and_absent_app_credentials_before_cli(self):
        self.values["AXIOM_STORAGE_ENDPOINT"] = "https://storage.googleapis.com"
        with self.assertRaisesRegex(ValueError, "AWS S3"):
            self.check()
        self.values["AXIOM_STORAGE_ENDPOINT"] = "https://s3.ap-south-1.amazonaws.com"
        self.values["AXIOM_STORAGE_SECRET_ACCESS_KEY"] = ""
        with self.assertRaisesRegex(ValueError, "credentials"):
            self.check()


if __name__ == "__main__":
    unittest.main()
