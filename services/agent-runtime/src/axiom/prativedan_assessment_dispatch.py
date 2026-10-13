"""Unmounted assessment-v2 one-shot invocation. Never settles or authorizes release."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import UUID

from .agents.base import AgentName, RendererDispatchContext
from .agents.prativedan import PrativedanAgent, PrativedanOutput
from .canonicalise import canonical_json, sha256_hex
from .ledger_client import AppendOnlyLedgerClient
from .prativedan_assessment_draft_codec import (
    AssessmentDraftBinding,
    AssessmentDraftReadbackV2,
    AssessmentReceipt,
    Contract,
    Digest,
    Identifier,
    _date,
    parse_claim_v2,
    parse_readback_v2,
    parse_source_v2,
    project_source_v2,
)
from .prativedan_assessment_store import PrativedanAssessmentStore
from .prativedan_renderer_config import renderer_commitment

RENDER_TIMEOUT_SECONDS = 10


class AssessmentDispatchRefusedError(ValueError):
    """Refused before the one-shot claim boundary."""


class AssessmentInvocationUncertainError(ValueError):
    """Claim or execution may have committed; never redispatch."""


class AssessmentRuntimeWitness(Contract):
    schema_version: Literal[2]
    tenant_id: Identifier
    engagement_id: Identifier
    source_id: Identifier
    assessment_run_id: Identifier
    run_id: Identifier
    operation_key: Identifier
    source_sha256: Digest
    request_sha256: Digest
    runtime_normalized_input_sha256: Digest
    runtime_output_sha256: Digest
    renderer_config_version: Literal["prativedan-draft-v1"]
    renderer_config_sha256: Digest
    agent: Literal["prativedan"]
    agent_version: Literal["0.1.0"]
    correlation_id: Identifier
    target_ref: Identifier
    requested_receipt: AssessmentReceipt
    claimed_receipt: AssessmentReceipt
    started_receipt: AssessmentReceipt
    completed_receipt: AssessmentReceipt
    claim_expires_at: str
    completed_at: str


class AssessmentRuntimeEnvelope(AssessmentRuntimeWitness):
    renderer_config_text: str
    normalized_input_text: str
    runtime_output_text: str
    output: dict[str, object]
    review_required: Literal[True] = True
    citation_verification: Literal["unverified_references"] = "unverified_references"


def _clock() -> datetime:
    return datetime.now(UTC)


def _now(clock: Callable[[], datetime]) -> datetime:
    value = clock()
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Timezone-aware clock required")
    return value.astimezone(UTC)


async def recover_assessment_draft(
    store: PrativedanAssessmentStore, binding: AssessmentDraftBinding
) -> AssessmentDraftReadbackV2:
    """Authoritative read only; requested/uncertain remain uncompleted, never invoke."""
    return parse_readback_v2(await store.load(binding), binding)


async def invoke_assessment_draft(
    store: PrativedanAssessmentStore,
    binding: AssessmentDraftBinding,
    agent: PrativedanAgent,
    *,
    clock: Callable[[], datetime] = _clock,
) -> AssessmentRuntimeEnvelope:
    """Actual BaseAgent invocation plus independently loaded SQL receipt witness."""
    try:
        if (
            type(agent) is not PrativedanAgent
            or type(agent.ledger) is not AppendOnlyLedgerClient
            or agent.ledger._read_client is not None
            or any(
                UUID(getattr(binding, key)).int == 0
                for key in (
                    "tenant_id",
                    "actor_id",
                    "operation_key",
                    "engagement_id",
                    "assessment_run_id",
                    "source_id",
                    "run_id",
                )
            )
        ):
            raise ValueError("Dedicated renderer capability refused")
        version, config_text, config_hash = renderer_commitment()
        if agent.version != "0.1.0" or agent.renderer_configuration() != (
            version,
            config_text,
            config_hash,
        ):
            raise ValueError("Actual renderer configuration refused")
        _now(clock)
        recorded = parse_readback_v2(await store.load(binding), binding)
        if recorded.state != "requested":
            raise ValueError("Previously claimed work cannot be invoked")
        normalized = project_source_v2(
            parse_source_v2(recorded.source_text, recorded.source_sha256)
        )
        input_text = canonical_json(normalized.model_dump(mode="json"))
        if len(input_text.encode("utf-8")) > 1048576:
            raise ValueError("Input byte bound refused")
    except Exception as exc:
        raise AssessmentDispatchRefusedError("Assessment dispatch refused") from exc
    # Even a lost claim reply consumes the dispatch possibility. No retries.
    try:
        _now(clock)
        claim = parse_claim_v2(await store.claim(binding, input_text), binding)
        retained = claim.readback
        if not claim.claimed or retained.normalized_input_text != input_text:
            raise ValueError("Exclusive claim absent")
        expiry = _date(str(retained.claim_expires_at))
        after_claim = _now(clock)
        if not after_claim < expiry <= after_claim + timedelta(minutes=5):
            raise ValueError("Fresh bounded claim absent")
        async with asyncio.timeout(RENDER_TIMEOUT_SECONDS):
            result = await agent.invoke(
                normalized,
                correlation_id=binding.operation_key,
                dispatch_context=RendererDispatchContext(
                    run_id=UUID(binding.run_id),
                    request_hash=recorded.request_sha256,
                    renderer_config_version=version,
                    renderer_config_sha256=config_hash,
                ),
            )
        if (
            _now(clock) >= expiry
            or result.status != "succeeded"
            or result.agent != AgentName.PRATIVEDAN
            or result.correlation_id != binding.operation_key
            or result.output is None
            or len(result.ledger_entry_ids) != 2
        ):
            raise ValueError("Runtime completion unconfirmed")
        output = PrativedanOutput.model_validate(result.output)
        output_text = canonical_json(output.model_dump(mode="json"))
        if len(output_text.encode("utf-8")) > 2097152:
            raise ValueError("Output byte bound refused")
        witness = AssessmentRuntimeWitness.model_validate(
            await store.receipts(binding, *result.ledger_entry_ids)
        )
        expected = {
            key: getattr(binding, key)
            for key in (
                "tenant_id",
                "engagement_id",
                "source_id",
                "assessment_run_id",
                "run_id",
                "operation_key",
                "source_sha256",
            )
        }
        expected.update(
            request_sha256=recorded.request_sha256,
            runtime_normalized_input_sha256=sha256_hex(input_text),
            runtime_output_sha256=sha256_hex(output_text),
            renderer_config_version=version,
            renderer_config_sha256=config_hash,
            correlation_id=binding.operation_key,
            target_ref=binding.engagement_id,
        )
        if (
            any(getattr(witness, key) != value for key, value in expected.items())
            or witness.requested_receipt != recorded.requested_receipt
            or witness.claimed_receipt != retained.claimed_receipt
            or witness.claim_expires_at != retained.claim_expires_at
            or witness.started_receipt.id != result.ledger_entry_ids[0]
            or witness.completed_receipt.id != result.ledger_entry_ids[1]
            or not int(witness.claimed_receipt.id)
            < int(witness.started_receipt.id)
            < int(witness.completed_receipt.id)
            <= 9223372036854775807
            or _date(witness.completed_at) > expiry
        ):
            raise ValueError("Independent actual receipt binding refused")
        return AssessmentRuntimeEnvelope(
            **witness.model_dump(),
            renderer_config_text=config_text,
            normalized_input_text=input_text,
            runtime_output_text=output_text,
            output=output.model_dump(mode="json"),
        )
    except (Exception, asyncio.CancelledError) as exc:
        raise AssessmentInvocationUncertainError(
            "Assessment invocation uncertain; recovery only"
        ) from exc
