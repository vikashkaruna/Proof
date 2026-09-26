"""Bounded exact-version evidence reads; COMPLIANCE protects versions, not latest keys."""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
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
    version_id: str
    readback_at: datetime
    legal_hold: bool
    encryption: str
    lock_mode: Literal["COMPLIANCE"] = "COMPLIANCE"
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
    retain_until: datetime | None = None
    operation_id: str | None = None


@dataclass(frozen=True)
class ReceiptInput:
    bucket: str
    key: str
    version_id: str
    content_hash: str
    byte_size: int
    tenant_id: str
    collected_by_agent: str
    retain_until: datetime
    engagement_id: str | None = None
    operation_id: str | None = None
    legal_hold: bool = False
    encryption: str = "AES256"


def _reference(bucket: str, key: str, version_id: str) -> dict[str, str]:
    if (
        not bucket
        or not key
        or not isinstance(version_id, str)
        or not version_id.strip()
        or version_id == "null"
        or len(version_id) > 1024
    ):
        raise ValueError("Exact evidence version is required")
    return {"Bucket": bucket, "Key": key, "VersionId": version_id}


def _deadline(timeout_seconds: float, max_bytes: int) -> float:
    if (
        not 0 < timeout_seconds <= 120
        or type(max_bytes) is not int
        or not 0 < max_bytes <= 64 * 1024 * 1024
    ):
        raise ValueError("Invalid evidence deadline or byte limit")
    return time.monotonic() + timeout_seconds


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Evidence deadline exceeded")
    return remaining


class EvidenceVault:
    def __init__(self, settings: Settings | None = None):
        s = settings or get_settings()
        self._settings = s
        endpoint = s.axiom_storage_endpoint or s.s3_endpoint
        host = (urlparse(endpoint).hostname or "") if endpoint else ""
        self._is_gcs = host == "storage.googleapis.com" or host.endswith(".storage.googleapis.com")
        kwargs: dict[str, Any] = {
            "region_name": s.axiom_region or s.aws_region,
            # Bound individual I/O as well as checking the total deadline.
            # A synchronous SDK control request can take up to this5s bound;
            # an expired overall deadline never returns verified success.
            "config": Config(
                signature_version="s3v4",
                connect_timeout=5,
                read_timeout=5,
                retries={"total_max_attempts": 1},
            ),
        }
        access_key = s.axiom_storage_access_key_id or s.aws_access_key_id
        secret_key = s.axiom_storage_secret_access_key or s.aws_secret_access_key
        if access_key and secret_key:
            kwargs.update(aws_access_key_id=access_key, aws_secret_access_key=secret_key)
        if endpoint:
            kwargs["endpoint_url"] = endpoint
        self._s3 = boto3.client("s3", **kwargs)

    def _call(self, method: str, deadline: float, **kwargs: Any) -> dict[str, Any]:
        _remaining(deadline)
        result = getattr(self._s3, method)(**kwargs)
        try:
            _remaining(deadline)
        except TimeoutError:
            body = result.get("Body")
            if body is not None:
                body.close()
            raise
        return result

    def _lock(self, bucket: str, deadline: float) -> None:
        if self._is_gcs:
            raise RuntimeError(
                "GCS sealing requires a verified Bucket/Object Retention Lock adapter"
            )
        configuration = self._call("get_object_lock_configuration", deadline, Bucket=bucket)
        if configuration.get("ObjectLockConfiguration", {}).get("ObjectLockEnabled") != "Enabled":
            raise RuntimeError("Bucket does not have verified Object Lock enabled")

    def seal(
        self, input: SealInput, *, max_bytes: int = 16 * 1024 * 1024, timeout_seconds: float = 30
    ) -> SealedEvidence:
        deadline = _deadline(timeout_seconds, max_bytes)
        if type(input.retention_days) is not int or input.retention_days <= 0:
            raise ValueError("retention_days must be a positive integer")
        body = input.body
        if not isinstance(body, bytes) or len(body) > max_bytes:
            raise ValueError("Evidence exceeds byte limit")
        retain_until = input.retain_until or (
            datetime.now(UTC).replace(microsecond=0)
            + timedelta(days=input.retention_days, seconds=1)
        )
        if retain_until.tzinfo is None or retain_until <= datetime.now(UTC):
            raise ValueError("Invalid retention date")
        self._lock(input.bucket, deadline)
        content_hash = hashlib.sha256(body).hexdigest()
        metadata = {
            **{
                k: v
                for k, v in (input.metadata or {}).items()
                if not k.lower().startswith("axiom-")
            },
            "axiom-retention-assurance": "unverified",
            "axiom-retention-request": "COMPLIANCE",
            "axiom-content-sha256": content_hash,
            "axiom-tenant-id": input.tenant_id,
            "axiom-engagement-id": input.engagement_id or "",
            "axiom-collected-by-agent": input.collected_by_agent,
            "axiom-sealed-at": datetime.now(UTC).isoformat(),
        }
        if input.operation_id:
            metadata["axiom-operation-id"] = input.operation_id
        result = self._call(
            "put_object",
            deadline,
            Bucket=input.bucket,
            Key=input.key,
            Body=body,
            ContentType=input.content_type,
            ContentMD5=_md5_b64(body),
            Metadata=metadata,
            ServerSideEncryption=input.encryption,
            ObjectLockMode="COMPLIANCE",
            ObjectLockRetainUntilDate=retain_until,
            ObjectLockLegalHoldStatus="ON" if input.legal_hold else "OFF",
            ChecksumAlgorithm="SHA256",
        )
        version_id = result.get("VersionId")
        _reference(input.bucket, input.key, version_id)
        # Failure after upload remains a pending ingestion; never invent a DB receipt.
        return self._receipt(
            input, version_id, content_hash, len(body), retain_until, deadline, max_bytes
        )

    def _read(
        self, bucket: str, key: str, version_id: str, deadline: float, max_bytes: int
    ) -> dict[str, Any]:
        obj = self._call("get_object", deadline, **_reference(bucket, key, version_id))
        stream = obj.get("Body")
        try:
            if obj.get("VersionId") != version_id or obj.get("DeleteMarker"):
                raise RuntimeError("Evidence version mismatch")
            size = obj.get("ContentLength")
            if type(size) is not int or size < 0 or size > max_bytes or stream is None:
                raise RuntimeError("Evidence exceeds byte limit or size unavailable")
            chunks: list[bytes] = []
            length = 0
            while True:
                remaining = _remaining(deadline)
                if hasattr(stream, "set_socket_timeout"):
                    stream.set_socket_timeout(min(5, remaining))
                chunk = stream.read(min(65536, max_bytes - length + 1))
                _remaining(deadline)
                if not chunk:
                    break
                length += len(chunk)
                if length > max_bytes or length > size:
                    raise RuntimeError("Evidence exceeds byte limit")
                chunks.append(chunk)
            if length != size:
                raise RuntimeError("Evidence size mismatch")
            body = b"".join(chunks)
            return {
                "body": body,
                "content_hash": hashlib.sha256(body).hexdigest(),
                "metadata": obj.get("Metadata", {}),
                "version_id": version_id,
                "encryption": obj.get("ServerSideEncryption"),
                "content_type": obj.get("ContentType"),
            }
        finally:
            if stream is not None:
                stream.close()

    def retrieve(
        self,
        bucket: str,
        key: str,
        version_id: str,
        *,
        max_bytes: int = 16 * 1024 * 1024,
        timeout_seconds: float = 30,
    ) -> dict[str, Any]:
        return self._read(bucket, key, version_id, _deadline(timeout_seconds, max_bytes), max_bytes)

    def verify_integrity(
        self, bucket: str, key: str, version_id: str, expected_hash: str, **options: Any
    ) -> tuple[bool, str]:
        if len(expected_hash) != 64 or any(c not in "0123456789abcdef" for c in expected_hash):
            raise ValueError("Invalid evidence content hash")
        obj = self.retrieve(bucket, key, version_id, **options)
        return obj["content_hash"] == expected_hash, obj["content_hash"]

    def _receipt(
        self,
        input: SealInput | ReceiptInput,
        version_id: str,
        content_hash: str,
        byte_size: int,
        retain_until: datetime,
        deadline: float,
        max_bytes: int,
    ) -> SealedEvidence:
        ref = _reference(input.bucket, input.key, version_id)
        retention = self._call("get_object_retention", deadline, **ref).get("Retention", {})
        confirmed = retention.get("RetainUntilDate")
        if (
            retention.get("Mode") != "COMPLIANCE"
            or not isinstance(confirmed, datetime)
            or confirmed.tzinfo is None
            or confirmed < retain_until
            or confirmed <= datetime.now(UTC)
        ):
            raise RuntimeError("Provider did not confirm required COMPLIANCE retention")
        hold = (
            self._call("get_object_legal_hold", deadline, **ref).get("LegalHold", {}).get("Status")
        )
        if hold not in ("ON", "OFF") or (input.legal_hold and hold != "ON"):
            raise RuntimeError("Provider did not confirm legal hold")
        obj = self._read(input.bucket, input.key, version_id, deadline, max_bytes)
        if obj["content_hash"] != content_hash or len(obj["body"]) != byte_size:
            raise RuntimeError("Evidence hash or size mismatch")
        metadata = {
            "axiom-content-sha256": content_hash,
            "axiom-tenant-id": input.tenant_id,
            "axiom-engagement-id": input.engagement_id or "",
            "axiom-collected-by-agent": input.collected_by_agent,
        }
        if input.operation_id:
            metadata["axiom-operation-id"] = input.operation_id
        if any(obj["metadata"].get(k) != v for k, v in metadata.items()):
            raise RuntimeError("Evidence metadata mismatch")
        if obj["encryption"] != input.encryption:
            raise RuntimeError("Provider did not confirm evidence encryption")
        return SealedEvidence(
            content_hash=content_hash,
            storage_uri=f"s3://{input.bucket}/{input.key}",
            bucket=input.bucket,
            key=input.key,
            byte_size=byte_size,
            retain_until=confirmed,
            version_id=version_id,
            encryption=obj["encryption"],
            legal_hold=hold == "ON",
            readback_at=datetime.now(UTC),
        )

    def verify_receipt(
        self, input: ReceiptInput, *, max_bytes: int = 16 * 1024 * 1024, timeout_seconds: float = 30
    ) -> SealedEvidence:
        deadline = _deadline(timeout_seconds, max_bytes)
        _reference(input.bucket, input.key, input.version_id)
        if (
            len(input.content_hash) != 64
            or any(c not in "0123456789abcdef" for c in input.content_hash)
            or type(input.byte_size) is not int
            or not 0 <= input.byte_size <= max_bytes
            or input.retain_until.tzinfo is None
        ):
            raise ValueError("Invalid evidence receipt")
        self._lock(input.bucket, deadline)
        return self._receipt(
            input,
            input.version_id,
            input.content_hash,
            input.byte_size,
            input.retain_until,
            deadline,
            max_bytes,
        )

    def head(
        self,
        bucket: str,
        key: str,
        version_id: str,
        *,
        max_bytes: int = 16 * 1024 * 1024,
        timeout_seconds: float = 30,
    ) -> dict[str, Any]:
        obj = self._call(
            "head_object",
            _deadline(timeout_seconds, max_bytes),
            **_reference(bucket, key, version_id),
        )
        if obj.get("VersionId") != version_id or obj.get("DeleteMarker"):
            raise RuntimeError("Evidence version mismatch")
        if type(obj.get("ContentLength")) is not int or not 0 <= obj["ContentLength"] <= max_bytes:
            raise RuntimeError("Evidence exceeds byte limit or size unavailable")
        return obj

    def presigned_audit_url(
        self, bucket: str, key: str, version_id: str, expires_in_seconds: int = 300
    ) -> str:
        ref = _reference(bucket, key, version_id)
        if type(expires_in_seconds) is not int or not 0 < expires_in_seconds <= 900:
            raise ValueError("Invalid audit URL lifetime")
        return self._s3.generate_presigned_url(
            "get_object", Params=ref, ExpiresIn=expires_in_seconds
        )


def content_key(
    *,
    tenant_id: str,
    content_hash: str,
    filename: str | None = None,
    engagement_id: str | None = None,
) -> str:
    path = (
        f"tenants/{tenant_id}/engagements/{engagement_id}/evidence/{content_hash}"
        if engagement_id
        else f"tenants/{tenant_id}/evidence/{content_hash}"
    )
    return f"{path}/{filename}" if filename else path


def _md5_b64(data: bytes) -> str:
    import base64

    return base64.b64encode(hashlib.md5(data, usedforsecurity=False).digest()).decode("ascii")
