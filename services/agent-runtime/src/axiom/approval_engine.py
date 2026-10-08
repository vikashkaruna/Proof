"""Approval Engine — Python mirror of the TypeScript implementation.

Used by the agent runtime's workers to validate approval tokens
issued by the BFF. Per ADR-2 / BR-1, the token is the gate.

The Python implementation MUST produce identical signatures to the
TypeScript one for the same canonicalised payload + key. Both
implementations use HMAC-SHA-256 over the canonicalised JSON.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .canonicalise import canonical_json, sha256_hex


@dataclass(frozen=True)
class ApprovalTokenSpec:
    plan_id: str
    action_ids: list[str]  # MUST be sorted before signing
    approver_id: str
    mode: str  # 'batch' | 'individual'
    concurrency: int
    stop_on_failure: bool
    expires_at: str  # ISO datetime
    nonce: str
    conditions: dict[str, Any] = field(default_factory=dict)

    def to_canonical(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "planId": self.plan_id,
            "actionIds": sorted(self.action_ids),
            "approverId": self.approver_id,
            "mode": self.mode,
            "concurrency": self.concurrency,
            "stopOnFailure": self.stop_on_failure,
            "expiresAt": self.expires_at,
            "nonce": self.nonce,
        }
        if self.conditions:
            d["conditions"] = self.conditions
        return d


@dataclass(frozen=True)
class SignedApprovalToken:
    spec: ApprovalTokenSpec
    signature: str


@dataclass(frozen=True)
class ValidationResult:
    valid: bool
    reason: str | None = None
    details: dict[str, Any] | None = None


class ApprovalEngine:
    """HMAC-SHA-256 signed approval tokens.

    The per-tenant secret is loaded from a dict (in production: AWS
    Secrets Manager). In dev, a single default key is used.
    """

    def __init__(self, signing_key: str | bytes | None = None):
        self._default_key: bytes | None
        if isinstance(signing_key, str):
            self._default_key = signing_key.encode("utf-8")
        elif isinstance(signing_key, bytes):
            self._default_key = signing_key
        else:
            self._default_key = None
        self._tenant_keys: dict[str, bytes] = {}
        self._used_nonces: set[str] = set()

    def set_tenant_key(self, tenant_id: str, key: str | bytes) -> None:
        if isinstance(key, str):
            key = key.encode("utf-8")
        self._tenant_keys[tenant_id] = key

    def _key_for(self, tenant_id: str) -> bytes:
        k = self._tenant_keys.get(tenant_id)
        if k is not None:
            return k
        if self._default_key is not None:
            return self._default_key
        raise ValueError(f"No approval signing key for tenant {tenant_id}")

    async def issue(
        self,
        tenant_id: str,
        plan_id: str,
        action_ids: list[str],
        approver_id: str,
        mode: str,
        concurrency: int,
        stop_on_failure: bool,
        expires_at: str,
    ) -> SignedApprovalToken:
        nonce = secrets.token_hex(16)
        spec = ApprovalTokenSpec(
            plan_id=plan_id,
            action_ids=sorted(action_ids),  # canonical order
            approver_id=approver_id,
            mode=mode,
            concurrency=concurrency,
            stop_on_failure=stop_on_failure,
            expires_at=expires_at,
            nonce=nonce,
        )
        signature = await self.sign(tenant_id, spec)
        return SignedApprovalToken(spec=spec, signature=signature)

    async def sign(self, tenant_id: str, spec: ApprovalTokenSpec) -> str:
        payload = canonical_json(spec.to_canonical())
        return hmac.new(
            self._key_for(tenant_id), payload.encode("utf-8"), hashlib.sha256
        ).hexdigest()

    async def verify(
        self, tenant_id: str, token: dict[str, Any]
    ) -> ValidationResult:
        if not isinstance(token, dict):
            return ValidationResult(valid=False, reason="malformed_token")
        spec_raw = token.get("spec")
        signature = token.get("signature")
        if not isinstance(spec_raw, dict) or not isinstance(signature, str):
            return ValidationResult(valid=False, reason="malformed_token")

        spec = ApprovalTokenSpec(
            plan_id=spec_raw["planId"],
            action_ids=list(spec_raw["actionIds"]),
            approver_id=spec_raw["approverId"],
            mode=spec_raw["mode"],
            concurrency=int(spec_raw["concurrency"]),
            stop_on_failure=bool(spec_raw["stopOnFailure"]),
            expires_at=spec_raw["expiresAt"],
            nonce=spec_raw["nonce"],
            conditions=spec_raw.get("conditions", {}),
        )
        expected = await self.sign(tenant_id, spec)
        if not hmac.compare_digest(expected, signature):
            return ValidationResult(valid=False, reason="signature_mismatch")

        # Expiry
        try:
            exp = datetime.fromisoformat(spec.expires_at.replace("Z", "+00:00"))
        except Exception:
            return ValidationResult(valid=False, reason="invalid_expiry_format")
        if exp < datetime.now(timezone.utc):
            return ValidationResult(valid=False, reason="expired", details={"expiresAt": spec.expires_at})

        # Nonce replay (in-memory; the DB is the source of truth)
        if spec.nonce in self._used_nonces:
            return ValidationResult(valid=False, reason="nonce_replay")

        return ValidationResult(valid=True)

    def is_action_covered(self, token: SignedApprovalToken, action_id: str) -> bool:
        return action_id in token.spec.action_ids

    async def token_hash(self, token: SignedApprovalToken) -> str:
        return sha256_hex(
            canonical_json({"spec": token.spec.to_canonical(), "signature": token.signature})
        )
