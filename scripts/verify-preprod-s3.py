#!/usr/bin/env python3
# ruff: noqa: EXE001 - invoked explicitly with python3; preserve non-executable mode.
"""Read-only Mumbai S3 check; production alone requires seven-year Compliance."""

from __future__ import annotations

import json
import os
import re
import subprocess  # nosec B404
import sys
from datetime import datetime, timedelta, timezone


def production_verification(values: dict[str, str]) -> bool:
    environment = values.get("ENVIRONMENT", "")
    if environment in {"production", "prod"}:
        production = True
    elif environment in {
        "preprod",
        "local",
        "staging",
        "test",
        "development",
        "onprem",
    }:
        production = False
    else:
        raise ValueError("an explicit known deployment ENVIRONMENT is required")
    expected = "production_compliance" if production else "nonprod_readback"
    if values.get("AXIOM_EVIDENCE_VERIFICATION_MODE", expected) != expected:
        raise ValueError(
            "evidence verification mode disagrees with deployment ENVIRONMENT"
        )
    return production


def verify(
    values: dict[str, str], run=subprocess.run, now: datetime | None = None
) -> None:
    production = production_verification(values)
    bucket = values.get("AXIOM_EVIDENCE_BUCKET", "")
    key = values.get("AXIOM_EVIDENCE_PROBE_KEY", "")
    version = values.get("AXIOM_EVIDENCE_PROBE_VERSION_ID", "")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket):
        raise ValueError("approved S3 bucket is required")
    if values.get("AXIOM_STORAGE_ENDPOINT") != "https://s3.ap-south-1.amazonaws.com":
        raise ValueError("evidence endpoint must be AWS S3 ap-south-1")
    prefixes = (
        ("axiom-compliance-probe/",)
        if production
        else ("axiom-compliance-probe/", "axiom-storage-probe/")
    )
    if not key.startswith(prefixes) or not version or len(version) > 256:
        raise ValueError("synthetic probe key and exact version are required")
    access = values.get("AXIOM_STORAGE_ACCESS_KEY_ID", "")
    secret = values.get("AXIOM_STORAGE_SECRET_ACCESS_KEY", "")
    if len(access) < 16 or len(secret) < 32:
        raise ValueError("application S3 credentials are required for readback")
    env = {
        **os.environ,
        "AWS_ACCESS_KEY_ID": access,
        "AWS_SECRET_ACCESS_KEY": secret,
        "AWS_DEFAULT_REGION": "ap-south-1",
    }

    def query(operation: str, *options: str) -> dict:
        result = run(
            [
                "aws",
                "s3api",
                operation,
                "--bucket",
                bucket,
                *options,
                "--region",
                "ap-south-1",
                "--output",
                "json",
            ],
            env=env,
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise ValueError(f"S3 {operation} readback failed")
        payload = json.loads(result.stdout)
        if not isinstance(payload, dict):
            raise TypeError("S3 readback returned an invalid response")
        return payload

    if query("get-bucket-location").get("LocationConstraint") != "ap-south-1":
        raise ValueError("evidence bucket is outside ap-south-1")
    if production:
        lock = query("get-object-lock-configuration").get("ObjectLockConfiguration", {})
        retention = lock.get("Rule", {}).get("DefaultRetention", {})
        if (
            lock.get("ObjectLockEnabled") != "Enabled"
            or retention.get("Mode") != "COMPLIANCE"
        ):
            raise ValueError("S3 Object Lock Compliance default is required")
        if retention.get("Years", 0) < 7 and retention.get("Days", 0) < 2555:
            raise ValueError("S3 Compliance default must retain for seven years")
    options = ("--key", key, "--version-id", version)
    object_info = query("head-object", *options)
    if (
        object_info.get("VersionId") != version
        or object_info.get("ContentLength", 0) <= 0
    ):
        raise ValueError("retained probe version is unavailable")
    if not production:
        # Read a bounded synthetic byte using the application credentials. No
        # retention configuration, creation, locking or deletion is attempted.
        readable = query("get-object", *options, "--range", "bytes=0-0", os.devnull)
        if readable.get("VersionId") != version or readable.get("ContentLength") != 1:
            raise ValueError("exact synthetic probe version is not readable")
        return
    object_retention = query("get-object-retention", *options).get("Retention", {})
    if object_retention.get("Mode") != "COMPLIANCE":
        raise ValueError("probe version is not Compliance locked")
    retain_until = datetime.fromisoformat(
        object_retention["RetainUntilDate"].replace("Z", "+00:00")
    )
    current = now or datetime.now(timezone.utc)
    if retain_until < current + timedelta(days=2554):
        raise ValueError("probe version does not demonstrate seven-year retention")


if __name__ == "__main__":
    try:
        verify(dict(os.environ))
    except (
        ValueError,
        TypeError,
        KeyError,
        json.JSONDecodeError,
        FileNotFoundError,
    ) as exc:
        print(f"Environment-specific S3 verification failed: {exc}", file=sys.stderr)
        sys.exit(1)
    if production_verification(dict(os.environ)):
        print(
            "Production S3 Compliance bucket and exact seven-year probe version verified in ap-south-1"
        )
    else:
        print(
            "Nonproduction S3 exact synthetic version read access verified in ap-south-1; retention not required"
        )
