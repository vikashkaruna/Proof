"""Unmounted one-shot renderer adapter for trusted finalized assessment snapshots.

No HTTP route, database implementation, source credentials or settlement path is
provided here. Raw PostgreSQL source/request bytes and actual Python normalized
input/output bytes occupy distinct hash domains. Claimed uncertainty is terminal
for invocation: only a future fenced controller may reconcile stored receipts.
"""

from __future__ import annotations

import json
import math
from datetime import datetime
from typing import Annotated, Any, Literal, Protocol
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .agents.base import AgentName, RendererDispatchContext
from .agents.parikshan import QuestionnaireProvenance
from .agents.prativedan import PrativedanAgent, PrativedanInput, PrativedanOutput
from .canonicalise import canonical_json, sha256_hex
from .ledger_client import AppendOnlyLedgerClient
from .prativedan_renderer_config import renderer_commitment, renderer_config

MAX_SOURCE_BYTES = 4_194_304
MAX_REQUEST_BYTES = 4096
MAX_PACKET_BYTES = MAX_SOURCE_BYTES
MAX_INPUT_BYTES = 1_048_576
MAX_OUTPUT_BYTES = 2_097_152
Identifier = Annotated[
    str, Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
]
Digest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class ReceiptReference(Contract):
    id: str = Field(pattern=r"^[1-9][0-9]{0,18}$")
    entry_hash: Digest

    @field_validator("id")
    @classmethod
    def bigint(cls, value: str) -> str:
        if int(value) > 9_223_372_036_854_775_807:
            raise ValueError("Receipt exceeds signed bigint")
        return value


class PrativedanDraftInvokeRequest(Contract):
    tenant_id: Identifier
    engagement_id: Identifier
    source_id: Identifier
    assessment_run_id: Identifier
    run_id: Identifier
    operation_key: Identifier


class AssessmentReceipts(Contract):
    started: ReceiptReference
    completed: ReceiptReference
    finalized: ReceiptReference


class FrozenBoardSource(Contract):
    schema_version: Literal[1]
    serialization: Literal["postgres-jsonb-text-v1"]
    kind: Literal["board_source"]
    request_id: Identifier
    tenant_id: Identifier
    engagement_id: Identifier
    assessment_run_id: Identifier
    library_version: str = Field(min_length=1, max_length=200)
    controls_text: str = Field(min_length=1, max_length=MAX_PACKET_BYTES)
    controls_sha256: Digest
    result_text: str = Field(min_length=1, max_length=MAX_PACKET_BYTES)
    result_sha256: Digest
    completed_at: str
    finalized_at: str
    receipts: AssessmentReceipts
    limitations: list[str] = Field(max_length=50)


class TrustedBoardSource(Contract):
    source_id: Identifier
    tenant_id: Identifier
    engagement_id: Identifier
    assessment_run_id: Identifier
    library_version: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=300)
    source_text: str = Field(min_length=1, max_length=MAX_SOURCE_BYTES)
    source_sha256: Digest
    controls_sha256: Digest
    result_sha256: Digest
    receipts: AssessmentReceipts


class RendererCommitment(Contract):
    renderer_config_version: Literal["prativedan-draft-v1"]
    renderer_config_sha256: Digest


class RecordedPrativedanDispatch(PrativedanDraftInvokeRequest, RendererCommitment):
    request_text: str = Field(min_length=1, max_length=MAX_REQUEST_BYTES)
    request_sha256: Digest
    source_sha256: Digest
    requested_receipt: ReceiptReference


class PrativedanDispatchClaim(PrativedanDraftInvokeRequest, RendererCommitment):
    request_sha256: Digest
    source_sha256: Digest
    runtime_normalized_input_sha256: Digest
    claimed: bool
    expires_at_ms: int = Field(gt=0)


class RuntimeReceipt(ReceiptReference):
    tenant_id: Identifier
    correlation_id: Identifier
    actor_type: Literal["agent"]
    actor_id: Literal["prativedan"]
    agent_version: str = Field(min_length=1, max_length=80)
    action_type: Literal["report.generated"]
    target_ref: Identifier
    input_hash: Digest
    output_hash: Digest | None
    result: Literal["pending", "success"]
    detail: dict[str, Any]


class RuntimeReceipts(Contract):
    started: RuntimeReceipt
    completed: RuntimeReceipt


class PrativedanDraftEnvelope(PrativedanDraftInvokeRequest, RendererCommitment):
    renderer_config_text: str
    agent: Literal["prativedan"] = "prativedan"
    agent_version: str
    correlation_id: Identifier
    target_ref: Identifier
    source_sha256: Digest
    request_sha256: Digest
    normalized_input_text: str
    runtime_normalized_input_sha256: Digest
    runtime_output_text: str
    runtime_output_sha256: Digest
    output: dict[str, Any]
    requested_receipt: ReceiptReference
    started_receipt: ReceiptReference
    completed_receipt: ReceiptReference
    review_required: Literal[True] = True
    citation_verification: Literal["unverified_references"] = "unverified_references"


class PrativedanDraftStore(Protocol):
    async def read_prativedan_source(self, **identifiers: str) -> object: ...
    async def load_prativedan_dispatch(self, **identifiers: str) -> object: ...
    async def claim_prativedan_dispatch(self, **bindings: str) -> object: ...
    async def read_prativedan_runtime_receipts(self, **bindings: str) -> object: ...


class PrativedanDraftRefusedError(ValueError):
    """Source authority or byte bindings could not be proved before invocation."""


class PrativedanDraftUncertainError(RuntimeError):
    """A claimed attempt must never be redispatched or backfilled from digests."""


def _bounded(text: str, maximum: int) -> str:
    if "\0" in text or len(text.encode("utf-8")) > maximum:
        raise PrativedanDraftRefusedError("Draft byte bound exceeded")
    return text


def _json(text: str, maximum: int) -> Any:
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise PrativedanDraftRefusedError("Duplicate JSON member")
            result[key] = value
        return result

    def invalid_constant(_: str) -> None:
        raise PrativedanDraftRefusedError("Non-finite JSON constant")

    return json.loads(
        _bounded(text, maximum), object_pairs_hook=unique, parse_constant=invalid_constant
    )


def _project(source: TrustedBoardSource, request: PrativedanDraftInvokeRequest) -> PrativedanInput:
    if (
        source.title != source.title.strip()
        or source.library_version != source.library_version.strip()
    ):
        raise PrativedanDraftRefusedError("Source text binding refused")
    _bounded(source.title, 300)
    _bounded(source.library_version, 100)
    raw = _json(source.source_text, MAX_SOURCE_BYTES)
    if not isinstance(raw, dict) or type(raw.get("schema_version")) is not int:
        raise PrativedanDraftRefusedError("Invalid source version")
    frozen = FrozenBoardSource.model_validate(raw)
    if (
        sha256_hex(source.source_text) != source.source_sha256
        or source.source_id != frozen.request_id
        or source.controls_sha256 != frozen.controls_sha256
        or source.result_sha256 != frozen.result_sha256
        or source.receipts != frozen.receipts
        or any(
            getattr(source, key) != getattr(frozen, key)
            for key in ("tenant_id", "engagement_id", "assessment_run_id", "library_version")
        )
        or any(
            getattr(source, key) != getattr(request, key)
            for key in ("tenant_id", "engagement_id", "assessment_run_id", "source_id")
        )
        or sha256_hex(_bounded(frozen.controls_text, MAX_PACKET_BYTES)) != frozen.controls_sha256
        or sha256_hex(_bounded(frozen.result_text, MAX_PACKET_BYTES)) != frozen.result_sha256
    ):
        raise PrativedanDraftRefusedError("Frozen source binding refused")
    completed, finalized = [
        datetime.fromisoformat(value) for value in (frozen.completed_at, frozen.finalized_at)
    ]
    if completed.tzinfo is None or finalized.tzinfo is None or completed > finalized:
        raise PrativedanDraftRefusedError("Source completion ordering refused")
    if (
        not (
            int(frozen.receipts.started.id)
            < int(frozen.receipts.completed.id)
            < int(frozen.receipts.finalized.id)
        )
        or not 1 <= len(frozen.limitations) <= 20
    ):
        raise PrativedanDraftRefusedError("Source receipt ordering refused")
    for limitation in frozen.limitations:
        _bounded(limitation, 2000)
    controls = _json(frozen.controls_text, MAX_PACKET_BYTES)
    result = _json(frozen.result_text, MAX_PACKET_BYTES)
    if (
        not isinstance(controls, list)
        or not 1 <= len(controls) <= 500
        or not isinstance(result, dict)
    ):
        raise PrativedanDraftRefusedError("Invalid frozen packet")
    if set(result) != {
        "library_version",
        "posture_score",
        "estimated_exposure_inr",
        "findings",
        "questionnaire_provenance",
    }:
        raise PrativedanDraftRefusedError("Unsupported assessment packet")
    provenance_raw = result["questionnaire_provenance"]
    if (
        not isinstance(provenance_raw, dict)
        or type(provenance_raw.get("version")) is not int
        or provenance_raw.get("review_required") is not True
    ):
        raise PrativedanDraftRefusedError("Missing current questionnaire provenance")
    _bounded(canonical_json(provenance_raw), 262_144)
    provenance = QuestionnaireProvenance.model_validate(provenance_raw)
    if (
        result["library_version"] != frozen.library_version
        or provenance.source_library_version != frozen.library_version
        or provenance.source_library_digest != frozen.controls_sha256
    ):
        raise PrativedanDraftRefusedError("Questionnaire library binding refused")
    declarations = provenance.applicability.model_dump()
    for declaration in declarations.values():
        if declaration["provenance"] != (
            "unknown" if declaration["value"] is None else "caller_declared_unverified"
        ):
            raise PrativedanDraftRefusedError("Applicability declaration refused")
    declared = {entry.control_id: entry for entry in provenance.controls}
    control_ids = [control["id"] for control in controls]
    findings = result["findings"]
    if not isinstance(findings, list) or not 1 <= len(findings) <= 500:
        raise PrativedanDraftRefusedError("Invalid findings")
    found = {finding["control_id"]: finding for finding in findings}
    if (
        len(set(control_ids)) != len(controls)
        or len(declared) != len(provenance.controls)
        or len(found) != len(findings)
        or set(control_ids) != set(declared)
        or set(control_ids) != set(found)
    ):
        raise PrativedanDraftRefusedError("Incomplete control coverage")
    projected: dict[str, dict[str, Any]] = {}
    for control in controls:
        identifier = control["id"]
        if control["library_version"] != frozen.library_version or any(
            type(control.get(flag)) is not bool for flag in ("sdf_only", "children_only")
        ):
            raise PrativedanDraftRefusedError("Pinned control refused")
        entry = declared[identifier]
        questions = [
            question["id"]
            for question in control["assessment_questions"]
            if question["type"] == "boolean"
        ]
        actual_questions = [question.question_id for question in entry.questions]
        yes = sum(question.declaration == "caller_affirmed" for question in entry.questions)
        no = sum(question.declaration == "caller_denied" for question in entry.questions)
        unknown = len(questions) - yes - no
        state = (
            "not_boolean_assessable"
            if not questions
            else "unknown"
            if unknown == len(questions)
            else "partially_answered"
            if unknown
            else "caller_declared_unverified"
        )
        required = [
            declarations[flag]["value"]
            for enabled, flag in (
                (control["sdf_only"], "sdf_self_attested"),
                (control["children_only"], "processes_children"),
            )
            if enabled
        ]
        applicable = (
            "unconditional"
            if not required
            else "caller_declared_not_applicable_unverified"
            if False in required
            else "unknown"
            if None in required
            else "caller_declared_applicable_unverified"
        )
        if (
            len(set(questions)) != len(questions)
            or set(actual_questions) != set(questions)
            or len(set(actual_questions)) != len(actual_questions)
            or entry.known_boolean_question_count != len(questions)
            or entry.caller_affirmed_count != yes
            or entry.caller_denied_count != no
            or entry.unknown_count != unknown
            or entry.answer_state != state
            or entry.applicability_state != applicable
        ):
            raise PrativedanDraftRefusedError("Questionnaire declaration binding refused")
        finding = found[identifier]
        if (
            not {"control_id", "score", "rationale"}
            <= set(finding)
            <= {"control_id", "score", "risk_points", "rationale"}
            or type(finding["score"]) not in (int, float)
            or not 0 <= finding["score"] <= 100
            or not isinstance(finding["rationale"], str)
            or not 1 <= len(finding["rationale"]) <= 4000
        ):
            raise PrativedanDraftRefusedError("Finding source refused")
        if "risk_points" in finding and (
            type(finding["risk_points"]) not in (int, float)
            or not math.isfinite(finding["risk_points"])
            or not 0 <= finding["risk_points"] <= 99999.99
        ):
            raise PrativedanDraftRefusedError("Source risk value refused")
        if (
            not isinstance(identifier, str)
            or not 1 <= len(identifier) <= 100
            or identifier != identifier.strip()
            or not isinstance(control["title"], str)
            or not 1 <= len(control["title"]) <= 300
            or control["severity"] not in ("low", "medium", "high", "critical", "info")
        ):
            raise PrativedanDraftRefusedError("Control metadata refused")
        _bounded(identifier, 100)
        _bounded(control["title"], 1000)
        projected[identifier] = {
            "control_id": identifier,
            "title": control["title"],
            "severity": control["severity"],
            "score": finding["score"],
            "rationale": finding["rationale"]
            + renderer_config()["source_rationale_suffix"].format(
                answer_state=state, applicability_state=applicable
            ),
        }
    return PrativedanInput.model_validate(
        {
            "tenant_id": request.tenant_id,
            "engagement_id": request.engagement_id,
            "kind": "board",
            "title": source.title,
            "findings": [projected[finding["control_id"]] for finding in findings],
            "posture_score": result["posture_score"],
            "estimated_exposure_inr": result["estimated_exposure_inr"],
            "library_version": frozen.library_version,
            "library_control_ids": control_ids,
            "reviewer_id": None,
        }
    )


async def _invoke_prativedan_draft(
    store: PrativedanDraftStore,
    request: PrativedanDraftInvokeRequest,
    agent: PrativedanAgent,
    *,
    now_ms: int,
) -> PrativedanDraftEnvelope:
    """Invoke once after exclusive claim; prove actual audit receipts before return."""
    if (
        type(agent) is not PrativedanAgent
        or type(agent.ledger) is not AppendOnlyLedgerClient
        or agent.ledger._read_client is not None
        or type(now_ms) is not int
        or now_ms <= 0
    ):
        raise PrativedanDraftRefusedError("Invalid trusted renderer")
    config_version, config_text, config_hash = renderer_commitment()
    if (
        agent.renderer_configuration() != (config_version, config_text, config_hash)
        or agent.version != renderer_config()["agent_version"]
    ):
        raise PrativedanDraftRefusedError("Renderer implementation binding refused")
    identifiers = request.model_dump()
    recorded = RecordedPrativedanDispatch.model_validate(
        await store.load_prativedan_dispatch(**identifiers)
    )
    if any(getattr(recorded, key) != value for key, value in identifiers.items()):
        raise PrativedanDraftRefusedError("Dispatch binding refused")
    if (recorded.renderer_config_version, recorded.renderer_config_sha256) != (
        config_version,
        config_hash,
    ):
        raise PrativedanDraftRefusedError("Recorded renderer configuration refused")
    source = TrustedBoardSource.model_validate(await store.read_prativedan_source(**identifiers))
    human = _json(recorded.request_text, MAX_REQUEST_BYTES)
    if (
        human
        != {
            "operationKey": request.operation_key,
            "engagementId": request.engagement_id,
            "assessmentRunId": request.assessment_run_id,
            "expectedSourceSha256": source.source_sha256,
            "sourceReviewed": True,
        }
        or not isinstance(human, dict)
        or human.get("sourceReviewed") is not True
        or sha256_hex(recorded.request_text) != recorded.request_sha256
        or recorded.source_sha256 != source.source_sha256
    ):
        raise PrativedanDraftRefusedError("Human request binding refused")
    normalized = _project(source, request)
    if int(recorded.requested_receipt.id) <= int(source.receipts.finalized.id):
        raise PrativedanDraftRefusedError("Dispatch receipt predates its source")
    input_text = _bounded(canonical_json(normalized.model_dump(mode="json")), MAX_INPUT_BYTES)
    input_hash = sha256_hex(input_text)
    binding = {
        **identifiers,
        "request_sha256": recorded.request_sha256,
        "source_sha256": source.source_sha256,
        "runtime_normalized_input_sha256": input_hash,
        "renderer_config_version": config_version,
        "renderer_config_sha256": config_hash,
    }
    # From this point even transport loss is uncertain; never retry a claim/invoke.
    try:
        claim = PrativedanDispatchClaim.model_validate(
            await store.claim_prativedan_dispatch(**binding)
        )
        if (
            any(getattr(claim, key) != value for key, value in binding.items())
            or not claim.claimed
            or not now_ms < claim.expires_at_ms <= now_ms + 300_000
        ):
            raise PrativedanDraftUncertainError("Claim refused or uncertain")
        result = await agent.invoke(
            normalized,
            correlation_id=request.operation_key,
            dispatch_context=RendererDispatchContext(
                run_id=UUID(request.run_id),
                request_hash=recorded.request_sha256,
                renderer_config_version=config_version,
                renderer_config_sha256=config_hash,
            ),
        )
        if (
            result.agent != AgentName.PRATIVEDAN
            or result.status != "succeeded"
            or result.correlation_id != request.operation_key
            or result.output is None
            or len(result.ledger_entry_ids) != 2
        ):
            raise PrativedanDraftUncertainError("Runtime completion uncertain")
        if (
            set(result.output) != set(PrativedanOutput.model_fields)
            or result.output.get("review_required") is not True
            or result.output.get("citation_verification") != "unverified_references"
            or result.output.get("generated_by_agent") != "prativedan"
            or result.output.get("title") != normalized.title
            or result.output.get("kind") != "board"
            or result.output.get("cited_evidence_ids") != []
        ):
            raise PrativedanDraftUncertainError("Runtime draft contract refused")
        output = PrativedanOutput.model_validate(result.output)
        output_text = _bounded(canonical_json(output.model_dump(mode="json")), MAX_OUTPUT_BYTES)
        output_hash = sha256_hex(output_text)
        receipts = RuntimeReceipts.model_validate(
            await store.read_prativedan_runtime_receipts(
                **binding,
                started_receipt_id=result.ledger_entry_ids[0],
                completed_receipt_id=result.ledger_entry_ids[1],
            )
        )
        started, completed = receipts.started, receipts.completed
        for receipt in (started, completed):
            if (
                receipt.tenant_id != request.tenant_id
                or receipt.correlation_id != request.operation_key
                or receipt.agent_version != agent.version
                or receipt.target_ref != request.engagement_id
                or receipt.input_hash != input_hash
            ):
                raise PrativedanDraftUncertainError("Actual runtime receipt binding refused")
        context = {
            "run_id": request.run_id,
            "request_hash": recorded.request_sha256,
            "renderer_config_version": config_version,
            "renderer_config_sha256": config_hash,
        }
        if (
            started.id != result.ledger_entry_ids[0]
            or completed.id != result.ledger_entry_ids[1]
            or not int(recorded.requested_receipt.id) < int(started.id) < int(completed.id)
            or started.result != "pending"
            or started.output_hash is not None
            or started.detail != {"phase": "started", **context}
            or completed.result != "success"
            or completed.output_hash != output_hash
            or completed.detail != {"phase": "completed", "started_entry": started.id, **context}
        ):
            raise PrativedanDraftUncertainError("Actual runtime completion proof refused")
        return PrativedanDraftEnvelope(
            **binding,
            renderer_config_text=config_text,
            agent_version=agent.version,
            correlation_id=request.operation_key,
            target_ref=request.engagement_id,
            normalized_input_text=input_text,
            runtime_output_text=output_text,
            runtime_output_sha256=output_hash,
            output=output.model_dump(mode="json"),
            requested_receipt=recorded.requested_receipt,
            started_receipt=ReceiptReference(id=started.id, entry_hash=started.entry_hash),
            completed_receipt=ReceiptReference(id=completed.id, entry_hash=completed.entry_hash),
        )
    except Exception:
        raise PrativedanDraftUncertainError(
            "Claimed draft outcome requires controller reconciliation"
        ) from None


async def invoke_prativedan_draft(
    store: PrativedanDraftStore,
    request: PrativedanDraftInvokeRequest,
    agent: PrativedanAgent,
    *,
    now_ms: int,
) -> PrativedanDraftEnvelope:
    """Sanitize source failures without returning raw trusted material to callers."""
    try:
        validated = PrativedanDraftInvokeRequest.model_validate(request.model_dump())
        return await _invoke_prativedan_draft(store, validated, agent, now_ms=now_ms)
    except PrativedanDraftUncertainError:
        raise
    except Exception:
        raise PrativedanDraftRefusedError("Trusted draft source or dispatch was refused") from None
