"""Sudhaar plans review work from authenticated source facts, never executions."""

from copy import deepcopy

import pytest

from axiom.agents.sudhaar import ActionType, SudhaarAgent, inverse_action
from axiom.ledger_client import LedgerClient


def source_input():
    return {
        "tenant_id": "11111111-1111-4111-8111-111111111111",
        "engagement_id": "22222222-2222-4222-8222-222222222222",
        "title": "Review",
        "source": {
            "assessmentRunId": "33333333-3333-4333-8333-333333333333",
            "libraryVersion": "v1",
            "libraryDigest": "a" * 64,
            "resultDigest": "b" * 64,
            "finalizedReceipt": "119",
        },
        "findings": [
            {
                "finding_id": "44444444-4444-4444-8444-444444444444",
                "control_id": "C",
                "title": "Control",
                "severity": "critical",
                "score_decimal": "30",
                "risk_points_decimal": "7.5",
                "answer_state": "unknown",
                "applicability_state": "unconditional",
                "answer_counts": {"known": 2, "affirmed": 0, "denied": 0, "unknown": 2},
            }
        ],
    }


@pytest.mark.asyncio
async def test_readonly_bound_planner_returns_review_without_execution_or_false_closure():
    value = source_input()
    out = await SudhaarAgent().invoke(value)
    assert out.status == "succeeded"
    assert out.output["source"] == value["source"]
    assert out.output["review_required"] is True
    assert out.output["escalate"] is True
    assert out.output["execution_allowed"] is False
    assert out.output["persistence"] == "not_saved"
    assert out.output["provisional_actions"] == []
    assert out.output["aggregate_records_affected"] is None
    assert out.output["review_tasks"][0]["finding_id"] == value["findings"][0]["finding_id"]
    assert "closes_finding_id" not in out.output["review_tasks"][0]
    assert SudhaarAgent.can_mutate is False
    assert SudhaarAgent.writes_axiom_state is False
    assert "plan.write" not in SudhaarAgent.tool_scopes


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "state", ["partial", "complete", "non_boolean", "conditional", "excluded", "unavailable"]
)
async def test_uncertain_and_declared_facts_require_review(state):
    value = source_input()
    f = value["findings"][0]
    if state == "partial":
        f.update(
            answer_state="partially_answered",
            answer_counts={"known": 2, "affirmed": 1, "denied": 0, "unknown": 1},
        )
    if state == "complete":
        f.update(
            answer_state="caller_declared_unverified",
            answer_counts={"known": 2, "affirmed": 2, "denied": 0, "unknown": 0},
        )
    if state == "non_boolean":
        f.update(
            answer_state="not_boolean_assessable",
            answer_counts={"known": 0, "affirmed": 0, "denied": 0, "unknown": 0},
        )
    if state == "conditional":
        f["applicability_state"] = "caller_declared_applicable_unverified"
    if state == "excluded":
        f["applicability_state"] = "caller_declared_not_applicable_unverified"
    if state == "unavailable":
        f.update(answer_state="unavailable", applicability_state="unavailable", answer_counts=None)
    out = await SudhaarAgent().invoke(value)
    assert out.status == "succeeded"
    assert len(out.output["review_tasks"]) == 1
    assert out.output["provisional_actions"] == []
    expected = {
        "partial": "questionnaire_incomplete",
        "complete": "declarations_unverified",
        "non_boolean": "evidence_required",
        "conditional": "applicability_unverified",
        "excluded": "applicability_unverified",
        "unavailable": "provenance_unavailable",
    }
    assert out.output["review_tasks"][0]["reason"] == expected[state]
    assert out.output["escalate"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change",
    [
        "scope",
        "cap",
        "credential",
        "duplicate",
        "state",
        "count",
        "negative",
        "boolean",
        "legacy",
        "empty",
    ],
)
async def test_unbound_or_unsafe_input_refused_before_audit(change):
    value = source_input()
    if change == "scope":
        value["scope_hints"] = {
            value["findings"][0]["finding_id"]: {
                "records_affected": 0,
                "systems_affected": ["site"],
                "environment": "development",
            }
        }
    if change == "cap":
        value["blast_radius_cap_records"] = 10**30
    if change == "credential":
        value["approval_token"] = "not-an-approval"
    if change == "duplicate":
        value["findings"].append(deepcopy(value["findings"][0]))
    if change == "state":
        value["findings"][0]["answer_state"] = "caller_declared_unverified"
    if change == "count":
        value["findings"][0]["answer_counts"]["unknown"] = 1
    if change == "negative":
        value["findings"][0]["score_decimal"] = "-1"
    if change == "boolean":
        value["findings"][0]["answer_counts"]["unknown"] = True
    if change == "legacy":
        del value["source"]
    if change == "empty":
        value["findings"] = []
    result = await SudhaarAgent().invoke(value)
    assert result.status == "failed"
    assert result.error == "validation_failed"
    assert result.ledger_entry_ids == []
    assert result.output is None


def test_irreversible_delete_cannot_claim_a_reversible_policy_publication():
    assert inverse_action(ActionType.DATA_DELETE) is None
    assert inverse_action(ActionType.DATA_MASK) is None
    assert inverse_action(ActionType.DATA_RETENTION_PURGE) is None
    assert inverse_action(ActionType.CONSENT_UPDATE) == ActionType.NOTICE_UPDATE
    assert inverse_action(ActionType.CUSTOM) is None


@pytest.mark.asyncio
async def test_planner_keeps_only_scoped_append_without_shared_credentials():
    class ForbiddenClient:
        def rpc(self, *args, **kwargs):
            raise AssertionError("Privileged client was accessed")

        def table(self, *args, **kwargs):
            raise AssertionError("Privileged client was accessed")

    shared = LedgerClient(read_client=ForbiddenClient(), in_memory=True)
    settings, evidence, gateway = object(), object(), object()
    agent = SudhaarAgent(settings=settings, ledger=shared, evidence=evidence, model_gateway=gateway)
    assert set(vars(agent)) == {"ledger", "log"}
    assert agent.ledger is not shared
    assert agent.ledger._read_client is None
    assert shared._read_client is not None
    assert agent.ledger._client is None
    assert not any(v is settings or v is evidence or v is gateway for v in vars(agent).values())
    for action in (
        agent.ledger.query(tenant_id=source_input()["tenant_id"]),
        agent.ledger.verify(source_input()["tenant_id"]),
        agent.ledger.load_public_source_dispatch(),
        agent.ledger.claim_public_source_dispatch(),
    ):
        with pytest.raises(PermissionError, match="capability is unavailable"):
            await action
    result = await agent.invoke(source_input())
    assert result.status == "succeeded"
    assert len(shared.memory_entries) == 2


def test_production_append_view_retains_writer_only_without_original_reader():
    writer, reader = object(), object()
    original = LedgerClient(writer, read_client=reader)
    view = original.append_only_view()
    assert view._client is writer
    assert view._read_client is None
    assert set(vars(view)) == {"_client", "_read_client", "_in_memory", "_mem", "_mem_chains"}
    assert not any(v is reader or v is original for v in vars(view).values())


@pytest.mark.asyncio
async def test_planning_source_bounds_bigint_receipts_and_actual_utf8_bytes():
    for mode in ("receipt", "utf8"):
        value = source_input()
        if mode == "receipt":
            value["source"]["finalizedReceipt"] = "9223372036854775808"
        else:
            template = value["findings"][0]
            value["findings"] = [
                {
                    **template,
                    "finding_id": f"44444444-4444-4444-8444-{i:012}",
                    "control_id": f"C{i}",
                    "title": "測" * 300,
                }
                for i in range(500)
            ]
        out = await SudhaarAgent().invoke(value)
        assert out.status == "failed"
        assert out.error == "validation_failed"
        assert out.ledger_entry_ids == []
