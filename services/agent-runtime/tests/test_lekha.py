"""Lekha must preserve invocation context without narrowing tenant-wide verification."""

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from axiom.agents.base import DispatchContext
from axiom.agents.lekha import LekhaAgent, LekhaInput
from axiom.canonicalise import canonical_json, sha256_hex
from axiom.config import Settings
from axiom.ledger_client import AppendResult

TENANT = "47470000-0000-4000-8000-000000000001"
ENGAGEMENT = "47470000-0000-4000-8000-000000000002"
CORRELATION = "47470000-0000-4000-8000-000000000003"
RUN = "47470000-0000-4000-8000-000000000004"


@pytest.fixture
def agent():
    ledger = SimpleNamespace(
        append=AsyncMock(
            side_effect=[
                AppendResult(id="41", occurred_at=datetime.now(UTC)),
                AppendResult(id="42", occurred_at=datetime.now(UTC)),
            ]
        ),
        verify=AsyncMock(return_value={"intact": True, "firstBreak": None}),
        query=AsyncMock(return_value=[]),
    )
    return LekhaAgent(
        settings=Settings(_env_file=None),
        ledger=ledger,
        evidence=Mock(),
        model_gateway=Mock(),
    )


@pytest.mark.parametrize("model_input", [False, True])
@pytest.mark.asyncio
async def test_invoke_binds_both_receipts_to_engagement_without_scoping_verification(
    agent, model_input
):
    payload = {
        "tenant_id": TENANT,
        "engagement_id": ENGAGEMENT,
        "operation": "verify",
        "from_sequence": 7,
    }
    context = DispatchContext(run_id=RUN, request_hash="a" * 64)
    result = await agent.invoke(
        LekhaInput(**payload) if model_input else payload,
        correlation_id=CORRELATION,
        dispatch_context=context,
    )

    assert result.status == "succeeded"
    assert result.output["intact"] is True
    assert result.output["first_break"] is None
    assert result.ledger_entry_ids == ["41", "42"]
    agent.ledger.verify.assert_awaited_once_with(TENANT, 7)
    agent.ledger.query.assert_not_called()
    started, completed = [call.args[0] for call in agent.ledger.append.await_args_list]
    expected_input_hash = sha256_hex(canonical_json(LekhaInput(**payload).model_dump(mode="json")))
    for receipt in (started, completed):
        assert receipt.target_ref == ENGAGEMENT
        assert receipt.tenant_id == TENANT
        assert receipt.correlation_id == CORRELATION
        assert receipt.actor_id == "lekha"
        assert receipt.input_hash == expected_input_hash
        assert receipt.detail["run_id"] == RUN
        assert receipt.detail["request_hash"] == context.request_hash
    assert started.result == "pending"
    assert started.detail["phase"] == "started"
    assert completed.result == "success"
    assert completed.detail["phase"] == "completed"
    assert completed.detail["started_entry"] == "41"
    assert completed.output_hash == sha256_hex(canonical_json(result.output))


@pytest.mark.parametrize("context", [{}, {"engagement_id": None}])
@pytest.mark.asyncio
async def test_tenant_only_invocation_retains_null_receipt_target_and_actual_chain_result(
    agent, context
):
    first_break = {"sequence": 9, "reason": "hash_mismatch"}
    agent.ledger.verify.return_value = {"intact": False, "firstBreak": first_break}
    result = await agent.invoke({"tenant_id": TENANT, "operation": "verify", **context})

    assert result.status == "succeeded"
    assert result.output["intact"] is False
    assert result.output["first_break"] == first_break
    agent.ledger.verify.assert_awaited_once_with(TENANT, 1)
    assert len(agent.ledger.append.await_args_list) == 2
    assert all(call.args[0].target_ref is None for call in agent.ledger.append.await_args_list)


@pytest.mark.parametrize("invalid_context", [False, 3, [], {}])
@pytest.mark.asyncio
async def test_non_string_context_is_refused_before_verification_or_receipt(agent, invalid_context):
    result = await agent.invoke({"tenant_id": TENANT, "engagement_id": invalid_context})

    assert result.status == "failed"
    assert result.error == "validation_failed"
    assert result.output is None
    assert result.ledger_entry_ids == []
    agent.ledger.append.assert_not_called()
    agent.ledger.verify.assert_not_called()


@pytest.mark.parametrize("operation", ["reconstruct", "export"])
@pytest.mark.asyncio
async def test_other_ledger_operations_preserve_context_without_changing_query_scope(
    agent, operation
):
    payload = {
        "tenant_id": TENANT,
        "engagement_id": ENGAGEMENT,
        "operation": operation,
        "correlation_id": CORRELATION,
        "from_sequence": 7,
        "to_sequence": 12,
    }
    result = await agent.invoke(payload)

    assert result.status == "succeeded"
    agent.ledger.verify.assert_not_called()
    if operation == "reconstruct":
        agent.ledger.query.assert_awaited_once_with(
            tenant_id=TENANT, correlation_id=CORRELATION, limit=1000
        )
    else:
        agent.ledger.query.assert_awaited_once_with(
            tenant_id=TENANT, from_sequence=7, to_sequence=12, limit=10_000
        )
    assert len(agent.ledger.append.await_args_list) == 2
    assert all(
        call.args[0].target_ref == ENGAGEMENT for call in agent.ledger.append.await_args_list
    )
