"""Evidence Vault — S3 client with Object Lock (WORM) Compliance mode.

Mirrors packages/evidence/src/index.ts. Used by Saakshi (the evidence
agent) and by any agent that needs to capture audit artifacts.

The evidence vault is the product's trust claim. Per Doc 04 §6.2 and
Doc 05 §5, this is plain S3 API (no AWS-proprietary conveniences) so
the bucket can use compatible S3/MinIO providers. GCS needs a verified provider adapter.

Object Lock with Compliance mode retention means:
  - Object cannot be deleted by ANY user, including root, until
    retention period expires
  - Object cannot be overwritten
  - Retention period itself cannot be shortened
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Literal
from urllib.parse import urlparse

import boto3
from botocore.client import Config

from .config import Settings, get_settings


@dataclass(frozen=True)
class SealedEvidence:
    content_hash: str
    storage_uri: str
    bucket: str
    key: str
    byte_size: int
    retain_until: datetime
    lock_mode: Literal["COMPLIANCE", "GOVERNANCE"] = "COMPLIANCE"
    version_id: str | None = None
    encryption: str = "AES256"
    retention_assurance: Literal["verified"] = "verified"


@dataclass(frozen=True)
class SealInput:
    bucket: str
    key: str
    body: bytes
    content_type: str
    retention_days: int
    tenant_id: str
    engagement_id: str | None = None
    collected_by_agent: str = ""
    legal_hold: bool = False
    encryption: str = "AES256"
    metadata: dict[str, str] | None = None


class EvidenceVault:
    def __init__(self, settings: Settings | None = None):
        s = settings or get_settings()
        self._settings = s
        endpoint = s.axiom_storage_endpoint or s.s3_endpoint
        host = (urlparse(endpoint).hostname or "") if endpoint else ""
        self._is_gcs = host == "storage.googleapis.com" or host.endswith(".storage.googleapis.com")
        region = s.axiom_region or s.aws_region
        access_key = s.axiom_storage_access_key_id or s.aws_access_key_id
        secret_key = s.axiom_storage_secret_access_key or s.aws_secret_access_key

        kwargs: dict[str, Any] = {
            "region_name": region,
            "config": Config(signature_version="s3v4"),
        }
        if access_key and secret_key:
            kwargs["aws_access_key_id"] = access_key
            kwargs["aws_secret_access_key"] = secret_key
        if endpoint:
            kwargs["endpoint_url"] = endpoint
        self._s3 = boto3.client("s3", **kwargs)

    def seal(self, input: SealInput) -> SealedEvidence:
        if type(input.retention_days) is not int or input.retention_days <= 0:
            raise ValueError("retention_days must be a positive integer")
        if self._is_gcs:
            raise RuntimeError("GCS sealing requires a verified Bucket/Object Retention Lock adapter")
        configuration = self._s3.get_object_lock_configuration(Bucket=input.bucket)
        if configuration.get("ObjectLockConfiguration", {}).get("ObjectLockEnabled") != "Enabled":
            raise RuntimeError("Bucket does not have verified Object Lock enabled")
        body = input.body
        content_hash = hashlib.sha256(body).hexdigest()
        retain_until = datetime.now(timezone.utc).replace(microsecond=0) + timedelta(days=input.retention_days, seconds=1)

        metadata = {
            **{k: v for k, v in (input.metadata or {}).items() if not k.lower().startswith("axiom-")},
            "axiom-retention-assurance": "unverified",
            "axiom-retention-request": "COMPLIANCE",
            "axiom-content-sha256": content_hash,
            "axiom-tenant-id": input.tenant_id,
            "axiom-engagement-id": input.engagement_id or "",
            "axiom-collected-by-agent": input.collected_by_agent,
            "axiom-sealed-at": datetime.now(timezone.utc).isoformat(),
        }

        put_kwargs: dict[str, Any] = {
            "Bucket": input.bucket,
            "Key": input.key,
            "Body": body,
            "ContentType": input.content_type,
            "ContentMD5": _md5_b64(body),
            "Metadata": metadata,
            "ServerSideEncryption": input.encryption,
        }
        # Native AWS S3 requires ObjectLock headers.
        # Google Cloud Storage as S3 WORM storage enforces WORM via Bucket Lock (retention policy)
        # and rejects x-amz-object-lock-* request headers.
        if not self._is_gcs:
            put_kwargs["ObjectLockMode"] = "COMPLIANCE"
            put_kwargs["ObjectLockRetainUntilDate"] = retain_until
            put_kwargs["ObjectLockLegalHoldStatus"] = "ON" if input.legal_hold else "OFF"
            put_kwargs["ChecksumAlgorithm"] = "SHA256"

        result = self._s3.put_object(**put_kwargs)
        version_id = result.get("VersionId")
        if not isinstance(version_id, str) or not version_id or version_id == "null":
            raise RuntimeError("Uploaded evidence has no immutable version; seal not verified")
        object_ref = {"Bucket": input.bucket, "Key": input.key, "VersionId": version_id}
        retention = self._s3.get_object_retention(**object_ref).get("Retention", {})
        confirmed_until = retention.get("RetainUntilDate")
        if (retention.get("Mode") != "COMPLIANCE" or not isinstance(confirmed_until, datetime)
                or confirmed_until.tzinfo is None or confirmed_until < retain_until):
            raise RuntimeError("Provider did not confirm required COMPLIANCE retention")
        if input.legal_hold:
            hold = self._s3.get_object_legal_hold(**object_ref)
            if hold.get("LegalHold", {}).get("Status") != "ON":
                raise RuntimeError("Provider did not confirm legal hold")

        return SealedEvidence(
            content_hash=content_hash,
            storage_uri=f"s3://{input.bucket}/{input.key}",
            bucket=input.bucket,
            key=input.key,
            byte_size=len(body),
            retain_until=confirmed_until,
            version_id=version_id,
        )

    def verify_integrity(
        self, bucket: str, key: str, expected_hash: str
    ) -> tuple[bool, str]:
        obj = self._s3.get_object(Bucket=bucket, Key=key)
        body = obj["Body"].read()
        actual = hashlib.sha256(body).hexdigest()
        return actual == expected_hash, actual


def content_key(
    *,
    tenant_id: str,
    content_hash: str,
    filename: str | None = None,
    engagement_id: str | None = None,
) -> str:
    if engagement_id:
        path = (
            f"tenants/{tenant_id}/engagements/{engagement_id}"
            f"/evidence/{content_hash}"
        )
    else:
        path = f"tenants/{tenant_id}/evidence/{content_hash}"
    return f"{path}/{filename}" if filename else path


def _md5_b64(data: bytes) -> str:
    import base64

    # S3 Content-MD5 transport integrity header (required for Object Lock
    # PUTs), not a security primitive. Evidence integrity is the SHA-256 path.
    return base64.b64encode(hashlib.md5(data, usedforsecurity=False).digest()).decode("ascii")
