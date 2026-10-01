"""Samadhan — the Maker-Checker & Reconciler Agent (समाधान).

"I prove that execution matched your plan and your approval."

Samadhan is the third independent role in the dual-control architecture (W5.6).
It evaluates executed reality against approved scope, detects parameter drift,
refuses out-of-scope executions, and signs the dual-control maker-checker
reconciliation statement.

Architectural invariants:
- Samadhan holds NO mutating estate credentials (`can_mutate = False`).
- Samadhan writes Axiom internal state (reconciliations and audit ledger).
- Samadhan operates at L1 autonomy (dual-control attestation).
- Out-of-scope execution is detected and refused (`out_of_scope_executed`).
- Reconciliation statements are HMAC-signed with the approval signing key.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any, ClassVar, Literal

from pydantic import BaseModel, Field

from ..executor import ActionOutcome, ExecutorDb, ExecutorRefused
from ..verification import reconcile_batch
from .base import AgentName, AutonomyLevel, BaseAgent


class ActionOutcomeItem(BaseModel):
    action_id: str
    outcome: str  # 'succeeded' | 'failed' | 'rolled_back' | 'skipped'
    error_code: str | None = None
    rows_affected: int | None = None


class SamadhanInput(BaseModel):
    tenant_id: str = "00000000-0000-0000-0000-000000000001"
    plan_id: str = "00000000-0000-0000-0000-000000000001"
    batch_id: str = "00000000-0000-0000-0000-000000000001"
    correlation_id: str | None = None
    request_key: str = ""
    action_ids: list[str] = Field(default_factory=list)
    outcomes: list[Any] = Field(
        default_factory=list,
        description="List of action outcomes (ActionOutcome instances, ActionOutcomeItem models, or dicts)",
    )
    batch_status: str = "completed"
    approved_content_digest: str | None = None
    recomputed_content_digest: str | None = None
    content_digest_drift: bool = False
    signing_key: str | bytes | None = None
    raise_on_out_of_scope: bool = False
    engagement_id: str | None = None


class SamadhanOutput(BaseModel):
    batch_id: str
    verdict: Literal["clean", "drift_detected", "partial_execution", "out_of_scope"]
    unexecuted_count: int = 0
    content_digest_drift: bool = False
    statement: str
    statement_signature: str
    out_of_scope_action_ids: list[str] = Field(default_factory=list)
    reconciled_by: str = "samadhan"
    details: dict[str, Any] = Field(default_factory=dict)


def normalize_action_outcomes(raw_outcomes: list[Any]) -> list[ActionOutcome]:
    """Normalize a list of dicts, ActionOutcomeItems, or ActionOutcomes into ActionOutcome dataclasses."""
    normalized: list[ActionOutcome] = []
    for item in raw_outcomes:
        if isinstance(item, ActionOutcome):
            normalized.append(item)
        elif isinstance(item, dict):
            normalized.append(
                ActionOutcome(
                    action_id=str(item.get("action_id", "")),
                    outcome=str(item.get("outcome", "unknown")),
                    error_code=item.get("error_code"),
                    rows_affected=item.get("rows_affected"),
                )
            )
        elif hasattr(item, "action_id") and hasattr(item, "outcome"):
            normalized.append(
                ActionOutcome(
                    action_id=str(item.action_id),
                    outcome=str(item.outcome),
                    error_code=getattr(item, "error_code", None),
                    rows_affected=getattr(item, "rows_affected", None),
                )
            )
    return normalized


class SamadhanAgent(BaseAgent[SamadhanInput, SamadhanOutput]):
    name: ClassVar[AgentName] = AgentName.SAMADHAN
    version: ClassVar[str] = "0.1.0"
    autonomy: ClassVar[AutonomyLevel] = AutonomyLevel.L1
    can_mutate: ClassVar[bool] = False
    writes_axiom_state: ClassVar[bool] = True
    mutates_client_estate: ClassVar[bool] = False
    description: ClassVar[str] = (
        "Maker-Checker & Reconciler Agent. Evaluates executed reality against "
        "approved scope, detects parameter drift, refuses out-of-scope executions, "
        "and signs the dual-control statement."
    )
    one_liner: ClassVar[str] = "I prove that execution matched your plan and your approval."
    tool_scopes: ClassVar[tuple[str, ...]] = (
        "plan.read",
        "batch.read",
        "reconciliation.write",
        "ledger.append",
    )
    escalation_conditions: ClassVar[tuple[str, ...]] = (
        "out_of_scope_executed",
        "content_digest_drift",
        "swept_actions_present",
    )
    default_task_kind: ClassVar[Any] = "reasoning"
    default_pii_redact: ClassVar[bool] = True

    def input_schema(self) -> type[SamadhanInput]:
        return SamadhanInput

    def output_schema(self) -> type[SamadhanOutput]:
        return SamadhanOutput

    async def reconcile(
        self,
        input_data: SamadhanInput | dict[str, Any],
        *,
        db: ExecutorDb | None = None,
        correlation_id: str | None = None,
    ) -> SamadhanOutput:
        """Direct helper to evaluate and reconcile without full agent invoke wrapper."""
        parsed = (
            input_data
            if isinstance(input_data, SamadhanInput)
            else SamadhanInput.model_validate(input_data)
        )
        return await self._run(
            correlation_id=correlation_id or "00000000-0000-0000-0000-000000000001",
            input=parsed,
            db=db,
        )

    async def _run(
        self, *, correlation_id: str, input: SamadhanInput, **deps: Any
    ) -> SamadhanOutput:
        normalized_outcomes = normalize_action_outcomes(input.outcomes)

        # 1. Scope Evaluation: detect any actions executed that were not approved
        approved_set = set(input.action_ids) if input.action_ids else set()
        out_of_scope_ids: list[str] = []
        if approved_set:
            out_of_scope_ids = [
                o.action_id for o in normalized_outcomes if o.action_id not in approved_set
            ]
        is_out_of_scope = len(out_of_scope_ids) > 0

        if is_out_of_scope and input.raise_on_out_of_scope:
            raise ExecutorRefused("out_of_scope_executed")

        # 2. Parameter Drift Evaluation
        content_digest_drift = input.content_digest_drift
        if (
            input.approved_content_digest is not None
            and input.recomputed_content_digest is not None
            and input.approved_content_digest != input.recomputed_content_digest
        ):
            content_digest_drift = True

        # 3. Unexecuted / Swept Actions Calculation
        counts: dict[str, int] = {}
        for o in normalized_outcomes:
            counts[o.outcome] = counts.get(o.outcome, 0) + 1

        unexecuted_count = counts.get("skipped", 0)
        settled_ids = {o.action_id for o in normalized_outcomes}
        for aid in input.action_ids:
            if aid not in settled_ids:
                unexecuted_count += 1

        # 4. Database RPC Call (if ExecutorDb passed in deps)
        db: ExecutorDb | None = deps.get("db")
        signing_key = input.signing_key or self.settings.approval_signing_key
        if not signing_key:
            raise ExecutorRefused("reconciliation_signing_key_unavailable")
        rec_result: dict[str, Any] | None = None
        if db is not None:
            try:
                rec_result = await reconcile_batch(
                    db=db,
                    payload=input,
                    batch_id=input.batch_id,
                    batch_status=input.batch_status,
                    outcomes=normalized_outcomes,
                    signing_key=signing_key,
                    ledger=self.ledger,
                )
                if isinstance(rec_result, dict) and "reconciliation" in rec_result:
                    rec_info = rec_result["reconciliation"]
                    if "unexecuted" in rec_info and rec_info["unexecuted"] is not None:
                        unexecuted_count = rec_info["unexecuted"]
                    if (
                        "content_digest_drift" in rec_info
                        and rec_info["content_digest_drift"] is not None
                    ):
                        content_digest_drift = rec_info["content_digest_drift"]
            except ExecutorRefused:
                # A DB refusal cannot become an attestation assembled from
                # caller-supplied outcomes, regardless of the helper's
                # out-of-scope presentation flag.
                raise

        # 5. Build Human-Readable Dual-Control Statement
        parts = [
            f"Batch {input.batch_id} (request {input.request_key}) finished {input.batch_status}.",
            f"Approved {len(input.action_ids)} action(s): "
            + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())),
        ]
        if unexecuted_count:
            parts.append(
                f"{unexecuted_count} approved action(s) did not execute and returned to `approved`; "
                "they remain retryable only under a fresh approval."
            )
        if content_digest_drift:
            parts.append(
                "Parameter drift detected: recomputed content digest does not match approved digest."
            )
        if is_out_of_scope:
            parts.append(
                f"Out of scope execution detected for actions: {sorted(out_of_scope_ids)}."
            )

        statement = " ".join(parts)
        verification_failed = False

        # The persisted statement must be exactly the DB-computed statement;
        # prose assembled from the dispatch payload cannot attest DB facts.
        if rec_result is not None:
            recorded_statement = rec_result.get("statement")
            recorded_signature = rec_result.get("statement_signature")
            if not isinstance(recorded_statement, str) or not isinstance(recorded_signature, str):
                raise ExecutorRefused("reconciliation_record_unconfirmed")
            try:
                facts = json.loads(recorded_statement)
            except (TypeError, ValueError) as exc:
                raise ExecutorRefused("reconciliation_source_unavailable") from exc
            if (
                not isinstance(facts, dict)
                or facts.get("schema_version") != 2
                or not isinstance(facts.get("action_outcomes"), dict)
                or not isinstance(facts.get("unexecuted"), list)
                or not isinstance(facts.get("verification_results"), list)
                or not isinstance(facts.get("content_digest_drift"), bool)
                or not isinstance(facts.get("batch_status"), str)
            ):
                raise ExecutorRefused("reconciliation_source_unavailable")
            counts = {}
            for outcome in facts["action_outcomes"].values():
                if not isinstance(outcome, str):
                    raise ExecutorRefused("reconciliation_source_unavailable")
                counts[outcome] = counts.get(outcome, 0) + 1
            unexecuted_count = len(facts["unexecuted"])
            content_digest_drift = facts["content_digest_drift"]
            batch_status = facts["batch_status"]
            verification_failed = any(
                isinstance(result, dict) and result.get("outcome") == "failed"
                for result in facts["verification_results"]
            )
            is_out_of_scope = False
            out_of_scope_ids = []
            statement = recorded_statement
            statement_signature = recorded_signature
        else:
            batch_status = input.batch_status
            raw_key = signing_key if isinstance(signing_key, bytes) else signing_key.encode("utf-8")
            statement_signature = hmac.new(raw_key, statement.encode("utf-8"), hashlib.sha256).hexdigest()

        # 7. Formulate Verdict
        if is_out_of_scope:
            verdict = "out_of_scope"
        elif content_digest_drift:
            verdict = "drift_detected"
        elif (
            unexecuted_count > 0
            or batch_status in ("partial_failure", "failed", "halted")
            or counts.get("failed", 0) > 0
            or counts.get("rolled_back", 0) > 0
            or verification_failed
        ):
            verdict = "partial_execution"
        else:
            verdict = "clean"

        return SamadhanOutput(
            batch_id=input.batch_id,
            verdict=verdict,
            unexecuted_count=unexecuted_count,
            content_digest_drift=content_digest_drift,
            statement=statement,
            statement_signature=statement_signature,
            out_of_scope_action_ids=out_of_scope_ids,
            reconciled_by="samadhan",
            details={
                "counts": counts,
                "batch_status": batch_status,
                "is_out_of_scope": is_out_of_scope,
                "source_bound": rec_result is not None,
                "verification_failed": verification_failed,
                "db_reconciliation": rec_result,
            },
        )
