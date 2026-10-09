"""Named runtime transport proofs; storage metadata fixtures are not provider acceptance."""

from copy import deepcopy
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError
from test_saakshi_staging import OPERATION, TENANT, receipt, source

from axiom.agents.saakshi_stage_agent import SaakshiStageAgent
from axiom.canonicalise import canonical_json, sha256_hex
from axiom.ledger_client import LedgerClient
from axiom.saakshi_dispatch import (
    EvidenceInvokeRequest,
    prepare_evidence_dispatch,
)
from axiom.saakshi_staging import EvidenceStagePort

RUN = "50000000-0000-4000-8000-000000000119"
REQUEST = EvidenceInvokeRequest(tenant_id=TENANT, run_id=RUN, operation_key=OPERATION)


def transport():
    text = canonical_json(source().model_dump(mode="json"))
    return SimpleNamespace(
        load_saakshi_dispatch=AsyncMock(
            return_value={
                **REQUEST.model_dump(),
                "input_text": text,
                "request_hash": sha256_hex(text),
                "requested_receipt": "123",
            }
        ),
        claim_saakshi_dispatch=AsyncMock(
            return_value={"run_id": RUN, "claimed": True, "expires_at_ms": 2000}
        ),
    )


@pytest.mark.asyncio
async def test_exact_retained_metadata_only_source_claim():
    ledger = transport()
    prepared = await prepare_evidence_dispatch(ledger, REQUEST, now_ms=1000)
    assert prepared.source == source()
    assert prepared.run_id == RUN
    assert prepared.requested_receipt == "123"
    ledger.claim_saakshi_dispatch.assert_awaited_once_with(
        **REQUEST.model_dump(),
        request_hash=sha256_hex(canonical_json(source().model_dump(mode="json"))),
    )


@pytest.mark.parametrize(
    "kind", ["tenant", "run", "operation", "hash", "space", "oversize", "unknown"]
)
@pytest.mark.asyncio
async def test_poisoned_record_never_claims(kind):
    ledger = transport()
    row = deepcopy(ledger.load_saakshi_dispatch.return_value)
    if kind in ("tenant", "run", "operation"):
        row[{"tenant": "tenant_id", "run": "run_id", "operation": "operation_key"}[kind]] = (
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        )
    if kind == "hash":
        row["request_hash"] = "0" * 64
    if kind == "space":
        row["input_text"] += " "
    if kind == "oversize":
        row["input_text"] = "x" * 16001
    if kind == "unknown":
        row["bytes"] = "forbidden"
    ledger.load_saakshi_dispatch.return_value = row
    with pytest.raises(ValueError, match=r"Evidence|validation error"):
        await prepare_evidence_dispatch(ledger, REQUEST, now_ms=1000)
    ledger.claim_saakshi_dispatch.assert_not_awaited()


@pytest.mark.parametrize("kind", ["run", "expired", "unknown", "already", "boolean"])
@pytest.mark.asyncio
async def test_claim_drift_or_uncertainty_never_dispatches(kind):
    ledger = transport()
    row = deepcopy(ledger.claim_saakshi_dispatch.return_value)
    if kind == "run":
        row["run_id"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    if kind == "expired":
        row["expires_at_ms"] = 1000
    if kind == "unknown":
        row["grant"] = "write"
    if kind == "already":
        row["claimed"] = False
    if kind == "boolean":
        row["claimed"] = 1
    ledger.claim_saakshi_dispatch.return_value = row
    with pytest.raises(ValueError, match=r"Evidence|validation error"):
        await prepare_evidence_dispatch(ledger, REQUEST, now_ms=1000)


@pytest.mark.asyncio
async def test_no_memory_or_append_only_source_fallback():
    ledger = LedgerClient(in_memory=True)
    for current in [ledger, ledger.append_only_view()]:
        with pytest.raises((RuntimeError, PermissionError)):
            await current.load_saakshi_dispatch(**REQUEST.model_dump())
        with pytest.raises((RuntimeError, PermissionError)):
            await current.claim_saakshi_dispatch(**REQUEST.model_dump(), request_hash="a" * 64)


@pytest.mark.asyncio
async def test_named_stage_agent_records_runtime_receipts_but_no_evidence_registration():
    ledger = LedgerClient(in_memory=True)
    calls = []

    async def stage(s, c):
        calls.append((s, c))
        return receipt(correlation_id=OPERATION, readback_at=datetime.now(UTC).isoformat())

    agent = SaakshiStageAgent(ledger=ledger, port=EvidenceStagePort(source(), OPERATION, stage))
    result = await agent.invoke(
        source(),
        correlation_id=OPERATION,
        dispatch_context={
            "run_id": RUN,
            "request_hash": sha256_hex(canonical_json(source().model_dump(mode="json"))),
        },
    )
    assert result.status == "succeeded"
    assert len(result.ledger_entry_ids) == 2
    assert result.output["accepted"] is False
    assert result.evidence_ids == []
    assert len(calls) == 1
    assert not hasattr(agent, "evidence")
    assert not hasattr(agent, "settings")
    assert [x["detail"]["phase"] for x in ledger.memory_entries] == ["started", "completed"]


@pytest.mark.asyncio
async def test_foreign_source_capability_never_runs_storage():
    ledger = LedgerClient(in_memory=True)
    stage = AsyncMock()
    agent = SaakshiStageAgent(
        ledger=ledger, port=EvidenceStagePort(source(actor_id=TENANT), OPERATION, stage)
    )
    result = await agent.invoke(source(), correlation_id=OPERATION)
    assert result.status == "failed"
    assert result.evidence_ids == []
    stage.assert_not_awaited()

@pytest.mark.parametrize("value", ["0", "01", "-1", "+1", "1.0", " 1", "9223372036854775808", "10000000000000000000"])
@pytest.mark.asyncio
async def test_invalid_retained_receipt_never_claims(value):
    ledger = transport()
    ledger.load_saakshi_dispatch.return_value["requested_receipt"] = value
    with pytest.raises(ValidationError, match="requested_receipt"):
        await prepare_evidence_dispatch(ledger, REQUEST, now_ms=1000)
    ledger.claim_saakshi_dispatch.assert_not_called()


@pytest.mark.asyncio
async def test_retained_receipt_accepts_exact_signed_int64_maximum():
    ledger = transport()
    ledger.load_saakshi_dispatch.return_value["requested_receipt"] = "9223372036854775807"
    prepared = await prepare_evidence_dispatch(ledger, REQUEST, now_ms=1000)
    assert prepared.requested_receipt == "9223372036854775807"
    ledger.claim_saakshi_dispatch.assert_awaited_once()
