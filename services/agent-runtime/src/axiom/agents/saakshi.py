"""Saakshi — seal only a durable, manager-authorized evidence ingestion.

The ordinary runtime does not yet compose this trusted capability. It fails
closed before storage access. Human upload through the BFF is the active
producer; no agent service credential can substitute for its settlement gate.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, ClassVar, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from ..canonicalise import sha256_hex
from ..evidence_client import EvidenceVault, SealInput
from .base import AgentName, AutonomyLevel, BaseAgent


class SaakshiInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tenant_id: str = Field(pattern=r"^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
    engagement_id: str | None = None
    evidence_type: Literal[
        "document", "config", "screenshot", "log", "attestation", "interview", "inventory", "report"
    ]
    description: str | None = Field(default=None, max_length=2000)
    content: str = Field(min_length=1, max_length=2 * 1024 * 1024)
    filename: str | None = Field(default=None, max_length=240)
    mime_type: str = Field(min_length=1, max_length=200)
    demonstrates_control_ids: list[str] = Field(default_factory=list, max_length=100)
    legal_hold: bool = False


@dataclass(frozen=True)
class EvidenceIngestionCapability:
    """Internal capability, never reconstructed from SaakshiInput or HTTP JSON.

    intent_json is a frozen copy of an already-persisted pending DB operation.
    settle must call the authorized BFF composition, retaining its live actor
    checks; it cannot be a generic service-role evidence upsert.
    """

    intent_json: str
    settle: Callable[[dict[str, Any]], Awaitable[str]]


class SaakshiOutput(BaseModel):
    content_hash: str
    storage_uri: str
    byte_size: int
    sealed_at: str
    retain_until: str
    evidence_id: str = Field(min_length=1)
    demonstrates_control_ids: list[str]
    version_id: str = Field(min_length=1)


class SaakshiAgent(BaseAgent[SaakshiInput, SaakshiOutput]):
    name: ClassVar[AgentName] = AgentName.SAAKSHI
    writes_axiom_state: ClassVar[bool] = True
    description: ClassVar[str] = "Seal a reviewed evidence ingestion into the WORM-locked vault."
    one_liner: ClassVar[str] = "I am your witness."
    tool_scopes: ClassVar[tuple[str, ...]] = ("evidence.write", "s3.write_worm")
    autonomy: ClassVar[AutonomyLevel] = AutonomyLevel.L1
    default_task_kind: ClassVar[Any] = "structural"
    default_pii_redact: ClassVar[bool] = False

    def input_schema(self) -> type[SaakshiInput]:
        return SaakshiInput

    def output_schema(self) -> type[SaakshiOutput]:
        return SaakshiOutput

    async def _run(self, *, correlation_id: str, input: SaakshiInput, **deps: Any) -> SaakshiOutput:
        capability = deps.get("evidence_ingestion")
        if not isinstance(capability, EvidenceIngestionCapability):
            raise RuntimeError("evidence_ingestion_capability_required")
        # All validation happens before opening storage. Identity and storage
        # placement are frozen by the trusted pending intent, not input defaults.
        intent = json.loads(capability.intent_json)
        request = intent["request"]
        operation_id = str(UUID(intent["id"]))
        operation_key = str(UUID(intent["operation_key"]))
        body = input.content.encode("utf-8")
        content_hash = sha256_hex(body)
        expected = {
            "content_hash": content_hash,
            "byte_size": len(body),
            "mime_type": input.mime_type,
            "filename": input.filename,
            "evidence_type": input.evidence_type,
            "description": input.description,
            "control_ids": input.demonstrates_control_ids,
            "engagement_id": input.engagement_id,
            "collected_by_agent": self.name.value,
            "retention_policy": "seven_years",
            "legal_hold": input.legal_hold,
        }
        key = f"tenants/{input.tenant_id}/evidence-ingestions/{operation_key}/{content_hash}"
        if (
            intent.get("status") != "pending"
            or intent.get("tenant_id") != input.tenant_id
            or intent.get("correlation_id") != correlation_id
            or request.get("object_key") != key
            or request.get("provider") not in ("s3", "s3-compatible")
            or request.get("bucket") != self.settings.axiom_evidence_bucket
            or any(request.get(k) != value for k, value in expected.items())
        ):
            raise RuntimeError("evidence_ingestion_intent_mismatch")
        retain_until = datetime.fromisoformat(intent["retain_until"].replace("Z", "+00:00"))
        if retain_until.tzinfo is None:
            raise RuntimeError("evidence_ingestion_intent_mismatch")
        vault: EvidenceVault = deps.get("evidence") or self.evidence
        try:
            sealed = await asyncio.to_thread(
                vault.seal,
                SealInput(
                    bucket=request["bucket"],
                    key=key,
                    body=body,
                    content_type=input.mime_type,
                    retention_days=2555,
                    retain_until=retain_until,
                    tenant_id=input.tenant_id,
                    engagement_id=input.engagement_id,
                    collected_by_agent=self.name.value,
                    legal_hold=input.legal_hold,
                    operation_id=operation_id,
                ),
            )
            receipt = {
                "provider": request["provider"],
                "bucket": sealed.bucket,
                "object_key": sealed.key,
                "version_id": sealed.version_id,
                "content_hash": sealed.content_hash,
                "byte_size": sealed.byte_size,
                "tenant_id": input.tenant_id,
                "engagement_id": input.engagement_id,
                "collected_by_agent": self.name.value,
                "retain_until": sealed.retain_until.isoformat(),
                "readback_at": sealed.readback_at.isoformat(),
                "lock_mode": sealed.lock_mode,
                "verified": sealed.retention_assurance == "verified",
                "legal_hold": sealed.legal_hold,
                "encryption": sealed.encryption,
                "operation_id": operation_id,
                "correlation_id": correlation_id,
            }
            evidence_id = str(UUID(await capability.settle(receipt)))
        except Exception:
            # The durable intent remains pending. Provider diagnostics can
            # contain personal data; never log or return their raw contents.
            raise RuntimeError("evidence_ingestion_pending_reconciliation") from None
        return SaakshiOutput(
            content_hash=sealed.content_hash,
            storage_uri=sealed.storage_uri,
            byte_size=sealed.byte_size,
            sealed_at=sealed.readback_at.isoformat(),
            retain_until=sealed.retain_until.isoformat(),
            evidence_id=evidence_id,
            demonstrates_control_ids=input.demonstrates_control_ids,
            version_id=sealed.version_id,
        )
