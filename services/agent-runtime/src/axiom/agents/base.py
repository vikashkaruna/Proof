"""Agent base class.

All 10 agents share a common contract:
  - inputs (validated against a Pydantic model)
  - outputs (validated against a Pydantic model)
  - tool scopes (declared; runtime enforces)
  - autonomy level (L0..L4)
  - escalation conditions

The base class provides:
  - Correlation IDs that propagate to the ledger
  - Ledger appends with agent identity, model, prompt hash
  - Model gateway calls with PII-redaction defaults
  - Standard error handling (failures go to the ledger)

Per Doc 04 §5.2:
  - Planning agent (Sudhaar) holds NO write credentials
  - Execution agent (Karya) requires a signed approval token
  - Audit agent (Lekha) only appends to the ledger
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, ClassVar, Generic, TypeVar

import structlog
from pydantic import BaseModel

from ..canonicalise import canonical_json, sha256_hex
from ..config import Settings, get_settings
from ..evidence_client import EvidenceVault
from ..ledger_client import AppendInput, LedgerClient, new_correlation_id
from ..model_gateway import ModelGateway, TaskKind


class AuditCompletionFailed(RuntimeError):
    """Mandatory completion evidence was not durably acknowledged."""


class AutonomyLevel(str, Enum):
    L0 = "L0"  # Agent-assisted, human does everything client-facing
    L1 = "L1"  # Agent-proposes, human reviews every output
    L2 = "L2"  # Agent-executes-on-approval
    L3 = "L3"  # Continuous with exception review
    L4 = "L4"  # Policy-governed autonomy


class AgentName(str, Enum):
    DRISHTI = "drishti"
    VIBHAAG = "vibhaag"
    PARIKSHAN = "parikshan"
    SAAKSHI = "saakshi"
    SUDHAAR = "sudhaar"
    KARYA = "karya"
    LEKHA = "lekha"
    NAZAR = "nazar"
    PRATIVEDAN = "prativedan"
    SANKET = "sanket"


@dataclass(frozen=True)
class AgentRunResult:
    """The result of an agent invocation."""

    agent: AgentName
    correlation_id: str
    status: str  # "succeeded" | "failed" | "cancelled" | "timed_out"
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0
    error: str | None = None
    output: dict[str, Any] | None = None
    ledger_entry_ids: list[str] = field(default_factory=list)
    evidence_ids: list[str] = field(default_factory=list)


InputT = TypeVar("InputT", bound=BaseModel)
OutputT = TypeVar("OutputT", bound=BaseModel)


class BaseAgent(ABC, Generic[InputT, OutputT]):
    """Base class for all 10 agents."""

    name: ClassVar[AgentName]
    version: ClassVar[str] = "0.1.0"
    autonomy: ClassVar[AutonomyLevel] = AutonomyLevel.L1
    description: ClassVar[str] = ""
    one_liner: ClassVar[str] = ""
    tool_scopes: ClassVar[tuple[str, ...]] = ()
    escalation_conditions: ClassVar[tuple[str, ...]] = ()
    # The default task kind for this agent's LLM calls
    default_task_kind: ClassVar[TaskKind] = "reasoning"
    # Whether outputs typically need redacting before egress
    default_pii_redact: ClassVar[bool] = True
    # Whether this agent can mutate external state (architectural)
    can_mutate: ClassVar[bool] = False
    # Explicit metadata, not credentials or an authorization decision.
    mutates_client_estate: ClassVar[bool] = False
    # Domain records only; excludes ordinary run/audit telemetry.
    writes_axiom_state: ClassVar[bool] = False

    def __init__(
        self,
        *,
        settings: Settings | None = None,
        ledger: LedgerClient | None = None,
        evidence: EvidenceVault | None = None,
        model_gateway: ModelGateway | None = None,
    ):
        self.settings = settings or get_settings()
        self.ledger = ledger or LedgerClient.from_settings(self.settings)
        self.evidence = evidence or EvidenceVault(self.settings)
        self.model_gateway = model_gateway or ModelGateway(self.settings)
        self.log = structlog.get_logger(agent=self.name.value, version=self.version)

    @abstractmethod
    def input_schema(self) -> type[InputT]: ...

    @abstractmethod
    def output_schema(self) -> type[OutputT]: ...

    @abstractmethod
    async def _run(self, *, correlation_id: str, input: InputT, **deps: Any) -> OutputT: ...

    async def invoke(
        self,
        raw_input: dict[str, Any] | InputT,
        *,
        correlation_id: str | None = None,
    ) -> AgentRunResult:
        """Validate input, run, log to ledger. Top-level entry point."""
        correlation_id = correlation_id or new_correlation_id()
        t0 = time.monotonic()
        entry_ids: list[str] = []

        # Revalidate even BaseModel inputs; an unrelated model instance is not
        # authority to bypass this agent's declared input contract.
        try:
            payload = (
                raw_input.model_dump(mode="python")
                if isinstance(raw_input, BaseModel)
                else (raw_input or {})
            )
            input_obj = self.input_schema().model_validate(payload)
            input_hash = sha256_hex(canonical_json(input_obj.model_dump(mode="json")))
        except Exception:
            self.log.error("agent.input_validation_failed")
            return AgentRunResult(
                agent=self.name,
                correlation_id=correlation_id,
                status="failed",
                error="validation_failed",
            )

        tenant_id = getattr(input_obj, "tenant_id", None) or "00000000-0000-0000-0000-000000000001"
        engagement_id = getattr(input_obj, "engagement_id", None)

        # Initial "started" ledger entry
        try:
            r = await self.ledger.append(
                AppendInput(
                    tenant_id=tenant_id,
                    correlation_id=correlation_id,
                    actor_type="agent",
                    actor_id=self.name.value,
                    agent_version=self.version,
                    action_type=self._started_action_type(),
                    target_ref=engagement_id,
                    result="pending",
                    input_hash=input_hash,
                    detail={"phase": "started"},
                )
            )
            entry_ids.append(r.id)
        except Exception:  # noqa: BLE001
            self.log.error("ledger.append.started_failed")
            # Per BR-3 we cannot proceed without a ledger record; bail.
            return AgentRunResult(
                agent=self.name,
                correlation_id=correlation_id,
                status="failed",
                error="ledger_append_failed",
            )

        try:
            raw_output = await self._run(correlation_id=correlation_id, input=input_obj)
            output = self.output_schema().model_validate(
                raw_output.model_dump(mode="python")
                if isinstance(raw_output, BaseModel)
                else raw_output
            )
            output_hash = sha256_hex(canonical_json(output.model_dump(mode="json")))
            latency_ms = int((time.monotonic() - t0) * 1000)
            total_tokens = sum(getattr(output, "_tokens", lambda: 0)() for _ in [0])  # type: ignore[func-returns-value]
            cost_usd = 0.0
            input_tokens = 0
            output_tokens = 0

            # Mark started entry as success
            try:
                r2 = await self.ledger.append(
                    AppendInput(
                        tenant_id=tenant_id,
                        correlation_id=correlation_id,
                        actor_type="agent",
                        actor_id=self.name.value,
                        agent_version=self.version,
                        action_type=self._completed_action_type(),
                        target_ref=engagement_id,
                        result="success",
                        input_hash=input_hash,
                        output_hash=output_hash,
                        detail={"phase": "completed", "started_entry": entry_ids[0]},
                    )
                )
                entry_ids.append(r2.id)
            except Exception:  # noqa: BLE001
                self.log.error("ledger.append.completed_failed")
                raise AuditCompletionFailed() from None

            return AgentRunResult(
                agent=self.name,
                correlation_id=correlation_id,
                status="succeeded",
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                total_tokens=total_tokens,
                cost_usd=cost_usd,
                latency_ms=latency_ms,
                output=output.model_dump(mode="json"),
                ledger_entry_ids=entry_ids,
            )
        except Exception as e:  # noqa: BLE001
            latency_ms = int((time.monotonic() - t0) * 1000)
            failure_code = (
                "audit_completion_failed"
                if isinstance(e, AuditCompletionFailed)
                else "agent_failed"
            )
            self.log.error("agent.failed", failure_code=failure_code)
            try:
                r2 = await self.ledger.append(
                    AppendInput(
                        tenant_id=tenant_id,
                        correlation_id=correlation_id,
                        actor_type="agent",
                        actor_id=self.name.value,
                        agent_version=self.version,
                        action_type=self._completed_action_type(),
                        target_ref=engagement_id,
                        result="failure",
                        input_hash=input_hash,
                        detail={
                            "phase": "failed",
                            "started_entry": entry_ids[0],
                            "failure_code": failure_code,
                        },
                    )
                )
                entry_ids.append(r2.id)
            except Exception:  # noqa: BLE001
                # The run already failed; record that its failure entry is missing.
                self.log.error("agent.failure_ledger_append_failed")
            return AgentRunResult(
                agent=self.name,
                correlation_id=correlation_id,
                status="failed",
                latency_ms=latency_ms,
                error=failure_code,
                ledger_entry_ids=entry_ids,
            )

    def _started_action_type(self) -> str:
        mapping = {
            AgentName.DRISHTI: "discovery.started",
            AgentName.VIBHAAG: "classification.started",
            AgentName.PARIKSHAN: "assessment.started",
            AgentName.SAAKSHI: "evidence.collected",
            AgentName.SUDHAAR: "plan.generated",
            AgentName.KARYA: "execution.started",
            AgentName.LEKHA: "execution.started",
            AgentName.NAZAR: "report.generated",
            AgentName.PRATIVEDAN: "report.generated",
            AgentName.SANKET: "report.generated",
        }
        return mapping.get(self.name, "report.generated")

    def _completed_action_type(self) -> str:
        # The "completed" event for an agent run uses the same domain
        # action as the started event; the ledger groups them via
        # correlation_id.
        return self._started_action_type()
