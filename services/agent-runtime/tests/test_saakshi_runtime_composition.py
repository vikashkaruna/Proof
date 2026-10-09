"""Actual FastAPI composition: IDs-only dispatch, no generic storage grant."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from axiom.agents.base import AgentName, AgentRunResult
from axiom.app import app
from axiom.saakshi_dispatch import EvidenceAlreadyClaimedError
from axiom.saakshi_stage_transport import InternalEvidenceStageTransport

ROUTE = "/staged-evidence/agents/saakshi/invoke"
REQUEST = {"tenant_id": "10000000-0000-4000-8000-000000000119", "run_id": "20000000-0000-4000-8000-000000000119", "operation_key": "30000000-0000-4000-8000-000000000119"}
TOKEN = "runtime-fixture-token"


def mount(monkeypatch, failure=None):
    invoke = AsyncMock(return_value=AgentRunResult(agent=AgentName.SAAKSHI, correlation_id=REQUEST["operation_key"], status="succeeded", output={"accepted": False}))
    if failure is not None:
        invoke.side_effect = failure
    monkeypatch.setattr("axiom.app.invoke_staged_evidence", invoke)
    monkeypatch.setattr(app.state, "settings", SimpleNamespace(internal_token=TOKEN), raising=False)
    monkeypatch.setattr(app.state, "staged_evidence_transport", object(), raising=False)
    monkeypatch.setattr(app.state, "ledger", object(), raising=False)
    return TestClient(app), invoke


def test_authentication_precedes_staged_source_load(monkeypatch):
    client, invoke = mount(monkeypatch)
    assert client.post(ROUTE, json=REQUEST).status_code == 401
    invoke.assert_not_called()


@pytest.mark.parametrize("extra", [{"input": {}}, {"stage_url": "http://caller.invalid"}, {"contentBase64": "private"}, {"authorization": "caller-proof"}])
def test_named_runtime_transport_refuses_caller_source_or_credentials(monkeypatch, extra):
    client, invoke = mount(monkeypatch)
    assert client.post(ROUTE, json={**REQUEST, **extra}, headers={"X-Internal-Token": TOKEN}).status_code == 422
    invoke.assert_not_called()


def test_missing_optional_transport_does_not_dispatch(monkeypatch):
    client, invoke = mount(monkeypatch)
    monkeypatch.setattr(app.state, "staged_evidence_transport", None)
    assert client.post(ROUTE, json=REQUEST, headers={"X-Internal-Token": TOKEN}).status_code == 503
    invoke.assert_not_called()


def test_actual_route_forwards_only_retained_ids(monkeypatch):
    client, invoke = mount(monkeypatch)
    response = client.post(ROUTE, json=REQUEST, headers={"X-Internal-Token": TOKEN})
    assert response.status_code == 200
    assert response.json()["output"] == {"accepted": False}
    assert invoke.call_args.args[1].model_dump() == REQUEST


@pytest.mark.parametrize("failure,status,detail", [(EvidenceAlreadyClaimedError("private fixture"),409,"staged_evidence_already_claimed"),(ValueError("private provider fixture"),503,"staged_evidence_unconfirmed")])
def test_claimed_or_uncertain_dispatch_never_exposes_cause_or_retries(monkeypatch, failure, status, detail):
    client, invoke = mount(monkeypatch, failure)
    response = client.post(ROUTE, json=REQUEST, headers={"X-Internal-Token": TOKEN})
    assert response.status_code == status
    assert response.json() == {"detail": detail}
    invoke.assert_awaited_once()


def test_generic_saakshi_cannot_bypass_persisted_human_intent(monkeypatch):
    client, invoke = mount(monkeypatch)
    legacy = AsyncMock(return_value=AgentRunResult(agent=AgentName.SAAKSHI, correlation_id=REQUEST["operation_key"], status="succeeded", output={"legacy": True}))
    monkeypatch.setattr(app.state, "agents", {AgentName.SAAKSHI: SimpleNamespace(name=AgentName.SAAKSHI, invoke=legacy)}, raising=False)
    response = client.post("/agents/saakshi/invoke", json={"input": {"contentBase64": "private"}}, headers={"X-Internal-Token": TOKEN})
    assert response.status_code == 403
    assert response.json() == {"detail": "staged_evidence_workflow_required"}
    legacy.assert_not_called()
    invoke.assert_not_called()


def test_stage_peer_and_source_keys_are_independent_from_other_server_credentials():
    for key in ("p" * 48, "s" * 48):
        with pytest.raises(ValueError, match="configuration is unavailable"):
            InternalEvidenceStageTransport(stage_url="http://localhost/internal/staged-evidence/stage", peer_secret="p" * 48, source_secret="s" * 48, other_secrets=(key,))


@pytest.mark.parametrize("flag,enabled", [("true", True), ("false", False), ("1", False), ("TRUE", False), ("yes", False)])
def test_runtime_enablement_matches_explicit_bff_configuration(monkeypatch, flag, enabled):
    from axiom.config import Settings
    monkeypatch.setenv("AXIOM_SAAKSHI_STAGE_ENABLED", flag)
    assert Settings(_env_file=None).saakshi_stage_enabled is enabled
