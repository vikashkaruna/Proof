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


def test_requires_explicit_authority_and_respects_empty_override(monkeypatch):
    now = datetime.now(UTC)
    valid, public = token(now + timedelta(hours=1))
    monkeypatch.delenv("AXIOM_LICENSE_ROOT_PUBLIC_KEY", raising=False)
    assert not verify_offline_license(valid, now=now)
    monkeypatch.setenv("AXIOM_LICENSE_ROOT_PUBLIC_KEY", public.decode().replace("\n", "\\n"))
    assert verify_offline_license(valid, now=now)
    assert not verify_offline_license(valid, now=now, public_key_pem=b"")
    _, other_public = token(now + timedelta(hours=1))
    assert not verify_offline_license(valid, now=now, public_key_pem=other_public)
    for malformed in ("", " ", "not-a-public-key"):
        monkeypatch.setenv("AXIOM_LICENSE_ROOT_PUBLIC_KEY", malformed)
        assert not verify_offline_license(valid, now=now)


def test_rejects_private_or_wrong_algorithm_authority(monkeypatch):
    from cryptography.hazmat.primitives.asymmetric.rsa import generate_private_key

    now = datetime.now(UTC)
    valid, _ = token(now + timedelta(hours=1))
    private = Ed25519PrivateKey.generate().private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    assert not verify_offline_license(valid, now=now, public_key_pem=private)
    rsa_public = (
        generate_private_key(public_exponent=65537, key_size=2048)
        .public_key()
        .public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    )
    assert not verify_offline_license(valid, now=now, public_key_pem=rsa_public)


def test_runtime_authority_controls_license_gate_without_bypassing_other_routes(monkeypatch):
    valid, public = token(datetime.now(UTC) + timedelta(hours=1))
    monkeypatch.setenv("ENVIRONMENT", "onprem")
    monkeypatch.setenv("AXIOM_OFFLINE_LICENSE", valid)
    monkeypatch.delenv("AXIOM_LICENSE_ROOT_PUBLIC_KEY", raising=False)
    client = TestClient(app)
    assert client.get("/__unmapped_license_probe__").status_code == 403
    monkeypatch.setenv("AXIOM_LICENSE_ROOT_PUBLIC_KEY", public.decode())
    assert client.get("/__unmapped_license_probe__").status_code == 404
    monkeypatch.setenv("AXIOM_LICENSE_ROOT_PUBLIC_KEY", "malformed")
    assert client.get("/__unmapped_license_probe__").status_code == 403
    assert client.get("/health").status_code == 200


def test_rejects_retired_test_authority_even_with_historically_valid_signature():
    # Harmless historical fixture: expired in2000; no private key is retained.
    retired_public = b"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAjKalzxmYgARg00u6yaVSMF/2b1Q7BtNN8HMPR3XhIAc=\n-----END PUBLIC KEY-----\n"
    retired_token = "v1.eyJsaWNlbnNlSWQiOiJFWFBJUkVELUNPTVBST01JU0VELVJPT1QtUkVHUkVTU0lPTiIsImxpY2Vuc2VlIjoiU3ludGhldGljIHNlY3VyaXR5IHJlZ3Jlc3Npb24iLCJlbnZpcm9ubWVudCI6Im9ucHJlbSIsInRpZXIiOiJjb21tdW5pdHkiLCJpc3N1ZWRBdCI6IjE5OTktMDEtMDFUMDA6MDA6MDAuMDAwWiIsImV4cGlyZXNBdCI6IjIwMDAtMDEtMDFUMDA6MDA6MDAuMDAwWiIsIm1heFRlbmFudHMiOjEsIm1heE5vZGVzIjoxLCJmZWF0dXJlcyI6W119.W4C8MbFN3_B-m4WWxBNVjqABQ0JWEYxRW8Xyrz8Rj6QJN8MeJehYUFosaYh6gosu6hq52eGYvQy2-SWA4S-dDg"
    historical_now = datetime.fromisoformat("1999-06-01T00:00:00.000Z".replace("Z", "+00:00"))
    assert not verify_offline_license(
        retired_token, now=historical_now, public_key_pem=retired_public
    )


def test_unsupported_authority_algorithm_is_controlled_refusal(monkeypatch):
    from cryptography.exceptions import UnsupportedAlgorithm

    now = datetime.now(UTC)
    valid, public = token(now + timedelta(hours=1))
    with patch(
        "axiom_offline_license.serialization.load_pem_public_key",
        side_effect=UnsupportedAlgorithm("unsupported authority"),
    ):
        assert not verify_offline_license(valid, now=now, public_key_pem=public)


def test_extreme_license_timestamps_fail_closed_in_verifier_and_runtime(monkeypatch):
    valid, public = token(datetime.now(UTC) + timedelta(hours=1))
    _, encoded, _ = valid.split(".")
    payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
    payload.update(issuedAt="0001-01-01T00:00:00Z", expiresAt="9999-12-31T23:59:59Z")
    malformed = (
        "v1." + base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=") + ".AA"
    )
    assert not verify_offline_license(malformed, public_key_pem=public)
    monkeypatch.setenv("ENVIRONMENT", "onprem")
    monkeypatch.setenv("AXIOM_OFFLINE_LICENSE", malformed)
    monkeypatch.setenv("AXIOM_LICENSE_ROOT_PUBLIC_KEY", public.decode())
    client = TestClient(app)
    response = client.get("/__unmapped_license_probe__")
    assert response.status_code == 403
    assert response.json() == {"error": "offline_license_invalid"}
