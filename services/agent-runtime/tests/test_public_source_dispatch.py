"""Recorded source lookup, one execution claim and existing receipt boundaries."""

import secrets
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi.testclient import TestClient
from test_public_source_agents import (
    CORRELATION,
    RUN,
    TENANT,
    agent_fixture,
    classification_input,
    discovery_input,
)

from axiom.agents.base import AgentName
from axiom.agents.drishti import DrishtiAgent
from axiom.agents.vibhaag import VibhaagAgent
from axiom.app import app
from axiom.canonicalise import canonical_json, sha256_hex
from axiom.ledger_client import LedgerClient

DISPATCH = "f0000000-0000-4000-8000-000000000006"
REQUEST = {"tenant_id": TENANT, "run_id": RUN, "correlation_id": CORRELATION}


def install(monkeypatch, payload=None, name="drishti"):
    payload = payload or discovery_input()
    ledger = SimpleNamespace(
        load_public_source_dispatch=AsyncMock(
            return_value={
                "dispatch_id": DISPATCH,
                "input": payload,
                "request_hash": sha256_hex(canonical_json(payload)),
            }
        ),
        claim_public_source_dispatch=AsyncMock(
            return_value={"dispatch_id": DISPATCH, "claimed": True}
        ),
    )
    agent = agent_fixture(DrishtiAgent if name == "drishti" else VibhaagAgent)
    agent.invoke = AsyncMock(wraps=agent.invoke)
    token = secrets.token_hex(32)
    monkeypatch.setattr(app.state, "settings", SimpleNamespace(internal_token=token), raising=False)
    monkeypatch.setattr(app.state, "ledger", ledger, raising=False)
    monkeypatch.setattr(app.state, "agents", {AgentName(name): agent}, raising=False)
    return TestClient(app), ledger, agent, {"X-Internal-Token": token}


def test_recorded_http_work_preserves_approved_context_and_both_runtime_receipts(monkeypatch):
    client, ledger, agent, headers = install(monkeypatch)
    response = client.post("/public-source/agents/drishti/invoke", json=REQUEST, headers=headers)
    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "succeeded"
    assert result["correlation_id"] == CORRELATION
    assert result["ledger_entry_ids"] == ["1", "2"]
    assert result["output"]["observation"]["private_facts"] == {
        "hosting_region": "unknown",
        "backend_personal_data": "unknown",
        "cross_border_processing": "unknown",
    }
    ledger.load_public_source_dispatch.assert_awaited_once_with(
        tenant_id=TENANT, run_id=RUN, agent="drishti", correlation_id=CORRELATION
    )
    ledger.claim_public_source_dispatch.assert_awaited_once()
    for call in agent.ledger.append.await_args_list:
        event = call.args[0]
        assert event.detail["run_id"] == RUN
        assert event.detail["request_hash"] == sha256_hex(canonical_json(discovery_input()))
        assert event.target_ref == discovery_input()["engagement_id"]


@pytest.mark.asyncio
async def test_classification_uses_loaded_discovery_without_client_facts(monkeypatch):
    payload = await classification_input()
    client, ledger, agent, headers = install(monkeypatch, payload, "vibhaag")
    response = client.post("/public-source/agents/vibhaag/invoke", json=REQUEST, headers=headers)
    assert response.status_code == 200
    assert response.json()["output"]["indicators"][0]["input_type"] == "email"
    assert response.json()["output"]["scope_limited"] is True
    assert agent.invoke.await_count == ledger.claim_public_source_dispatch.await_count == 1


@pytest.mark.parametrize("extra", [{"input": {}}, {"source": {}}, {"dispatch_id": DISPATCH}])
def test_transport_accepts_lookup_identifiers_only(monkeypatch, extra):
    client, ledger, agent, headers = install(monkeypatch)
    response = client.post(
        "/public-source/agents/drishti/invoke", json={**REQUEST, **extra}, headers=headers
    )
    assert response.status_code == 422
    ledger.load_public_source_dispatch.assert_not_called()
    agent.invoke.assert_not_called()


def test_internal_auth_and_agent_boundary_precede_any_lookup(monkeypatch):
    client, ledger, agent, headers = install(monkeypatch)
    assert client.post("/public-source/agents/drishti/invoke", json=REQUEST).status_code == 401
    for name in ["karya", "prativedan", "sudhaar", "DRISHTI", "unknown"]:
        assert (
            client.post(
                f"/public-source/agents/{name}/invoke", json=REQUEST, headers=headers
            ).status_code
            == 404
        )
    ledger.load_public_source_dispatch.assert_not_called()
    ledger.claim_public_source_dispatch.assert_not_called()
    agent.invoke.assert_not_called()


@pytest.mark.parametrize("mutation", ["hash", "tenant", "legacy", "unavailable", "extra"])
def test_unconfirmed_or_poisoned_dispatch_never_claims_or_executes(monkeypatch, mutation):
    client, ledger, agent, headers = install(monkeypatch)
    value = deepcopy(ledger.load_public_source_dispatch.return_value)
    if mutation == "hash":
        value["request_hash"] = "0" * 64
    elif mutation == "tenant":
        value["input"]["tenant_id"] = RUN
        value["input"]["source"]["binding"]["tenant_id"] = RUN
        value["request_hash"] = sha256_hex(canonical_json(value["input"]))
    elif mutation == "legacy":
        value["input"] = {"tenant_id": TENANT, "engagement_id": RUN, "systems": []}
        value["request_hash"] = sha256_hex(canonical_json(value["input"]))
    elif mutation == "unavailable":
        value = {"error": "forbidden", "private": "provider-private-sentinel"}
    else:
        value["private"] = "provider-private-sentinel"
    ledger.load_public_source_dispatch.return_value = value
    response = client.post("/public-source/agents/drishti/invoke", json=REQUEST, headers=headers)
    assert response.status_code == 503
    assert response.json() == {"detail": "public_source_dispatch_unconfirmed"}
    assert "provider-private-sentinel" not in response.text
    ledger.claim_public_source_dispatch.assert_not_called()
    agent.invoke.assert_not_called()
    agent.ledger.append.assert_not_called()


@pytest.mark.parametrize(
    ("claim", "status"),
    [
        ({"dispatch_id": DISPATCH, "claimed": False}, 409),
        ({"dispatch_id": RUN, "claimed": True}, 503),
        ({"dispatch_id": DISPATCH, "claimed": 1}, 503),
        ({"dispatch_id": DISPATCH, "claimed": "true"}, 503),
        ({"error": "forbidden"}, 503),
    ],
)
def test_claim_must_confirm_exact_dispatch_and_actual_boolean(monkeypatch, claim, status):
    client, ledger, agent, headers = install(monkeypatch)
    ledger.claim_public_source_dispatch.return_value = claim
    response = client.post("/public-source/agents/drishti/invoke", json=REQUEST, headers=headers)
    assert response.status_code == status
    agent.invoke.assert_not_called()
    agent.ledger.append.assert_not_called()


def test_unknown_claim_outcome_is_not_retried_or_executed(monkeypatch):
    client, ledger, agent, headers = install(monkeypatch)
    ledger.claim_public_source_dispatch.side_effect = RuntimeError("provider-private-sentinel")
    response = client.post("/public-source/agents/drishti/invoke", json=REQUEST, headers=headers)
    assert response.status_code == 503
    assert "provider-private-sentinel" not in response.text
    assert ledger.claim_public_source_dispatch.await_count == 1
    agent.invoke.assert_not_called()


@pytest.mark.asyncio
async def test_scoped_reader_and_claim_use_only_the_restricted_rpc_arguments():
    client = SimpleNamespace(
        rpc=Mock(
            return_value=SimpleNamespace(
                execute=Mock(return_value=SimpleNamespace(data={"ok": True}))
            )
        )
    )
    ledger = LedgerClient(client)
    assert await ledger.load_public_source_dispatch(
        tenant_id=TENANT, run_id=RUN, agent="drishti", correlation_id=CORRELATION
    ) == {"ok": True}
    assert client.rpc.call_args.args == (
        "get_public_source_dispatch_input",
        {
            "p_tenant_id": TENANT,
            "p_run_id": RUN,
            "p_agent": "drishti",
            "p_correlation_id": CORRELATION,
        },
    )
    assert await ledger.claim_public_source_dispatch(
        tenant_id=TENANT,
        run_id=RUN,
        agent="drishti",
        correlation_id=CORRELATION,
        dispatch_id=DISPATCH,
        request_hash="a" * 64,
    ) == {"ok": True}
    assert client.rpc.call_args.args == (
        "claim_public_source_dispatch",
        {
            "p_tenant_id": TENANT,
            "p_run_id": RUN,
            "p_agent": "drishti",
            "p_correlation_id": CORRELATION,
            "p_dispatch_id": DISPATCH,
            "p_request_hash": "a" * 64,
        },
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("ledger", [LedgerClient.in_memory(), LedgerClient()])
async def test_public_work_never_uses_in_memory_or_missing_source_credentials(ledger):
    with pytest.raises(RuntimeError):
        await ledger.load_public_source_dispatch(
            tenant_id=TENANT, run_id=RUN, agent="drishti", correlation_id=CORRELATION
        )
    with pytest.raises(RuntimeError):
        await ledger.claim_public_source_dispatch(
            tenant_id=TENANT,
            run_id=RUN,
            agent="drishti",
            correlation_id=CORRELATION,
            dispatch_id=DISPATCH,
            request_hash="a" * 64,
        )
