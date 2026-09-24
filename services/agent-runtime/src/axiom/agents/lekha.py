"""Lekha — the Audit & Traceability Agent.

"I remember everything, forever."

Lekha writes the immutable, hash-chained audit ledger. Every agent
action, every human approval, every state change — recorded in order,
with a chain verifiable end-to-end.

In practice, agents call the `append_ledger` Postgres function
directly via the LedgerClient. Lekha is the workflow agent that
reconstructs chains, generates audit reports, and verifies integrity.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, ClassVar

from pydantic import BaseModel, Field

from .base import AgentName, AutonomyLevel, BaseAgent


class LekhaInput(BaseModel):
    tenant_id: str = "00000000-0000-0000-0000-000000000001"
    operation: str = "verify"  # 'verify' | 'reconstruct' | 'export'
    correlation_id: str | None = None  # for reconstruct
    from_sequence: int = 1
    to_sequence: int | None = None
    export_format: str = "json"  # 'json' | 'csv'


class LekhaOutput(BaseModel):
    operation: str
    intact: bool | None = None
    first_break: dict[str, Any] | None = None
    chain: list[dict[str, Any]] = Field(default_factory=list)
    export_uri: str | None = None
    notes: str = ""


class LekhaAgent(BaseAgent[LekhaInput, LekhaOutput]):
    name: ClassVar[AgentName] = AgentName.LEKHA
    writes_axiom_state: ClassVar[bool] = True
    description: ClassVar[str] = "Audit ledger queries: verify, reconstruct, export."
    one_liner: ClassVar[str] = "I remember everything, forever."
    tool_scopes: ClassVar[tuple[str, ...]] = ("ledger.append", "ledger.read")
    autonomy: ClassVar[AutonomyLevel] = AutonomyLevel.L1
    can_mutate: ClassVar[bool] = False  # append-only on the ledger
    default_task_kind: ClassVar[Any] = "structural"
    default_pii_redact: ClassVar[bool] = False

    def input_schema(self) -> type[LekhaInput]:
        return LekhaInput

    def output_schema(self) -> type[LekhaOutput]:
        return LekhaOutput

    async def _run(
        self, *, correlation_id: str, input: LekhaInput, **deps: Any
    ) -> LekhaOutput:
        if input.operation == "verify":
            result = await self.ledger.verify(input.tenant_id, input.from_sequence)
            return LekhaOutput(
                operation="verify",
                intact=bool(result.get("intact")),
                first_break=result.get("firstBreak"),
            )
        elif input.operation == "reconstruct":
            if not input.correlation_id:
                raise ValueError("reconstruct requires a correlation_id")
            entries = await self.ledger.query(
                tenant_id=input.tenant_id,
                correlation_id=input.correlation_id,
                limit=1000,
            )
            return LekhaOutput(
                operation="reconstruct",
                chain=sorted(entries, key=lambda e: e.get("sequence_no", 0)),
                notes=f"Reconstructed {len(entries)} entries for correlation {input.correlation_id}",
            )
        elif input.operation == "export":
            entries = await self.ledger.query(
                tenant_id=input.tenant_id,
                from_sequence=input.from_sequence,
                to_sequence=input.to_sequence,
                limit=10_000,
            )
            # In a real export we'd write to a sealed evidence artifact
            # and return the S3 URI. For now, we return the data inline.
            return LekhaOutput(
                operation="export",
                chain=entries,
                notes=f"Exported {len(entries)} entries",
            )
        else:
            raise ValueError(f"Unknown operation: {input.operation}")
