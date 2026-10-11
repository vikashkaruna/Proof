"""Offline Ed25519 license verification shared by sovereign Python services.

Require an explicitly configured Ed25519 public authority key and reject the
retired test authority. Fail closed on bad signatures, malformed claims, future
issuance, or expiry on every invocation.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

RETIRED_ROOT_PUBLIC_KEY_SHA256 = (
    "137bfb57f9b76d8e8e17cc1ca3e1aa05016199ad6790f0239c67e4e7021cf41f"
)


def _decode(segment: str) -> bytes:
    if not segment or any(
        char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        for char in segment
    ):
        raise ValueError("invalid license encoding")
    return base64.b64decode(
        segment + "=" * (-len(segment) % 4), altchars=b"-_", validate=True
    )


def _time(value: Any) -> datetime:
    if not isinstance(value, str):
        raise TypeError("invalid license timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("license timestamp must include timezone")
    return parsed.astimezone(timezone.utc)


def verify_offline_license(
    token: str | None,
    *,
    now: datetime | None = None,
    public_key_pem: bytes | None = None,
) -> bool:
    """Return true only for an authentic, currently valid on-prem license."""
    if not isinstance(token, str) or not token or len(token) > 16_384:
        return False
    try:
        version, payload_b64, signature_b64 = token.strip().split(".")
        if version != "v1":
            return False
        payload = json.loads(_decode(payload_b64))
        if not isinstance(payload, dict):
            return False
        # Match the TS verifier's signed canonical object; reject claims that
        # could be validly signed but have no meaning to this runtime.
        if payload.get("environment") != "onprem" or payload.get("tier") not in {
            "community",
            "enterprise-sovereign",
            "enterprise-airgapped",
        }:
            return False
        if not all(
            isinstance(payload.get(name), str) and payload[name]
            for name in ("licenseId", "licensee")
        ):
            return False
        if not all(
            type(payload.get(name)) is int and payload[name] > 0
            for name in ("maxTenants", "maxNodes")
        ):
            return False
        if not isinstance(payload.get("features"), list) or not all(
            isinstance(item, str) for item in payload["features"]
        ):
            return False
        issued_at, expires_at = (
            _time(payload.get("issuedAt")),
            _time(payload.get("expiresAt")),
        )
        current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        if current < issued_at - timedelta(minutes=1) or current > expires_at:
            return False
        if public_key_pem is None:
            configured = os.environ.get("AXIOM_LICENSE_ROOT_PUBLIC_KEY")
            if not configured or not configured.strip():
                return False
            public_key_pem = configured.replace("\\n", "\n").encode("utf-8")
        public_key_pem = public_key_pem.strip()
        if not (
            public_key_pem.startswith(b"-----BEGIN PUBLIC KEY-----")
            and public_key_pem.endswith(b"-----END PUBLIC KEY-----")
        ):
            return False
        key = serialization.load_pem_public_key(public_key_pem)
        if not isinstance(key, Ed25519PublicKey):
            return False
        fingerprint = hashlib.sha256(
            key.public_bytes(
                serialization.Encoding.DER,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
        ).hexdigest()
        if fingerprint == RETIRED_ROOT_PUBLIC_KEY_SHA256:
            return False
        canonical = json.dumps(
            payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
        key.verify(_decode(signature_b64), canonical)
        return True
    except (
        ValueError,
        TypeError,
        KeyError,
        UnicodeDecodeError,
        OverflowError,
        InvalidSignature,
        UnsupportedAlgorithm,
    ):
        return False
