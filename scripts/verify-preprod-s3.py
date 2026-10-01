#!/usr/bin/env python3
"""Fail-closed live S3 Compliance readback before any preprod cloud change."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone


def verify(values: dict[str, str], run=subprocess.run, now: datetime | None = None) -> None:
    bucket = values.get("AXIOM_EVIDENCE_BUCKET", "")
    key = values.get("AXIOM_EVIDENCE_PROBE_KEY", "")
    version = values.get("AXIOM_EVIDENCE_PROBE_VERSION_ID", "")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket):
        raise ValueError("approved S3 bucket is required")
    if values.get("AXIOM_STORAGE_ENDPOINT") != "https://s3.ap-south-1.amazonaws.com":
        raise ValueError("evidence endpoint must be AWS S3 ap-south-1")
    if not key.startswith("axiom-compliance-probe/") or not version or len(version) > 256:
        raise ValueError("retained synthetic probe key and exact version are required")
    access = values.get("AXIOM_STORAGE_ACCESS_KEY_ID", "")
    secret = values.get("AXIOM_STORAGE_SECRET_ACCESS_KEY", "")
    if len(access) < 16 or len(secret) < 32:
        raise ValueError("application S3 credentials are required for readback")
    env = {**os.environ, "AWS_ACCESS_KEY_ID": access, "AWS_SECRET_ACCESS_KEY": secret,
           "AWS_DEFAULT_REGION": "ap-south-1"}

    def query(operation: str, *options: str) -> dict:
        result = run(["aws", "s3api", operation, "--bucket", bucket, *options,
                      "--region", "ap-south-1", "--output", "json"],
                     env=env, check=False, capture_output=True, text=True)
        if result.returncode != 0:
            raise ValueError(f"S3 {operation} readback failed")
        return json.loads(result.stdout)

    if query("get-bucket-location").get("LocationConstraint") != "ap-south-1":
        raise ValueError("evidence bucket is outside ap-south-1")
    lock = query("get-object-lock-configuration").get("ObjectLockConfiguration", {})
    retention = lock.get("Rule", {}).get("DefaultRetention", {})
    if lock.get("ObjectLockEnabled") != "Enabled" or retention.get("Mode") != "COMPLIANCE":
        raise ValueError("S3 Object Lock Compliance default is required")
    if retention.get("Years", 0) < 7 and retention.get("Days", 0) < 2555:
        raise ValueError("S3 Compliance default must retain for seven years")
    options = ("--key", key, "--version-id", version)
    object_info = query("head-object", *options)
    if object_info.get("VersionId") != version or object_info.get("ContentLength", 0) <= 0:
        raise ValueError("retained probe version is unavailable")
    object_retention = query("get-object-retention", *options).get("Retention", {})
    if object_retention.get("Mode") != "COMPLIANCE":
        raise ValueError("probe version is not Compliance locked")
    retain_until = datetime.fromisoformat(object_retention["RetainUntilDate"].replace("Z", "+00:00"))
    current = now or datetime.now(timezone.utc)
    if retain_until < current + timedelta(days=2554):
        raise ValueError("probe version does not demonstrate seven-year retention")


if __name__ == "__main__":
    try:
        verify(dict(os.environ))
    except (ValueError, KeyError, json.JSONDecodeError, FileNotFoundError) as exc:
        print(f"Preprod S3 Compliance gate failed: {exc}", file=sys.stderr)
        sys.exit(1)
    print("Preprod S3 Compliance bucket and exact probe version verified in ap-south-1")
