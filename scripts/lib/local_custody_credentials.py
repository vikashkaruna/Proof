"""Canonical issue requests for the protected local custody credential issuer.

Pure functions only: no database, network or file access. The issuer
(infra/local-custody-issuer/issuer.py) independently validates every field,
re-reads the policy quorum in SQL and signs nothing for a mismatched request.
"""

from __future__ import annotations

import hashlib
import json
import uuid

KINDS = ("operator", "producer", "controller")
# Each signed bearer is <= 1 h (issuer contract); the registry lease may be
# longer, but renewal re-issues with predecessorId well before expiry.
DEFAULT_LIFETIME_S = 3600


def canonical(value: dict) -> bytes:
    """Same canonical form the issuer enforces (sorted keys, no spaces, UTF-8)."""
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf8")


def principal(policy: dict, kind: str) -> str:
    if kind == "operator":
        return "operator:" + policy["nominatedOperatorId"]
    return policy["servicePrincipals"][kind]


def issue_request(
    *,
    policy_text: str,
    policy_sha256: str,
    activation_event_id: str,
    activation_epoch: int,
    configuration_sha256: str,
    kind: str,
    issued_at: int,
    reason: str,
    predecessor_id: str | None = None,
    credential_id: str | None = None,
    lifetime_s: int = DEFAULT_LIFETIME_S,
) -> tuple[bytes, str]:
    """Return the canonical request bytes and their SHA-256 hex digest."""
    if kind not in KINDS:
        raise ValueError("principal kind refused")
    if hashlib.sha256(policy_text.encode("utf8")).hexdigest() != policy_sha256:
        raise ValueError("policy digest mismatch")
    if not 1 <= lifetime_s <= 86400:
        raise ValueError("lifetime refused")
    policy = json.loads(policy_text)
    value = {
        "version": 1,
        "purpose": "local-custody-credential-issue",
        "credentialId": credential_id or str(uuid.uuid4()),
        "tenantId": policy["tenantId"],
        "reason": reason,
        "policyId": policy["policyId"],
        "policySha256": policy_sha256,
        "activationEventId": activation_event_id,
        "activationEpoch": activation_epoch,
        "configurationSha256": configuration_sha256,
        "workloadId": policy["targetWorkloadId"],
        "principalKind": kind,
        "servicePrincipal": principal(policy, kind),
        "operatorId": policy["nominatedOperatorId"] if kind == "operator" else None,
        "predecessorId": predecessor_id,
        "issuedAt": issued_at,
        "expiresAt": issued_at + lifetime_s,
    }
    if value["configurationSha256"] != policy["deploymentBindingSha256"]:
        raise ValueError("issuer settings are not this policy's deployment binding")
    raw = canonical(value)
    return raw, hashlib.sha256(raw).hexdigest()
