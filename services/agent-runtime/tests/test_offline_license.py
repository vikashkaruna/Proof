"""Independent Python verification and runtime refusal for on-prem licenses."""

import base64
import json
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

from axiom_offline_license import verify_offline_license
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from axiom.app import app


def token(expires: datetime, *, key: Ed25519PrivateKey | None = None) -> tuple[str, bytes]:
    signing_key = key or Ed25519PrivateKey.generate()
    payload = {
        "licenseId": "test-license",
        "licensee": "Test Organization",
        "environment": "onprem",
        "tier": "enterprise-airgapped",
        "issuedAt": (expires - timedelta(days=1)).isoformat().replace("+00:00", "Z"),
        "expiresAt": expires.isoformat().replace("+00:00", "Z"),
        "maxTenants": 2,
        "maxNodes": 3,
        "features": ["*"],
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()

    def encode(value: bytes) -> str:
        return base64.urlsafe_b64encode(value).decode().rstrip("=")

    signed = (
        "v1." + encode(json.dumps(payload).encode()) + "." + encode(signing_key.sign(canonical))
    )
    public = signing_key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return signed, public


def test_signature_expiry_and_tampering():
    now = datetime.now(UTC)
    valid, public = token(now + timedelta(hours=1))
    assert verify_offline_license(valid, now=now, public_key_pem=public)
    assert not verify_offline_license(valid, now=now + timedelta(hours=2), public_key_pem=public)
    assert not verify_offline_license(valid + "x", now=now, public_key_pem=public)
    assert not verify_offline_license(valid, now=now)


def test_runtime_blocks_private_calls_without_license():
    with patch.dict("os.environ", {"ENVIRONMENT": "onprem", "AXIOM_OFFLINE_LICENSE": "bad"}):
        client = TestClient(app)
        assert client.get("/health").status_code == 200
        assert client.get("/ready").status_code == 503
        assert client.post("/internal/execute", json={}).status_code == 403
