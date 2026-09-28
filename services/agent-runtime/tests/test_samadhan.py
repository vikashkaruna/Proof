"""Tests for Samadhan (समाधान · Maker-Checker & Reconciler Agent).

Validates:
- Clean reconciliation
- Parameter drift detection
- Swept / unexecuted actions handling
- Refusal of out-of-scope execution
- HMAC statement signing with approval_signing_key
- Input/output schemas and non-mutating guarantee (can_mutate == False)
- Ledger attribution to actor 'samadhan'
"""

from __future__ import annotations

import hashlib
import hmac
from typing import Any
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from axiom.agents.base import AgentName, AutonomyLevel
from axiom.agents.samadhan import (
    ActionOutcomeItem,
    SamadhanAgent,
    SamadhanInput,
    SamadhanOutput,
    normalize_action_outcomes,
)
from axiom.config import Settings
from axiom.executor import ActionOutcome, ExecutorDb, ExecutorRefused
from axiom.verification import reconcile_batch


class FakeDb:
    def __init__(self) -> None:
        self.rpc_calls: list[tuple[str, dict[str, Any]]] = []
        self.rpc_script: dict[str, Any] = {}

    def script(self, fn: str, response: dict[str, Any]) -> None:
        self.rpc_script[fn] = response

    def rpc(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        self.rpc_calls.append((name, args))
        if name in self.rpc_script:
            return self.rpc_script[name]
        if name == "record_plan_reconciliation":
            return {"reconciliation": {"unexecuted": 0, "content_digest_drift": False}}
        return {"ok": True}


class FakeLedger:
    def __init__(self) -> None:
        self.appended: list[Any] = []

    async def append(self, entry: Any) -> Any:
        self.appended.append(entry)
        mock_res = AsyncMock()
        mock_res.id = f"entry-{len(self.appended)}"
        return mock_res


@pytest.fixture
def test_settings() -> Settings:
    return Settings(
        environment="test",
        approval_signing_key="fixture-approval-secret-key",
        supabase_url="http://127.0.0.1:55321",
        supabase_service_key="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIn0.fake",
    )


@pytest.fixture
def samadhan_agent(test_settings: Settings) -> SamadhanAgent:
    return SamadhanAgent(settings=test_settings)


# ─── 1. Non-Mutating Guarantee & Agent Contracts ──────────────────────


def test_samadhan_agent_contract_and_non_mutating_guarantee(samadhan_agent: SamadhanAgent) -> None:
    """Samadhan holds NO write credentials on client estate (can_mutate == False)."""
    assert SamadhanAgent.name == AgentName.SAMADHAN
    assert SamadhanAgent.autonomy == AutonomyLevel.L1
    assert SamadhanAgent.can_mutate is False
    assert SamadhanAgent.mutates_client_estate is False
    assert SamadhanAgent.writes_axiom_state is True
    assert SamadhanAgent.version == "0.1.0"
    assert SamadhanAgent.tool_scopes == (
        "plan.read",
        "batch.read",
        "reconciliation.write",
        "ledger.append",
    )
    assert "connector.write" not in SamadhanAgent.tool_scopes
    assert "plan.propose" not in SamadhanAgent.tool_scopes
    assert SamadhanAgent.one_liner == "I prove that execution matched your plan and your approval."
    assert "Maker-Checker & Reconciler" in SamadhanAgent.description


def test_samadhan_input_output_schemas() -> None:
    """Validates SamadhanInput and SamadhanOutput validation."""
    valid_input = SamadhanInput(
        tenant_id="00000000-0000-0000-0000-000000000001",
        plan_id="11111111-1111-1111-1111-111111111111",
        batch_id="22222222-2222-2222-2222-222222222222",
        request_key="req-xyz",
        action_ids=["act-1", "act-2"],
        outcomes=[
            {"action_id": "act-1", "outcome": "succeeded"},
            ActionOutcome(action_id="act-2", outcome="succeeded"),
        ],
        batch_status="completed",
    )
    assert len(valid_input.action_ids) == 2
    assert len(valid_input.outcomes) == 2

    valid_output = SamadhanOutput(
        batch_id="22222222-2222-2222-2222-222222222222",
        verdict="clean",
        unexecuted_count=0,
        content_digest_drift=False,
        statement="Batch completed.",
        statement_signature="a" * 64,
    )
    assert valid_output.verdict == "clean"
    dumped = valid_output.model_dump(mode="json")
    assert dumped["reconciled_by"] == "samadhan"
    assert dumped["verdict"] == "clean"

    # Invalid verdict
    with pytest.raises(ValidationError):
        SamadhanOutput(
            batch_id="22222222-2222-2222-2222-222222222222",
            verdict="invalid_verdict",  # type: ignore[arg-type]
            statement="test",
            statement_signature="a" * 64,
        )


def test_normalize_action_outcomes() -> None:
    raw = [
        {"action_id": "a-1", "outcome": "succeeded", "rows_affected": 5},
        ActionOutcome(action_id="a-2", outcome="failed", error_code="err"),
        ActionOutcomeItem(action_id="a-3", outcome="skipped"),
    ]
    normalized = normalize_action_outcomes(raw)
    assert len(normalized) == 3
    assert normalized[0].action_id == "a-1"
    assert normalized[0].outcome == "succeeded"
    assert normalized[0].rows_affected == 5
    assert normalized[1].action_id == "a-2"
    assert normalized[1].error_code == "err"
    assert normalized[2].action_id == "a-3"
    assert normalized[2].outcome == "skipped"


# ─── 2. Clean Reconciliation ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_clean_reconciliation(samadhan_agent: SamadhanAgent) -> None:
    """When reality matches approved plan completely, verdict is clean."""
    inp = SamadhanInput(
        tenant_id="00000000-0000-0000-0000-000000000001",
        plan_id="11111111-1111-1111-1111-111111111111",
        batch_id="batch-clean-01",
        request_key="req-clean",
        action_ids=["act-1", "act-2"],
        outcomes=[
            {"action_id": "act-1", "outcome": "succeeded"},
            {"action_id": "act-2", "outcome": "succeeded"},
        ],
        batch_status="completed",
        approved_content_digest="digest-abc",
        recomputed_content_digest="digest-abc",
        signing_key="key-clean-test",
    )

    output = await samadhan_agent.reconcile(inp)

    assert output.verdict == "clean"
    assert output.unexecuted_count == 0
    assert output.content_digest_drift is False
    assert output.batch_id == "batch-clean-01"
    assert "Batch batch-clean-01 (request req-clean) finished completed." in output.statement
    assert "Approved 2 action(s): succeeded=2" in output.statement
    assert output.reconciled_by == "samadhan"

    # Signature verification
    expected_sig = hmac.new(b"key-clean-test", output.statement.encode("utf-8"), hashlib.sha256).hexdigest()
    assert output.statement_signature == expected_sig
    assert len(output.statement_signature) == 64


# ─── 3. Parameter Drift Detection ─────────────────────────────────────


@pytest.mark.asyncio
async def test_parameter_drift_detection_from_digests(samadhan_agent: SamadhanAgent) -> None:
    """Detects parameter drift when approved and recomputed digests diverge."""
    inp = SamadhanInput(
        plan_id="11111111-1111-1111-1111-111111111111",
        batch_id="batch-drift-01",
        request_key="req-drift",
        action_ids=["act-1"],
        outcomes=[{"action_id": "act-1", "outcome": "succeeded"}],
        batch_status="completed",
        approved_content_digest="digest-original",
        recomputed_content_digest="digest-drifted",
        signing_key="key-drift-test",
    )

    output = await samadhan_agent.reconcile(inp)

    assert output.verdict == "drift_detected"
    assert output.content_digest_drift is True
    assert "Parameter drift detected" in output.statement


@pytest.mark.asyncio
async def test_parameter_drift_detection_flag(samadhan_agent: SamadhanAgent) -> None:
    """Detects parameter drift when explicit flag is provided."""
    inp = SamadhanInput(
        plan_id="11111111-1111-1111-1111-111111111111",
        batch_id="batch-drift-02",
        action_ids=["act-1"],
        outcomes=[{"action_id": "act-1", "outcome": "succeeded"}],
        batch_status="completed",
        content_digest_drift=True,
    )

    output = await samadhan_agent.reconcile(inp)

    assert output.verdict == "drift_detected"
    assert output.content_digest_drift is True


# ─── 4. Swept / Unexecuted Actions Handling ───────────────────────────


@pytest.mark.asyncio
async def test_swept_unexecuted_actions_marked_skipped(samadhan_agent: SamadhanAgent) -> None:
    """Accounts for swept actions returning to approved."""
    inp = SamadhanInput(
        plan_id="11111111-1111-1111-1111-111111111111",
        batch_id="batch-swept-01",
        request_key="req-swept",
        action_ids=["act-1", "act-2"],
        outcomes=[
            {"action_id": "act-1", "outcome": "succeeded"},
            {"action_id": "act-2", "outcome": "skipped"},
        ],
        batch_status="partial_failure",
    )

    output = await samadhan_agent.reconcile(inp)

    assert output.verdict == "partial_execution"
    assert output.unexecuted_count == 1
    assert "1 approved action(s) did not execute and returned to `approved`" in output.statement
    assert "they remain retryable only under a fresh approval." in output.statement


@pytest.mark.asyncio
async def test_approved_actions_missing_from_outcomes(samadhan_agent: SamadhanAgent) -> None:
    """Accounts for approved actions that never reached outcomes."""
    inp = SamadhanInput(
        plan_id="11111111-1111-1111-1111-111111111111",
        batch_id="batch-missing-01",
        action_ids=["act-1", "act-2", "act-3"],
        outcomes=[{"action_id": "act-1", "outcome": "succeeded"}],
        batch_status="completed",
    )

    output = await samadhan_agent.reconcile(inp)

    assert output.verdict == "partial_execution"
    assert output.unexecuted_count == 2


# ─── 5. Refusal of Out-of-Scope Execution ─────────────────────────────


@pytest.mark.asyncio
async def test_refusal_of_out_of_scope_execution_raises_when_requested(
    samadhan_agent: SamadhanAgent,
) -> None:
    """Refuses out-of-scope execution with ExecutorRefused when raise_on_out_of_scope=True."""
    inp = SamadhanInput(
        plan_id="11111111-1111-1111-1111-111111111111",
        batch_id="batch-rogue-01",
        action_ids=["act-approved-1"],
        outcomes=[
            {"action_id": "act-approved-1", "outcome": "succeeded"},
            {"action_id": "act-unapproved-rogue", "outcome": "succeeded"},
        ],
        raise_on_out_of_scope=True,
    )

    with pytest.raises(ExecutorRefused) as exc_info:
        await samadhan_agent.reconcile(inp)

    assert exc_info.value.reason == "out_of_scope_executed"


@pytest.mark.asyncio
async def test_refusal_of_out_of_scope_execution_verdict(
    samadhan_agent: SamadhanAgent,
) -> None:
    """Evaluates and surfaces out-of-scope verdict when raise_on_out_of_scope=False."""
    inp = SamadhanInput(
        plan_id="11111111-1111-1111-1111-111111111111",
        batch_id="batch-rogue-02",
        action_ids=["act-approved-1"],
        outcomes=[
            {"action_id": "act-approved-1", "outcome": "succeeded"},
            {"action_id": "act-rogue-99", "outcome": "succeeded"},
        ],
        raise_on_out_of_scope=False,
    )

    output = await samadhan_agent.reconcile(inp)

    assert output.verdict == "out_of_scope"
    assert "act-rogue-99" in output.out_of_scope_action_ids
    assert "Out of scope execution detected for actions: ['act-rogue-99']" in output.statement


@pytest.mark.asyncio
async def test_db_refusal_surfaces_as_out_of_scope(samadhan_agent: SamadhanAgent) -> None:
    """Database RPC refusal 'out_of_scope_executed' is caught and reported by Samadhan."""
    fake_db = FakeDb()
    fake_db.script("record_plan_reconciliation", {"error": "out_of_scope_executed"})

    inp = SamadhanInput(
        plan_id="11111111-1111-1111-1111-111111111111",
        batch_id="batch-db-refused",
        action_ids=["act-1"],
        outcomes=[{"action_id": "act-1", "outcome": "succeeded"}],
        raise_on_out_of_scope=False,
    )

    output = await samadhan_agent.reconcile(inp, db=fake_db)
    assert output.verdict == "out_of_scope"


# ─── 6. HMAC Statement Signing with approval_signing_key ──────────────


@pytest.mark.asyncio
async def test_hmac_statement_signing_with_settings_key(samadhan_agent: SamadhanAgent) -> None:
    """Signs statement with the configured approval_signing_key."""
    inp = SamadhanInput(
        plan_id="11111111-1111-1111-1111-111111111111",
        batch_id="batch-hmac-01",
        action_ids=["act-1"],
        outcomes=[{"action_id": "act-1", "outcome": "succeeded"}],
    )

    output = await samadhan_agent.reconcile(inp)

    expected = hmac.new(
        b"fixture-approval-secret-key",
        output.statement.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    assert output.statement_signature == expected
    assert len(output.statement_signature) == 64
    assert all(c in "0123456789abcdef" for c in output.statement_signature)

    # Tampering with statement breaks verification
    tampered_statement = output.statement + " extra"
    tampered_sig = hmac.new(
        b"fixture-approval-secret-key",
        tampered_statement.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    assert tampered_sig != output.statement_signature


# ─── 7. Agent Invoke and Ledger Attribution ───────────────────────────


@pytest.mark.asyncio
async def test_samadhan_invoke_ledger_attribution(test_settings: Settings) -> None:
    """Invoking Samadhan records ledger entries with actor 'samadhan' and action 'execution.reconciliation.recorded'."""
    ledger = FakeLedger()
    agent = SamadhanAgent(settings=test_settings, ledger=ledger)  # type: ignore[arg-type]

    raw_input = {
        "tenant_id": "00000000-0000-0000-0000-000000000001",
        "plan_id": "11111111-1111-1111-1111-111111111111",
        "batch_id": "batch-invoke-01",
        "request_key": "req-invoke-1",
        "action_ids": ["act-1"],
        "outcomes": [{"action_id": "act-1", "outcome": "succeeded"}],
        "batch_status": "completed",
    }

    result = await agent.invoke(raw_input, correlation_id="corr-samadhan-01")

    assert result.status == "succeeded"
    assert result.agent == AgentName.SAMADHAN
    assert result.output is not None
    assert result.output["verdict"] == "clean"
    assert result.output["reconciled_by"] == "samadhan"

    # Ledger calls verification
    assert len(ledger.appended) == 2
    started_entry = ledger.appended[0]
    completed_entry = ledger.appended[1]

    assert started_entry.actor_id == "samadhan"
    assert started_entry.actor_type == "agent"
    assert started_entry.action_type == "execution.reconciliation.recorded"
    assert started_entry.result == "pending"

    assert completed_entry.actor_id == "samadhan"
    assert completed_entry.actor_type == "agent"
    assert completed_entry.action_type == "execution.reconciliation.recorded"
    assert completed_entry.result == "success"


# ─── 8. Verification Module Integration ────────────────────────────────


@pytest.mark.asyncio
async def test_reconcile_batch_in_verification_attributes_to_samadhan() -> None:
    """reconcile_batch directly calls record_plan_reconciliation and logs ledger as samadhan."""
    fake_db = FakeDb()
    ledger = FakeLedger()
    payload = SamadhanInput(
        tenant_id="00000000-0000-0000-0000-000000000001",
        plan_id="11111111-1111-1111-1111-111111111111",
        batch_id="b-direct",
        request_key="req-direct",
        action_ids=["a-1"],
        outcomes=[{"action_id": "a-1", "outcome": "succeeded"}],
    )
    outcomes = [ActionOutcome(action_id="a-1", outcome="succeeded")]

    rec = await reconcile_batch(
        db=fake_db,
        payload=payload,
        batch_id="b-direct",
        batch_status="completed",
        outcomes=outcomes,
        signing_key="test-key",
        ledger=ledger,
    )

    assert rec == {"reconciliation": {"unexecuted": 0, "content_digest_drift": False}}
    assert len(fake_db.rpc_calls) == 1
    rpc_name, rpc_args = fake_db.rpc_calls[0]
    assert rpc_name == "record_plan_reconciliation"
    assert rpc_args["p_batch_id"] == "b-direct"
    assert len(rpc_args["p_statement_signature"]) == 64

    # Ledger attribution
    assert len(ledger.appended) == 1
    ledger_entry = ledger.appended[0]
    assert ledger_entry.actor_id == "samadhan"
    assert ledger_entry.action_type == "execution.reconciliation.recorded"
    assert ledger_entry.detail["reconciled_by_agent"] == "samadhan"
