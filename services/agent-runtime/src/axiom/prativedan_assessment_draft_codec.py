"""Pure, unmounted codecs for the dedicated migration-0123 assessment lifecycle.

Hash validation proves retained bytes, not ledger authority. These helpers never
invoke an agent, claim work, read a database or authorize release. A future store
must independently load genuine receipts and enforce current human authority.
Source-v2 is not a Board request and is never translated to the v1 authority.
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime
from decimal import Decimal, DecimalException
from itertools import pairwise
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .agents.parikshan import QuestionnaireProvenance
from .agents.prativedan import PrativedanInput
from .canonicalise import sha256_hex
from .prativedan_renderer_config import renderer_commitment, renderer_config

MAX_SOURCE_BYTES = 1_048_576
MAX_PACKET_BYTES = 524_288
MAX_OUTPUT_BYTES = 2_097_152
MAX_SAFE_INTEGER = 9_007_199_254_740_991
LIMITATIONS = [
    "Recorded questionnaire computation; no independent evidence verification.",
    "Current remediation state is not included.",
    "Not a compliance certification or legal opinion.",
]
Identifier = Annotated[str, Field(pattern=r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$")]
Digest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]


class AssessmentDraftCodecError(ValueError):
    """The dedicated v2 byte, identity or projection contract was refused."""


class Contract(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", frozen=True)


class AssessmentReceipt(Contract):
    id: str = Field(pattern=r"^[1-9][0-9]{0,18}$")
    entry_hash: Digest


class AssessmentSourceReceipts(Contract):
    started: AssessmentReceipt
    completed: AssessmentReceipt
    finalized: AssessmentReceipt


class AssessmentSourceV2(Contract):
    schema_version: Literal[2]
    serialization: Literal["postgres-jsonb-text-v1"]
    kind: Literal["prativedan_assessment_source"]
    source_id: Identifier
    tenant_id: Identifier
    engagement_id: Identifier
    assessment_run_id: Identifier
    title: str = Field(min_length=1, max_length=300)
    library_version: str = Field(min_length=1, max_length=200)
    controls_text: str
    controls_sha256: Digest
    result_text: str
    result_sha256: Digest
    completed_at: str
    finalized_at: str
    receipts: AssessmentSourceReceipts
    limitations: list[str]


class AssessmentDraftBinding(Contract):
    """Separately trusted dispatch/human-request binding; never inferred from reply."""

    tenant_id: Identifier
    actor_id: Identifier
    operation_key: Identifier
    engagement_id: Identifier
    assessment_run_id: Identifier
    source_id: Identifier
    run_id: Identifier
    request_text: str
    source_sha256: Digest


class HumanRequest(Contract):
    operation_key: Identifier = Field(alias="operationKey")
    engagement_id: Identifier = Field(alias="engagementId")
    assessment_run_id: Identifier = Field(alias="assessmentRunId")
    expected_source_sha256: Digest = Field(alias="expectedSourceSha256")
    source_reviewed: Literal[True] = Field(alias="sourceReviewed")


class AssessmentDraftReview(Contract):
    actor_id: Identifier
    review_key: Identifier
    decision: Literal["accepted", "rejected"]
    reason: str = Field(min_length=20, max_length=2000)
    response_output_sha256: Digest
    receipt: AssessmentReceipt


class AssessmentDraftReadbackV2(AssessmentDraftBinding):
    schema_version: Literal[2]
    kind: Literal["prativedan_unpublished_draft"]
    source_text: str
    request_sha256: Digest
    renderer_config_version: Literal["prativedan-draft-v1"]
    renderer_config_sha256: Digest
    renderer_config_text: str
    requested_receipt: AssessmentReceipt
    state: Literal["requested", "invocation_uncertain", "unpublished"]
    publication_allowed: Literal[False]
    review_required: Literal[True]
    citation_verification: Literal["unverified_references"]
    claimed_receipt: AssessmentReceipt | None = None
    normalized_input_text: str | None = None
    runtime_normalized_input_sha256: Digest | None = None
    claim_expires_at: str | None = None
    draft_id: Identifier | None = None
    runtime_output_text: str | None = None
    runtime_output_sha256: Digest | None = None
    response_output_text: str | None = None
    response_output_sha256: Digest | None = None
    output: dict[str, Any] | None = None
    started_receipt: AssessmentReceipt | None = None
    completed_receipt: AssessmentReceipt | None = None
    settled_receipt: AssessmentReceipt | None = None
    review: AssessmentDraftReview | None = None


class AssessmentDraftClaimV2(Contract):
    claimed: bool
    readback: AssessmentDraftReadbackV2
    expires_at: str | None = None
    invocation_uncertain: Literal[True] | None = None


def _refuse(condition: bool, message: str) -> None:
    if condition:
        raise AssessmentDraftCodecError(message)


def _bytes(text: str, maximum: int) -> str:
    try:
        length = len(text.encode("utf-8"))
    except UnicodeError as exc:
        raise AssessmentDraftCodecError("Invalid UTF-8 text") from exc
    _refuse(not 1 <= length <= maximum or "\0" in text, "Text byte bound refused")
    return text


def _json(text: str, maximum: int) -> Any:
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            _refuse(key in result, "Duplicate JSON member refused")
            result[key] = value
        return result

    def invalid(_: str) -> None:
        raise AssessmentDraftCodecError("Nonfinite JSON refused")

    def exact_integer(token: str) -> int:
        value = int(token)
        _refuse(abs(value) > MAX_SAFE_INTEGER, "Unsafe integer JSON refused")
        return value

    def exact_float(token: str) -> int | float:
        # Parse the untouched decimal lexeme first. JSONB numeric declarations
        # must not acquire a different value through binary64 rounding.
        exact = Decimal(token)
        value = float(token)
        _refuse(
            not math.isfinite(value) or Decimal(str(value)) != exact, "Lossy decimal JSON refused"
        )
        return exact_integer(str(int(exact))) if exact == exact.to_integral_value() else value

    try:
        value = json.loads(
            _bytes(text, maximum),
            object_pairs_hook=unique,
            parse_constant=invalid,
            parse_float=exact_float,
            parse_int=exact_integer,
        )
        pending = [(value, 0)]
        while pending:
            item, depth = pending.pop()
            _refuse(depth > 40, "JSON depth refused")
            if isinstance(item, dict):
                pending.extend((entry, depth + 1) for entry in item.values())
            elif isinstance(item, list):
                pending.extend((entry, depth + 1) for entry in item)
            elif isinstance(item, str):
                _bytes(item, maximum) if item else None
            elif isinstance(item, float):
                _refuse(not math.isfinite(item), "Nonfinite JSON refused")
        return value
    except (ValueError, RecursionError, DecimalException) as exc:
        raise AssessmentDraftCodecError("Invalid bounded JSON") from exc


def _ids(model: Contract) -> None:
    for key, value in model.model_dump().items():
        if (key.endswith("_id") or key in ("operation_key", "review_key")) and isinstance(
            value, str
        ):
            _refuse(str(UUID(value)) != value or UUID(value).int == 0, "Identifier refused")


def _date(text: str) -> datetime:
    try:
        _refuse(
            re.fullmatch(
                r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])",
                text,
            )
            is None,
            "Timestamp offset ISO syntax refused",
        )
        value = datetime.fromisoformat(text)
        _refuse(value.tzinfo is None, "Timestamp requires offset")
        return value
    except ValueError as exc:
        raise AssessmentDraftCodecError("Timestamp refused") from exc


def _receipts(*values: AssessmentReceipt) -> None:
    numbers = [int(value.id) for value in values]
    _refuse(any(n > 9_223_372_036_854_775_807 for n in numbers), "Receipt bigint refused")
    _refuse(any(a >= b for a, b in pairwise(numbers)), "Receipt order refused")


def _same_json(left: object, right: object) -> bool:
    """Business values only; bools never equal numeric declarations in Python."""
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(_same_json(left[k], right[k]) for k in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(
            _same_json(a, b) for a, b in zip(left, right, strict=True)
        )
    if type(left) in (int, float) and type(right) in (int, float):
        return left == right
    return type(left) is type(right) and left == right


def _output_shape(output: Any, projected: dict[str, Any]) -> None:
    """SQL-0123 fidelity floor; exact HTML/executive rendering is still a future gate."""
    _refuse(
        not isinstance(output, dict)
        or set(output)
        != {
            "title",
            "kind",
            "sections",
            "cited_evidence_ids",
            "generated_by_agent",
            "rendered_html",
            "review_required",
            "citation_verification",
        },
        "Output keys refused",
    )
    _refuse(
        output["title"] != projected["title"]
        or output["kind"] != "board"
        or output["cited_evidence_ids"] != []
        or output["generated_by_agent"] != "prativedan"
        or output["review_required"] is not True
        or output["citation_verification"] != "unverified_references"
        or not isinstance(output["rendered_html"], str),
        "Output declarations refused",
    )
    _bytes(output["rendered_html"], MAX_OUTPUT_BYTES)
    sections = output["sections"]
    _refuse(not isinstance(sections, list) or len(sections) != 4, "Output sections refused")
    _refuse(
        not isinstance(sections[0], dict)
        or set(sections[0]) != {"type", "title", "body"}
        or sections[0]["type"] != "executive_summary"
        or sections[0]["title"] != "Executive summary"
        or not isinstance(sections[0]["body"], str),
        "Executive shape refused",
    )
    _bytes(sections[0]["body"], 32000)
    expected_findings = {
        "type": "findings_table",
        "title": "Findings for review (source order)",
        "items": [f | {"risk_points": None} for f in projected["findings"][:10]],
    }
    expected_library = {
        "type": "library",
        "title": "Control library",
        "body": f"Referenced library version: {projected['library_version']}. Draft input declares {len(projected['library_control_ids'])} controls; frozen source verification remains required.",
    }
    expected_attribution = {
        "type": "attribution",
        "title": "Draft attribution and review status",
        "body": "Generated by Prativedan (v0.1.0). Pending recorded human review. Evidence references are unverified.",
    }
    _refuse(
        not _same_json(sections[1:], [expected_findings, expected_library, expected_attribution]),
        "Output source projection refused",
    )


def parse_source_v2(source_text: str, expected_sha256: str) -> AssessmentSourceV2:
    """Retain PostgreSQL bytes; never reconstruct their digest from parsed JSON."""
    try:
        raw = _json(source_text, MAX_SOURCE_BYTES)
        _refuse(
            not isinstance(raw, dict) or type(raw.get("schema_version")) is not int,
            "Source version refused",
        )
        source = AssessmentSourceV2.model_validate(raw)
        _ids(source)
        _refuse(sha256_hex(source_text) != expected_sha256, "Source byte hash refused")
        _refuse(source.source_id != source.assessment_run_id, "Dedicated source identity refused")
        _refuse(source.limitations != LIMITATIONS, "Source limitations refused")
        _bytes(source.title, 1200)
        _bytes(source.library_version, 800)
        _refuse(
            sha256_hex(_bytes(source.controls_text, MAX_PACKET_BYTES)) != source.controls_sha256
            or sha256_hex(_bytes(source.result_text, MAX_PACKET_BYTES)) != source.result_sha256,
            "Packet byte hash refused",
        )
        _json(source.controls_text, MAX_PACKET_BYTES)
        _json(source.result_text, MAX_PACKET_BYTES)
        _refuse(
            _date(source.completed_at) > _date(source.finalized_at), "Source time order refused"
        )
        _receipts(source.receipts.started, source.receipts.completed, source.receipts.finalized)
        return source
    except (ValidationError, TypeError, ValueError) as exc:
        raise AssessmentDraftCodecError("Dedicated assessment source refused") from exc


def project_source_v2(source: AssessmentSourceV2) -> PrativedanInput:
    """Recompute declared questionnaire semantics; no evidence or remediation inference."""
    try:
        _ids(source)
        _refuse(
            source.source_id != source.assessment_run_id, "Dedicated projection identity refused"
        )
        _bytes(source.title, 1200)
        _refuse(
            sha256_hex(_bytes(source.controls_text, MAX_PACKET_BYTES)) != source.controls_sha256
            or sha256_hex(_bytes(source.result_text, MAX_PACKET_BYTES)) != source.result_sha256,
            "Projection packet bytes refused",
        )
        controls = _json(source.controls_text, MAX_PACKET_BYTES)
        result = _json(source.result_text, MAX_PACKET_BYTES)
        _refuse(
            not isinstance(controls, list)
            or not 1 <= len(controls) <= 500
            or not isinstance(result, dict),
            "Assessment packet refused",
        )
        _refuse(
            set(result)
            != {
                "library_version",
                "posture_score",
                "estimated_exposure_inr",
                "findings",
                "questionnaire_provenance",
            },
            "Result keys refused",
        )
        prov = result["questionnaire_provenance"]
        _refuse(
            not isinstance(prov, dict)
            or type(prov.get("version")) is not int
            or prov.get("review_required") is not True,
            "Provenance refused",
        )
        provenance = QuestionnaireProvenance.model_validate(prov, strict=True)
        _refuse(
            result["library_version"] != source.library_version
            or provenance.source_library_version != source.library_version
            or provenance.source_library_digest != source.controls_sha256,
            "Library binding refused",
        )
        score, exposure = result["posture_score"], result["estimated_exposure_inr"]
        _refuse(type(score) not in (int, float) or not 0 <= score <= 100, "Posture refused")
        _refuse(
            type(exposure) is not int or not 0 <= exposure <= 9007199254740991, "Exposure refused"
        )
        declarations = provenance.applicability.model_dump()
        for declaration in declarations.values():
            _refuse(
                declaration["provenance"]
                != ("unknown" if declaration["value"] is None else "caller_declared_unverified"),
                "Applicability refused",
            )
        control_ids = [control["id"] for control in controls]
        findings = result["findings"]
        _refuse(not isinstance(findings, list) or not 1 <= len(findings) <= 500, "Findings refused")
        declared = {entry.control_id: entry for entry in provenance.controls}
        found = {finding["control_id"]: finding for finding in findings}
        _refuse(
            len(set(control_ids)) != len(controls)
            or len(declared) != len(provenance.controls)
            or len(found) != len(findings)
            or set(control_ids) != set(declared)
            or set(control_ids) != set(found),
            "Complete coverage refused",
        )
        projected: dict[str, dict[str, Any]] = {}
        for control in controls:
            identifier = control["id"]
            _refuse(
                not isinstance(identifier, str)
                or not 1 <= len(identifier) <= 100
                or identifier.strip() != identifier
                or control["library_version"] != source.library_version
                or not isinstance(control["title"], str)
                or not 1 <= len(control["title"]) <= 300
                or control["severity"] not in ("info", "low", "medium", "high", "critical")
                or type(control.get("sdf_only")) is not bool
                or type(control.get("children_only")) is not bool,
                "Control metadata refused",
            )
            _bytes(identifier, 400)
            _bytes(control["title"], 1200)
            _refuse(not isinstance(control["assessment_questions"], list), "Questions refused")
            questions = [
                question["id"]
                for question in control["assessment_questions"]
                if question["type"] == "boolean"
            ]
            entry = declared[identifier]
            actual = [question.question_id for question in entry.questions]
            yes = sum(q.declaration == "caller_affirmed" for q in entry.questions)
            no = sum(q.declaration == "caller_denied" for q in entry.questions)
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
            _refuse(
                len(set(questions)) != len(questions)
                or len(set(actual)) != len(actual)
                or set(actual) != set(questions)
                or entry.known_boolean_question_count != len(questions)
                or entry.caller_affirmed_count != yes
                or entry.caller_denied_count != no
                or entry.unknown_count != unknown
                or entry.answer_state != state
                or entry.applicability_state != applicable,
                "Questionnaire semantics refused",
            )
            finding = found[identifier]
            _refuse(
                not {"control_id", "score", "rationale"}
                <= set(finding)
                <= {"control_id", "score", "risk_points", "rationale"}
                or type(finding["score"]) not in (int, float)
                or not 0 <= finding["score"] <= 100
                or not isinstance(finding["rationale"], str)
                or not 1 <= len(finding["rationale"]) <= 4000,
                "Finding refused",
            )
            if "risk_points" in finding:
                risk = finding["risk_points"]
                _refuse(
                    type(risk) not in (int, float) or not 0 <= risk <= 99999.99,
                    "Source risk refused",
                )
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
                "tenant_id": source.tenant_id,
                "engagement_id": source.engagement_id,
                "kind": "board",
                "title": source.title,
                "findings": [projected[f["control_id"]] for f in findings],
                "posture_score": score,
                "estimated_exposure_inr": exposure,
                "library_version": source.library_version,
                "library_control_ids": control_ids,
                "reviewer_id": None,
            }
        )
    except (ValueError, TypeError, KeyError, OverflowError) as exc:
        raise AssessmentDraftCodecError("Dedicated assessment projection refused") from exc


CLAIM_FIELDS = {
    "claimed_receipt",
    "normalized_input_text",
    "runtime_normalized_input_sha256",
    "claim_expires_at",
}
OUTPUT_FIELDS = {
    "draft_id",
    "runtime_output_text",
    "runtime_output_sha256",
    "response_output_text",
    "response_output_sha256",
    "output",
    "started_receipt",
    "completed_receipt",
    "settled_receipt",
}


def parse_readback_v2(
    payload: object, expected: AssessmentDraftBinding
) -> AssessmentDraftReadbackV2:
    """Validate exact retained domains against a separately trusted expected binding."""
    try:
        _refuse(
            not isinstance(payload, dict)
            or type(payload.get("schema_version")) is not int
            or payload.get("publication_allowed") is not False
            or payload.get("review_required") is not True,
            "Readback version/flags refused",
        )
        readback = AssessmentDraftReadbackV2.model_validate(payload)
        _ids(readback)
        _ids(expected)
        _refuse(
            any(getattr(readback, key) != value for key, value in expected.model_dump().items()),
            "Trusted request binding refused",
        )
        _refuse(readback.run_id == readback.assessment_run_id, "Distinct runtime identity required")
        source = parse_source_v2(readback.source_text, readback.source_sha256)
        projected = project_source_v2(source).model_dump(mode="json")
        _refuse(
            any(
                getattr(source, key) != getattr(readback, key)
                for key in ("tenant_id", "source_id", "engagement_id", "assessment_run_id")
            ),
            "Source scope refused",
        )
        request_raw = _json(readback.request_text, 4096)
        _refuse(
            not isinstance(request_raw, dict) or request_raw.get("sourceReviewed") is not True,
            "Review declaration refused",
        )
        request = HumanRequest.model_validate(request_raw)
        _refuse(
            request.operation_key != readback.operation_key
            or request.engagement_id != readback.engagement_id
            or request.assessment_run_id != readback.assessment_run_id
            or request.expected_source_sha256 != readback.source_sha256
            or sha256_hex(readback.request_text) != readback.request_sha256,
            "Human request bytes refused",
        )
        version, text, digest = renderer_commitment()
        _refuse(
            (
                readback.renderer_config_text,
                readback.renderer_config_sha256,
                readback.renderer_config_version,
            )
            != (text, digest, version),
            "Actual renderer commitment refused",
        )
        _receipts(source.receipts.finalized, readback.requested_receipt)
        fields = readback.model_fields_set
        _refuse(
            readback.state == "requested"
            and bool(fields & (CLAIM_FIELDS | OUTPUT_FIELDS | {"review"})),
            "Requested state payload refused",
        )
        if readback.state != "requested":
            _refuse(
                not fields >= CLAIM_FIELDS
                or any(getattr(readback, key) is None for key in CLAIM_FIELDS),
                "Claim proof absent",
            )
            _refuse(
                readback.state == "invocation_uncertain"
                and bool(fields & (OUTPUT_FIELDS | {"review"})),
                "Uncertain state output refused",
            )
            _receipts(
                readback.requested_receipt,
                AssessmentReceipt.model_validate(readback.claimed_receipt),
            )
            _date(str(readback.claim_expires_at))
            input_text = str(readback.normalized_input_text)
            _refuse(
                sha256_hex(_bytes(input_text, MAX_SOURCE_BYTES))
                != readback.runtime_normalized_input_sha256
                or not _same_json(_json(input_text, MAX_SOURCE_BYTES), projected),
                "Normalized input bytes/semantics refused",
            )
        if readback.state == "unpublished":
            _refuse(
                not fields >= OUTPUT_FIELDS
                or any(getattr(readback, key) is None for key in OUTPUT_FIELDS),
                "Output proof absent",
            )
            runtime = _json(str(readback.runtime_output_text), MAX_OUTPUT_BYTES)
            response = _json(str(readback.response_output_text), MAX_OUTPUT_BYTES)
            _refuse(
                sha256_hex(str(readback.runtime_output_text)) != readback.runtime_output_sha256
                or sha256_hex(str(readback.response_output_text)) != readback.response_output_sha256
                or not _same_json(runtime, response)
                or not _same_json(response, readback.output),
                "Output domain proof refused",
            )
            _output_shape(response, projected)
            _receipts(
                AssessmentReceipt.model_validate(readback.claimed_receipt),
                AssessmentReceipt.model_validate(readback.started_receipt),
                AssessmentReceipt.model_validate(readback.completed_receipt),
                AssessmentReceipt.model_validate(readback.settled_receipt),
            )
            if "review" in fields:
                review = AssessmentDraftReview.model_validate(readback.review)
                _ids(review)
                _bytes(review.reason, 8000)
                _refuse(
                    review.response_output_sha256 != readback.response_output_sha256
                    or review.reason != review.reason.strip(" "),
                    "Review output binding refused",
                )
                _receipts(
                    AssessmentReceipt.model_validate(readback.settled_receipt), review.receipt
                )
        return readback
    except (ValueError, TypeError, KeyError) as exc:
        raise AssessmentDraftCodecError("Dedicated retained readback refused") from exc


def parse_claim_v2(payload: object, expected: AssessmentDraftBinding) -> AssessmentDraftClaimV2:
    """First/replay shape only: pure codec success never permits agent invocation."""
    try:
        if not isinstance(payload, dict) or type(payload.get("claimed")) is not bool:
            raise AssessmentDraftCodecError("Claim response refused")
        claim = AssessmentDraftClaimV2.model_validate(payload)
        readback = parse_readback_v2(payload["readback"], expected)
        if claim.claimed:
            _refuse(
                set(payload) != {"claimed", "expires_at", "readback"}
                or readback.state != "invocation_uncertain"
                or claim.expires_at is None
                or claim.expires_at != readback.claim_expires_at,
                "First claim proof refused",
            )
        else:
            _refuse(
                set(payload) != {"claimed", "invocation_uncertain", "readback"}
                or payload["invocation_uncertain"] is not True
                or readback.state == "requested",
                "Replay uncertainty refused",
            )
        return claim
    except (ValueError, TypeError, KeyError) as exc:
        raise AssessmentDraftCodecError("Dedicated claim refused") from exc
