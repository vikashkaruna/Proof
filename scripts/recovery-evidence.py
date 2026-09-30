#!/usr/bin/env python3
"""Verify a signed scheduled backup, then restore exact evidence bytes to WORM.

The backup scheduler must produce the signed manifest at backup time. This
consumer never manufactures a backup timestamp or treats a fresh dump as RPO.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import stat
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HASH = re.compile(r"[0-9a-f]{64}\Z")
DB_NAME = re.compile(r"[a-z][a-z0-9_]{0,62}\Z")
# Seven calendar years contain at most two leap days. A conservative fixed
# duration avoids shortening retention when the original is re-sealed.
MIN_COMPLIANCE_DAYS = 2557


def timestamp(value: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError("Timestamp must be an ISO-8601 string")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timestamp must carry an offset")
    return parsed.astimezone(timezone.utc)


def private_file(path: Path) -> None:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise ValueError("Protected recovery input must be a private regular file")


def digest_file(path: Path) -> tuple[str, int]:
    if path.is_symlink() or not path.is_file():
        raise ValueError("Backup artifact must be a regular non-symlink file")
    h = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size


def artifact(root: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative or relative.startswith("/"):
        raise ValueError("Evidence artifact path must be relative")
    pieces = Path(relative).parts
    if any(part in (".", "..") for part in pieces):
        raise ValueError("Evidence artifact path escapes its backup root")
    path = root.joinpath(*pieces)
    if path.resolve().is_relative_to(root.resolve()) is False:
        raise ValueError("Evidence artifact path escapes its backup root")
    return path


def load_manifest(path: Path) -> dict:
    private_file(path)
    data = json.loads(path.read_text())
    if not isinstance(data, dict) or set(data) != {
        "schemaVersion", "sourceDatabase", "sourceBucket", "backupAt",
        "database", "evidence", "signature",
    } or data["schemaVersion"] != 1:
        raise ValueError("Unsupported recovery manifest")
    key = os.environ.get("AXIOM_RECOVERY_MANIFEST_KEY", "")
    if not HASH.fullmatch(key):
        raise ValueError("A distinct 64-hex backup manifest key is required")
    signature = data.pop("signature")
    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    expected = hmac.new(bytes.fromhex(key), canonical, hashlib.sha256).hexdigest()
    if not isinstance(signature, str) or not hmac.compare_digest(signature, expected):
        raise ValueError("Recovery manifest signature mismatch")
    if not DB_NAME.fullmatch(data["sourceDatabase"]) or data["sourceDatabase"] == "postgres":
        raise ValueError("Manifest names no Axiom application database")
    if not isinstance(data["sourceBucket"], str) or not data["sourceBucket"]:
        raise ValueError("Manifest source bucket is missing")
    return data


def validate_recovery_credentials(path: Path) -> None:
    private_file(path)
    required = {"AXIOM_STORAGE_ACCESS_KEY_ID", "AXIOM_STORAGE_SECRET_ACCESS_KEY",
                "AXIOM_RECOVERY_STORAGE_ACCESS_KEY_ID", "AXIOM_RECOVERY_STORAGE_SECRET_ACCESS_KEY"}
    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        name, separator, value = line.partition("=")
        if name in values or not separator:
            raise ValueError("Recovery environment has duplicate or malformed entries")
        if name in required:
            values[name] = value
    if (set(values) != required
            or any(not re.fullmatch(r"[A-Za-z0-9/+_=.-]+", value) for value in values.values())
            or len(values["AXIOM_RECOVERY_STORAGE_ACCESS_KEY_ID"]) < 16
            or len(values["AXIOM_RECOVERY_STORAGE_SECRET_ACCESS_KEY"]) < 32):
        raise ValueError("A distinct scoped recovery storage credential is required")
    if (hmac.compare_digest(values["AXIOM_STORAGE_ACCESS_KEY_ID"],
                            values["AXIOM_RECOVERY_STORAGE_ACCESS_KEY_ID"])
            or hmac.compare_digest(values["AXIOM_STORAGE_SECRET_ACCESS_KEY"],
                                   values["AXIOM_RECOVERY_STORAGE_SECRET_ACCESS_KEY"])):
        raise ValueError("Recovery storage credential must differ from the application root credential")


def validate(path: Path, dump: Path, root: Path, source_db: str, incident_at: str,
             now: datetime | None = None) -> dict:
    data = load_manifest(path)
    if data["sourceDatabase"] != source_db:
        raise ValueError("Manifest database differs from exact restore target")
    backup = timestamp(data["backupAt"])
    incident = timestamp(incident_at)
    current = now or datetime.now(timezone.utc)
    if backup > incident or incident > current + timedelta(minutes=5):
        raise ValueError("Backup and incident chronology is invalid")
    rpo = (incident - backup).total_seconds()
    if rpo > 3600:
        raise ValueError("Scheduled backup exceeds the one-hour RPO")
    database = data["database"]
    if not isinstance(database, dict) or set(database) != {
        "sha256", "byteSize", "ledgerFingerprint", "tableCount", "rlsCount"
    }:
        raise ValueError("Database backup inventory is incomplete")
    actual_hash, actual_size = digest_file(dump)
    if actual_size < 50000 or actual_hash != database["sha256"] or actual_size != database["byteSize"]:
        raise ValueError("Database backup bytes do not match signed inventory")
    if (not isinstance(database["tableCount"], int) or database["tableCount"] < 80
            or not isinstance(database["rlsCount"], int) or database["rlsCount"] < 1
            or not isinstance(database["ledgerFingerprint"], str)
            or not re.fullmatch(r"[0-9]+:[0-9a-f]{64}", database["ledgerFingerprint"])):
        raise ValueError("Database snapshot counters are invalid")
    objects = data["evidence"]
    if not isinstance(objects, list) or not objects or len(objects) > 100000:
        raise ValueError("A bounded nonempty evidence inventory is required")
    seen: set[tuple[str, str]] = set()
    for item in objects:
        if not isinstance(item, dict) or set(item) != {
            "path", "key", "sourceVersionId", "sha256", "byteSize", "retainUntil", "legalHold"
        }:
            raise ValueError("Evidence inventory entry is incomplete")
        if (not isinstance(item["key"], str) or not item["key"].startswith("tenants/")
                or not isinstance(item["sourceVersionId"], str)
                or not item["sourceVersionId"] or item["sourceVersionId"] == "null"
                or not HASH.fullmatch(item["sha256"])
                or not isinstance(item["byteSize"], int) or not 1 <= item["byteSize"] <= 67108864
                or not isinstance(item["legalHold"], bool)):
            raise ValueError("Evidence inventory identity is invalid")
        identity = (item["key"], item["sourceVersionId"])
        if identity in seen:
            raise ValueError("Duplicate evidence object version in inventory")
        seen.add(identity)
        if timestamp(item["retainUntil"]) <= backup:
            raise ValueError("Evidence retention was expired at backup time")
        actual_hash, actual_size = digest_file(artifact(root, item["path"]))
        if actual_hash != item["sha256"] or actual_size != item["byteSize"]:
            raise ValueError("Evidence backup bytes do not match signed inventory")
    return {"tableCount": database["tableCount"], "rlsCount": database["rlsCount"],
            "ledgerFingerprint": database["ledgerFingerprint"], "rpoSeconds": int(rpo),
            "evidenceCount": len(objects), "incidentEpoch": int(incident.timestamp())}


def check_inventory(path: Path, rows_path: Path) -> int:
    data = load_manifest(path)
    rows = json.loads(rows_path.read_text())
    if not isinstance(rows, list):
        raise ValueError("Restored evidence reference inventory is invalid")
    expected = {(data["sourceBucket"], item["key"], item["sourceVersionId"],
                 item["sha256"], item["byteSize"]) for item in data["evidence"]}
    actual = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"bucket", "key", "versionId", "sha256", "byteSize"}:
            raise ValueError("Restored evidence reference is malformed")
        actual.add((row["bucket"], row["key"], row["versionId"], row["sha256"], row["byteSize"]))
    if actual != expected:
        raise ValueError("Signed evidence backup does not cover every restored version reference")
    return len(actual)


def restore_evidence(path: Path, root: Path, s3=None, now: datetime | None = None) -> int:
    data = load_manifest(path)
    current = now or datetime.now(timezone.utc)
    endpoint = os.environ.get("AXIOM_RESTORE_S3_ENDPOINT", "")
    bucket = os.environ.get("AXIOM_RESTORE_S3_BUCKET", "")
    if (endpoint != "http://minio:9000" or not bucket
            or bucket == data["sourceBucket"]):
        raise ValueError("A distinct bucket on the internal on-prem WORM endpoint is required")
    if s3 is None:
        import boto3  # locked agent-runtime dependency; no network install here
        s3 = boto3.client("s3", region_name="ap-south-1", endpoint_url=endpoint,
                          aws_access_key_id=os.environ["AXIOM_RECOVERY_STORAGE_ACCESS_KEY_ID"],
                          aws_secret_access_key=os.environ["AXIOM_RECOVERY_STORAGE_SECRET_ACCESS_KEY"])
    if s3.get_bucket_location(Bucket=bucket).get("LocationConstraint") != "ap-south-1":
        raise ValueError("Evidence restore bucket is outside ap-south-1")
    lock = s3.get_object_lock_configuration(Bucket=bucket)["ObjectLockConfiguration"]
    retention = lock.get("Rule", {}).get("DefaultRetention", {})
    if (lock.get("ObjectLockEnabled") != "Enabled" or retention.get("Mode") != "COMPLIANCE"
            or (retention.get("Years", 0) < 7 and retention.get("Days", 0) < MIN_COMPLIANCE_DAYS)):
        raise ValueError("Evidence restore bucket lacks seven-year Compliance lock")
    existing_versions = s3.list_object_versions(Bucket=bucket, MaxKeys=1)
    if (s3.list_objects_v2(Bucket=bucket, MaxKeys=1).get("KeyCount", 0) != 0
            or existing_versions.get("Versions") or existing_versions.get("DeleteMarkers")):
        raise ValueError("Evidence restore bucket must start empty")
    sample = data["evidence"][0]
    try:
        source_read = s3.get_object(Bucket=data["sourceBucket"], Key=sample["key"],
                                    VersionId=sample["sourceVersionId"])
    except Exception as exc:
        code = getattr(exc, "response", {}).get("Error", {}).get("Code")
        if code != "AccessDenied":
            raise ValueError("Source bucket denial proof is unavailable") from exc
    else:
        body = source_read.get("Body")
        if body is not None:
            body.close()
        raise ValueError("Recovery credential can read the protected source bucket")
    for item in data["evidence"]:
        content = artifact(root, item["path"]).read_bytes()
        if hashlib.sha256(content).hexdigest() != item["sha256"] or len(content) != item["byteSize"]:
            raise ValueError("Evidence backup changed before restore")
        retain_until = max(timestamp(item["retainUntil"]), current + timedelta(days=MIN_COMPLIANCE_DAYS))
        put = s3.put_object(Bucket=bucket, Key=item["key"], Body=content,
                            ObjectLockMode="COMPLIANCE", ObjectLockRetainUntilDate=retain_until,
                            ObjectLockLegalHoldStatus="ON" if item["legalHold"] else "OFF",
                            ServerSideEncryption="AES256",
                            Metadata={"source-sha256": item["sha256"],
                                      "source-version-id": item["sourceVersionId"]})
        version = put.get("VersionId")
        if not isinstance(version, str) or not version or version == "null":
            raise ValueError("Evidence restore returned no exact version")
        reference = {"Bucket": bucket, "Key": item["key"], "VersionId": version}
        head = s3.head_object(**reference)
        locked = s3.get_object_retention(**reference).get("Retention", {})
        legal_hold = s3.get_object_legal_hold(**reference).get("LegalHold", {}).get("Status")
        body = s3.get_object(**reference)["Body"].read()
        if (head.get("VersionId") != version or head.get("ContentLength") != len(content)
                or head.get("ServerSideEncryption") != "AES256"
                or head.get("Metadata", {}).get("source-sha256") != item["sha256"]
                or head.get("Metadata", {}).get("source-version-id") != item["sourceVersionId"]
                or locked.get("Mode") != "COMPLIANCE"
                or locked.get("RetainUntilDate") < retain_until
                or legal_hold != ("ON" if item["legalHold"] else "OFF")
                or hashlib.sha256(body).hexdigest() != item["sha256"]):
            raise ValueError("Exact restored evidence version failed readback")
    return len(data["evidence"])


def main() -> None:
    if len(sys.argv) < 2:
        raise ValueError("Use validate or restore")
    if sys.argv[1] == "validate" and len(sys.argv) == 7:
        result = validate(Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]),
                          sys.argv[5], sys.argv[6])
        print(json.dumps(result, separators=(",", ":")))
    elif sys.argv[1] == "restore" and len(sys.argv) == 4:
        print(json.dumps({"restoredEvidenceObjects": restore_evidence(
            Path(sys.argv[2]), Path(sys.argv[3]))}))
    elif sys.argv[1] == "inventory" and len(sys.argv) == 4:
        print(json.dumps({"matchedEvidenceObjects": check_inventory(
            Path(sys.argv[2]), Path(sys.argv[3]))}))
    elif sys.argv[1] == "credentials" and len(sys.argv) == 3:
        validate_recovery_credentials(Path(sys.argv[2]))
    else:
        raise ValueError("Use validate MANIFEST DUMP EVIDENCE_ROOT DATABASE INCIDENT_AT or restore MANIFEST EVIDENCE_ROOT")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        print(f"Recovery evidence gate failed: {exc}", file=sys.stderr)
        sys.exit(1)
