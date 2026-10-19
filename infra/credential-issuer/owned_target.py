"""Narrow mode for the existing protected operator signer, not a new issuer.

No generic role override or database issuer grant. The caller remains a trusted
host administrator. Every mint requires the BFF's independent current signed
scope verification and its exact once-only JTI reservation before reading the
existing signing key. The poller never receives this key.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import importlib.util
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from types import ModuleType

ROLE = "owned_target_controller"
PURPOSE = "owned_synthetic_target_v1"
ROOT = Path(__file__).resolve().parents[2]


def bridge() -> ModuleType:
    path = ROOT / "scripts/local-owned-deployment.py"
    spec = importlib.util.spec_from_file_location("axiom_owned_operator_bridge", path)
    if spec is None or spec.loader is None:
        raise ValueError("Owned issuer bridge refused")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def checked_request(issuer: ModuleType, raw: bytes, expected: str) -> dict:
    if len(raw) > 8192 or issuer.sha(raw) != issuer.digest(expected):
        raise ValueError("Owned credential review refused")
    value = json.loads(raw, object_pairs_hook=issuer.unique)
    required = {
        "schemaVersion",
        "purpose",
        "tenantId",
        "bindingId",
        "enrollmentId",
        "credentialId",
        "reservationSha256",
        "manifestSha256",
        "custodyEpoch",
        "issuerConfigurationSha256",
        "hostConfigurationFile",
        "hostConfigurationSha256",
    }
    if (
        not isinstance(value, dict)
        or set(value) != required
        or type(value["schemaVersion"]) is not int
        or value["schemaVersion"] != 1
        or value["purpose"] != "owned-target-credential-issue"
        or type(value["custodyEpoch"]) is not int
        or value["custodyEpoch"] <= 0
    ):
        raise ValueError("Owned credential request refused")
    for field in ("tenantId", "bindingId", "enrollmentId", "credentialId"):
        issuer.identifier(value[field])
    for field in (
        "reservationSha256",
        "manifestSha256",
        "issuerConfigurationSha256",
        "hostConfigurationSha256",
    ):
        issuer.digest(value[field])
    if not isinstance(value["hostConfigurationFile"], str):
        raise TypeError("Owned credential host configuration refused")
    return value


def signed_credential(issuer: ModuleType, settings: dict, scope: dict) -> bytes:
    # Same existing protected key and anon-key signature cross-check as the
    # established issuer; no key value can be supplied by the request/poller.
    key = issuer.source(settings["signingKey"]).removesuffix(b"\n").removesuffix(b"\r")
    if not 32 <= len(key) <= 8192 or any(c < 33 or c > 126 for c in key):
        raise ValueError("Owned credential signing source refused")
    api = (
        issuer.source(settings["apiKey"], 4096)
        .decode("ascii")
        .removesuffix("\n")
        .removesuffix("\r")
    )
    parts, header, anonymous, signature = issuer.jwt_parts(api)
    if (
        header != {"alg": "HS256", "typ": "JWT"}
        or anonymous.get("role") != "anon"
        or type(anonymous.get("exp")) is not int
        or anonymous["exp"] <= time.time()
        or not hmac.compare_digest(
            signature, hmac.digest(key, ".".join(parts[:2]).encode(), "sha256")
        )
    ):
        raise ValueError("Owned credential gateway authority mismatch")
    claims = {
        "role": ROLE,
        "owned_target_purpose": PURPOSE,
        "tenant_id": scope["tenantId"],
        "binding_id": scope["bindingId"],
        "enrollment_id": scope["enrollmentId"],
        "jti": scope["credentialId"],
        "custody_epoch": scope["custodyEpoch"],
        "iat": scope["issuedAt"],
        "exp": scope["expiresAtSeconds"],
    }

    def b64(value: bytes) -> str:
        return base64.urlsafe_b64encode(value).decode().rstrip("=")

    unsigned = ".".join(
        b64(issuer.encode(v).rstrip(b"\n"))
        for v in ({"alg": "HS256", "typ": "JWT"}, claims)
    )
    token = unsigned + "." + b64(hmac.digest(key, unsigned.encode(), "sha256"))
    return issuer.encode(
        {
            "schemaVersion": 1,
            "tenantId": scope["tenantId"],
            "bindingId": scope["bindingId"],
            "enrollmentId": scope["enrollmentId"],
            "credentialId": scope["credentialId"],
            "custodyEpoch": scope["custodyEpoch"],
            "expiresAt": scope["expiresAt"],
            "accessToken": token,
        }
    )


def issue(
    issuer: ModuleType, review: Path, expected: str, config: Path, target: Path
) -> None:
    raw = issuer.read(review, 8192)
    request = checked_request(issuer, raw, expected)
    operator = bridge()
    host_raw = operator.protected_bytes(Path(request["hostConfigurationFile"]))
    if hashlib.sha256(host_raw).hexdigest() != request["hostConfigurationSha256"]:
        raise ValueError("Owned issuer host source changed")
    host = operator.parse_json(host_raw)
    if (
        not isinstance(host, dict)
        or host.get("hostInstallerSha256") != operator.host_source_sha256()
    ):
        raise ValueError("Owned issuer reviewed bundle changed")
    settings = issuer.configuration(config, request["issuerConfigurationSha256"])
    body = {
        field: request[field]
        for field in (
            "tenantId",
            "bindingId",
            "enrollmentId",
            "credentialId",
            "reservationSha256",
            "manifestSha256",
            "custodyEpoch",
            "issuerConfigurationSha256",
        )
    }
    authorized = operator.operator_request(
        host, "/internal/owned-deployments/credentials/authorize", body
    )
    if (
        not isinstance(authorized, dict)
        or set(authorized) != {"data"}
        or not isinstance(authorized["data"], dict)
    ):
        raise ValueError("Owned issuer reservation refused")
    scope = authorized["data"]
    required = {
        "tenantId",
        "bindingId",
        "enrollmentId",
        "credentialId",
        "custodyEpoch",
        "manifestSha256",
        "reservationSha256",
        "issuedAt",
        "expiresAtSeconds",
        "expiresAt",
        "scopeExpiresAtSeconds",
        "issuerConfigurationSha256",
        "hostInstallerSha256",
        "bffContainerId",
        "bffImage",
    }
    if set(scope) != required or any(
        scope[field] != request[field]
        for field in (
            "tenantId",
            "bindingId",
            "enrollmentId",
            "credentialId",
            "custodyEpoch",
            "manifestSha256",
            "reservationSha256",
            "issuerConfigurationSha256",
        )
    ):
        raise ValueError("Owned issuer reservation scope refused")
    if (
        scope["hostInstallerSha256"] != operator.host_source_sha256()
        or scope["bffContainerId"] != host.get("bffContainerId")
        or scope["bffImage"] != host.get("bffImage")
        or any(
            type(scope[field]) is not int
            for field in ("issuedAt", "expiresAtSeconds", "scopeExpiresAtSeconds")
        )
        or scope["issuedAt"] > time.time()
        or scope["expiresAtSeconds"] <= time.time()
        or not 1 <= scope["expiresAtSeconds"] - scope["issuedAt"] <= 900
        or scope["expiresAtSeconds"] > scope["scopeExpiresAtSeconds"]
    ):
        raise ValueError("Owned issuer reservation validity refused")
    if not isinstance(scope["expiresAt"], str):
        raise TypeError("Owned issuer expiry identity refused")
    expiry = datetime.fromisoformat(scope["expiresAt"])
    if expiry.tzinfo is None or expiry.timestamp() != scope["expiresAtSeconds"]:
        raise ValueError("Owned issuer expiry identity refused")
    # The existing protected issuer directory helper owns locking, exclusive
    # output creation and fsync. No token or key is printed to stdout/stderr.
    with issuer.directory(target, True):
        issuer.create(target / "request.json", raw)
        issuer.create(target / "reservation.json", issuer.encode(scope))
        if operator.host_source_sha256() != host["hostInstallerSha256"]:
            raise ValueError("Owned issuer source changed before mint")
        data = signed_credential(issuer, settings, scope)
        issuer.create(target / "candidate.key", data)
        finished = operator.operator_request(
            host,
            "/internal/owned-deployments/credentials/complete",
            {
                **body,
                "credential": json.loads(data),
                "credentialSha256": issuer.sha(data),
            },
        )
        if (
            not isinstance(finished, dict)
            or finished.get("data", {}).get("state") != "active"
            or finished["data"].get("credentialId") != request["credentialId"]
            or finished["data"].get("credentialSha256") != issuer.sha(data)
        ):
            raise ValueError("Owned credential publication unconfirmed")
        # Exact private HTTP completion must have independently checked the
        # token through PostgREST, then registered/read back this JTI scope.
        if (
            issuer.configuration(config, request["issuerConfigurationSha256"])
            != settings
            or operator.host_source_sha256() != host["hostInstallerSha256"]
        ):
            raise ValueError("Owned issuer input changed before publication")
        (target / "candidate.key").rename(target / "backend.key")
        issuer.sync(target)
        issuer.create(target / "ready.json", issuer.encode(finished["data"]))


def main(issuer: ModuleType) -> None:
    if not sys.flags.isolated or len(sys.argv) != 6 or sys.argv[1] != "--owned-target":
        raise ValueError("Explicit isolated owned credential issuer required")
    issue(issuer, Path(sys.argv[2]), sys.argv[3], Path(sys.argv[4]), Path(sys.argv[5]))
