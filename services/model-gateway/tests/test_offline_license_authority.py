"""Real license signatures gate the gateway before inference routing."""

import base64
import json
from datetime import UTC, datetime, timedelta

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from model_gateway.app import app


def test_gateway_requires_configured_authority_without_changing_health(monkeypatch):
    now = datetime.now(UTC)
    authority = Ed25519PrivateKey.generate()
    payload = {
        "licenseId": "gateway-authority-regression",
        "licensee": "Synthetic Test Organization",
        "environment": "onprem",
        "tier": "enterprise-airgapped",
        "issuedAt": (now - timedelta(minutes=1)).isoformat(),
        "expiresAt": (now + timedelta(hours=1)).isoformat(),
        "maxTenants": 1,
        "maxNodes": 1,
        "features": [],
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    encoded = base64.urlsafe_b64encode(canonical).decode().rstrip("=")
    signature = base64.urlsafe_b64encode(authority.sign(canonical)).decode().rstrip("=")
    monkeypatch.setenv("ENVIRONMENT", "onprem")
    monkeypatch.setenv("AXIOM_OFFLINE_LICENSE", f"v1.{encoded}.{signature}")
    monkeypatch.delenv("AXIOM_LICENSE_ROOT_PUBLIC_KEY", raising=False)
    client = TestClient(app)
    assert client.get("/__unmapped_license_probe__").status_code == 403
    assert client.get("/health").status_code == 200
    public = (
        authority.public_key()
        .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        .decode()
    )
    monkeypatch.setenv("AXIOM_LICENSE_ROOT_PUBLIC_KEY", public.replace("\n", "\\n"))
    assert client.get("/__unmapped_license_probe__").status_code == 404
    monkeypatch.setenv("AXIOM_LICENSE_ROOT_PUBLIC_KEY", "invalid authority")
    assert client.get("/__unmapped_license_probe__").status_code == 403
    assert client.get("/health").status_code == 200
