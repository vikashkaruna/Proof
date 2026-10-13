"""Actual append transports never synthesize output for a pending agent start."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from axiom.canonicalise import sha256_hex
from axiom.ledger_client import AppendInput, LedgerClient


def started(**changes):
    return AppendInput(
        tenant_id="t",
        correlation_id="c",
        actor_type="agent",
        actor_id="prativedan",
        action_type="report.generated",
        result="pending",
        detail={"phase": "started"},
        **changes,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("explicit", [None, "a" * 64])
async def test_remote_started_output_null_or_explicit_preserved(explicit):
    client = Mock()
    client.rpc.return_value.execute.return_value = SimpleNamespace(data="9007199254740993")
    await LedgerClient(client).append(started(output_hash=explicit))
    assert client.rpc.call_args.args[1]["p_output_hash"] == explicit


@pytest.mark.asyncio
async def test_memory_null_output_hash_uses_empty_chain_domain():
    ledger = LedgerClient.in_memory()
    await ledger.append(started())
    row = ledger.memory_entries[0]
    assert row["output_hash"] is None
    # Existing memory serialization is a test-only chain (not PG canonical text).
    keys = (
        "sequence_no",
        "correlation_id",
        "actor_type",
        "actor_id",
        "agent_version",
        "model_id",
        "prompt_hash",
        "action_type",
        "target_ref",
        "input_hash",
        "output_hash",
        "approval_token_id",
        "approver_id",
        "pre_state_ref",
        "post_state_ref",
        "result",
        "occurred_at",
        "prev_entry_hash",
        "detail",
    )
    payload = "|".join(str(row[key] or "") for key in keys)
    assert row["entry_hash"] == sha256_hex(payload)
    assert "|None|" not in payload


@pytest.mark.asyncio
async def test_other_pending_events_keep_existing_metadata_hash_fallback():
    ledger = LedgerClient.in_memory()
    await ledger.append(
        AppendInput(
            tenant_id="t",
            correlation_id="c",
            actor_type="agent",
            actor_id="prativedan",
            action_type="report.generated",
            result="pending",
            detail={"phase": "other"},
        )
    )
    assert ledger.memory_entries[0]["output_hash"] is not None
