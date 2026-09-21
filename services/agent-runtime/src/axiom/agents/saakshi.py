"""Saakshi — the Evidence Agent.

"I am your witness."

Saakshi seals every piece of supporting evidence — policies,
screenshots, configs, attestations — with a content hash and stores
it in the WORM-locked evidence vault. Each artifact is linked to
the controls it demonstrates.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, ClassVar, Literal

from pydantic import BaseModel, Field

from ..canonicalise import sha256_hex
from ..evidence_client import EvidenceVault, SealInput, content_key
from .base import AgentName, AutonomyLevel, BaseAgent


class SaakshiInput(BaseModel):
    tenant_id: str = "00000000-0000-0000-0000-000000000001"
    engagement_id: str | None = None
    evidence_type: Literal[
        "document",
        "config",
        "screenshot",
        "log",
        "attestation",
        "interview",
        "inventory",
        "report",
    ] = "document"
    description: str = "Automated compliance evidence seal"
    content: str = "Axiom Proof automated statutory compliance attestation"
    filename: str | None = None
    mime_type: str = "text/plain"
    demonstrates_control_ids: list[str] = Field(default_factory=list)
    retention_days: int = Field(default=2555, gt=0)  # 7 years default
    legal_hold: bool = False


class SaakshiOutput(BaseModel):
    content_hash: str
    storage_uri: str
    byte_size: int
    sealed_at: str
    retain_until: str
    evidence_id: str
    demonstrates_control_ids: list[str]
    version_id: str | None = None


class SaakshiAgent(BaseAgent[SaakshiInput, SaakshiOutput]):
    name: ClassVar[AgentName] = AgentName.SAAKSHI
    writes_axiom_state: ClassVar[bool] = True
    description: ClassVar[str] = "Seal an evidence artifact into the WORM-locked vault."
    one_liner: ClassVar[str] = "I am your witness."
    tool_scopes: ClassVar[tuple[str, ...]] = ("evidence.write", "s3.write_worm")
    autonomy: ClassVar[AutonomyLevel] = AutonomyLevel.L1
    default_task_kind: ClassVar[Any] = "structural"
    default_pii_redact: ClassVar[bool] = False

    def input_schema(self) -> type[SaakshiInput]:
        return SaakshiInput

    def output_schema(self) -> type[SaakshiOutput]:
        return SaakshiOutput

    async def _run(
        self, *, correlation_id: str, input: SaakshiInput, **deps: Any
    ) -> SaakshiOutput:
        body = (input.content or "").encode("utf-8")
        if not body:
            raise ValueError("Saakshi requires non-empty content")

        content_hash = sha256_hex(body)
        key = content_key(
            tenant_id=input.tenant_id,
            engagement_id=input.engagement_id,
            content_hash=content_hash,
            filename=input.filename,
        )

        bucket = self.settings.axiom_evidence_bucket
        # Use the provided evidence vault, or instantiate one with our settings
        vault: EvidenceVault = deps.get("evidence") or self.evidence

        sealed = vault.seal(
            SealInput(
                bucket=bucket,
                key=key,
                body=body,
                content_type=input.mime_type,
                retention_days=input.retention_days,
                tenant_id=input.tenant_id,
                engagement_id=input.engagement_id,
                collected_by_agent=self.name.value,
                legal_hold=input.legal_hold,
                metadata={
                    "axiom-evidence-type": input.evidence_type,
                    "axiom-correlation-id": correlation_id,
                    "axiom-demonstrates": ",".join(input.demonstrates_control_ids),
                },
            )
        )

        # Persist the evidence row in Supabase so it shows up in queries
        from supabase import create_client

        supabase = create_client(self.settings.supabase_url, self.settings.supabase_service_key)
        # The content_hash is the canonical key for de-duplication;
        # if the same content was sealed before, the unique constraint
        # on (tenant_id, content_hash) would have caught it.
        # We do an upsert keyed on (tenant_id, content_hash).
        try:
            r = supabase.table("evidence").upsert(
                {
                    "tenant_id": input.tenant_id,
                    "engagement_id": input.engagement_id,
                    "content_hash": content_hash,
                    "storage_uri": sealed.storage_uri,
                    "filename": input.filename,
                    "mime_type": input.mime_type,
                    "byte_size": sealed.byte_size,
                    "evidence_type": input.evidence_type,
                    "description": input.description,
                    "collected_by_agent": self.name.value,
                    "demonstrates_control_ids": input.demonstrates_control_ids,
                    "worm_lock_until": sealed.retain_until.isoformat(),
                },
                on_conflict="tenant_id,content_hash",
            ).execute()
            evidence_id = r.data[0]["id"] if r.data else ""
        except Exception as e:
            # Don't fail the seal just because the DB row couldn't be written;
            # log and continue. The S3 object is the source of truth.
            self.log.error("evidence_row_upsert_failed", err=str(e))
            evidence_id = ""

        sealed_at = datetime.now(timezone.utc).isoformat()
        return SaakshiOutput(
            content_hash=content_hash,
            storage_uri=sealed.storage_uri,
            byte_size=sealed.byte_size,
            sealed_at=sealed_at,
            retain_until=sealed.retain_until.isoformat(),
            evidence_id=evidence_id,
            demonstrates_control_ids=input.demonstrates_control_ids,
            version_id=sealed.version_id,
        )
