"""Stored exact input and an exclusive runtime claim precede any agent work."""

import secrets
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from test_reviewed_workflow_drafts import CORRELATION, ENGAGEMENT, TENANT, payload
from test_reviewed_workflow_drafts import agent as real_agent

from axiom.app import app
from axiom.canonicalise import canonical_json, sha256_hex
from axiom.ledger_client import LedgerClient
from axiom.reviewed_workflow_dispatch import (
    ReviewedWorkflowAlreadyClaimedError,
    ReviewedWorkflowInvokeRequest,
    prepare_reviewed_workflow_input,
)

RUN = "50000000-0000-4000-8000-000000000009"
REQUEST = ReviewedWorkflowInvokeRequest(tenant_id=TENANT, run_id=RUN, operation_key=CORRELATION)


def transport():
    text = canonical_json(payload())
    return SimpleNamespace(
        load_reviewed_workflow_dispatch=AsyncMock(
            return_value={"run_id": RUN, "request_hash": sha256_hex(text), "input_text": text}
        ),
        claim_reviewed_workflow_dispatch=AsyncMock(return_value={"run_id": RUN, "claimed": True}),
    )


@pytest.mark.asyncio
async def test_original_canonical_source_and_key_are_claimed_exactly():
    ledger = transport()
    result = await prepare_reviewed_workflow_input(ledger, REQUEST)
    assert result == payload()
    ledger.load_reviewed_workflow_dispatch.assert_awaited_once_with(
        tenant_id=TENANT, run_id=RUN, operation_key=CORRELATION
    )
    ledger.claim_reviewed_workflow_dispatch.assert_awaited_once_with(
        tenant_id=TENANT,
        run_id=RUN,
        operation_key=CORRELATION,
        request_hash=sha256_hex(canonical_json(payload())),
    )


@pytest.mark.parametrize(
    "mutation",
    ["run", "hash", "tenant", "whitespace", "unknown", "bad_json", "oversize", "normalization"],
)
@pytest.mark.asyncio
async def test_poisoned_stored_source_never_claims(mutation):
    ledger = transport()
    value = deepcopy(ledger.load_reviewed_workflow_dispatch.return_value)
    if mutation == "run":
        value["run_id"] = ENGAGEMENT
    elif mutation == "hash":
        value["request_hash"] = "0" * 64
    elif mutation == "tenant":
        modified = payload()
        modified["tenant_id"] = RUN
        value["input_text"] = canonical_json(modified)
    elif mutation == "whitespace":
        value["input_text"] += " "
    elif mutation == "unknown":
        value["writer_secret"] = "never-disclose"
    elif mutation == "bad_json":
        value["input_text"] = "{"
    elif mutation == "oversize":
        value["input_text"] = " " * 524289
    else:
        value["input_text"] = value["input_text"].replace(TENANT, TENANT.upper())
    if mutation not in {"hash", "run", "unknown"}:
        value["request_hash"] = sha256_hex(value["input_text"])
    ledger.load_reviewed_workflow_dispatch.return_value = value
    with pytest.raises(ValueError, match=r"Reviewed source|validation error|Invalid JSON"):
        await prepare_reviewed_workflow_input(ledger, REQUEST)
    ledger.claim_reviewed_workflow_dispatch.assert_not_called()


@pytest.mark.parametrize(
    "claim",
    [
        {"run_id": RUN, "claimed": "true"},
        {"run_id": ENGAGEMENT, "claimed": True},
        {"error": "refused"},
    ],
)
@pytest.mark.asyncio
async def test_unconfirmed_or_changed_claim_is_not_execution_permission(claim):
    ledger = transport()
    ledger.claim_reviewed_workflow_dispatch.return_value = claim
    with pytest.raises(ValueError, match=r"Reviewed source|validation error|Invalid JSON"):
        await prepare_reviewed_workflow_input(ledger, REQUEST)


@pytest.mark.asyncio
async def test_repeated_or_lost_claim_does_not_make_a_new_attempt():
    ledger = transport()
    ledger.claim_reviewed_workflow_dispatch.side_effect = [
        TimeoutError("uncertain"),
        {"run_id": RUN, "claimed": False},
    ]
    with pytest.raises(TimeoutError):
        await prepare_reviewed_workflow_input(ledger, REQUEST)
    with pytest.raises(ReviewedWorkflowAlreadyClaimedError):
        await prepare_reviewed_workflow_input(ledger, REQUEST)
    calls = ledger.claim_reviewed_workflow_dispatch.await_args_list
    assert calls[0] == calls[1]


@pytest.mark.parametrize("extra", [{"input": payload()}, {"actor_id": RUN}, {"agent": "vibhaag"}])
def test_request_accepts_only_lookup_identifiers(extra):
    with pytest.raises(ValidationError):
        ReviewedWorkflowInvokeRequest.model_validate({**REQUEST.model_dump(), **extra})


@pytest.mark.asyncio
async def test_no_memory_source_authority_and_no_agent_read_claim_capability():
    ledger = LedgerClient.__new__(LedgerClient)
    ledger._in_memory = True
    ledger._client = None
    ledger._read_client = None
    ledger._mem = []
    ledger._mem_chains = {}
    for method in [ledger.load_reviewed_workflow_dispatch, ledger.claim_reviewed_workflow_dispatch]:
        with pytest.raises(RuntimeError):
            await method(
                tenant_id=TENANT,
                run_id=RUN,
                operation_key=CORRELATION,
                **({"request_hash": "a" * 64} if "claim" in method.__name__ else {}),
            )
    facade = ledger.append_only_view()
    for method in [facade.load_reviewed_workflow_dispatch, facade.claim_reviewed_workflow_dispatch]:
        with pytest.raises(PermissionError):
            await method()


@pytest.mark.asyncio
async def test_scoped_transport_rpc_arguments_do_not_use_read_service_client():
    ledger = LedgerClient.__new__(LedgerClient)
    ledger._in_memory = False
    ledger._client = Mock()
    ledger._read_client = Mock(side_effect=AssertionError("broader reader forbidden"))
    ledger._client.rpc.return_value.execute.return_value.data = {"record": "opaque"}
    assert await ledger.load_reviewed_workflow_dispatch(
        tenant_id=TENANT, run_id=RUN, operation_key=CORRELATION
    ) == {"record": "opaque"}
    ledger._client.rpc.assert_called_with(
        "read_reviewed_workflow_dispatch",
        {"p_tenant_id": TENANT, "p_run_id": RUN, "p_operation_key": CORRELATION},
    )
    await ledger.claim_reviewed_workflow_dispatch(
        tenant_id=TENANT, run_id=RUN, operation_key=CORRELATION, request_hash="a" * 64
    )
    ledger._client.rpc.assert_called_with(
        "claim_reviewed_workflow_dispatch",
        {
            "p_tenant_id": TENANT,
            "p_run_id": RUN,
            "p_operation_key": CORRELATION,
            "p_request_hash": "a" * 64,
        },
    )
    ledger._read_client.assert_not_called()


def install_http(monkeypatch):
    ledger = transport()
    instance = real_agent()
    instance.invoke = AsyncMock(wraps=instance.invoke)
    token = secrets.token_hex(32)
    monkeypatch.setattr(app.state, "settings", SimpleNamespace(internal_token=token), raising=False)
    monkeypatch.setattr(app.state, "ledger", ledger, raising=False)
    monkeypatch.setattr(app.state, "reviewed_workflow_agent", instance, raising=False)
    return TestClient(app), ledger, instance, {"X-Internal-Token": token}


def test_protected_http_runs_real_credentialless_agent_with_bound_receipts(monkeypatch):
    client, ledger, instance, headers = install_http(monkeypatch)
    response = client.post(
        "/reviewed-workflows/agents/vibhaag/invoke", json=REQUEST.model_dump(), headers=headers
    )
    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "succeeded"
    assert result["ledger_entry_ids"] == ["31", "32"]
    assert result["output"]["persistence"] == "not_saved"
    assert result["output"]["policy_drafts"][0]["publication_status"] == "unpublished"
    assert result["output"]["processing_reviews"][0]["declarations"]["crossBorder"] is False
    assert result["output"]["playbook_reviews"][0]["measurement_status"] == "not_verified"
    assert ledger.claim_reviewed_workflow_dispatch.await_count == instance.invoke.await_count == 1
    for call in instance.ledger.append.await_args_list:
        event = call.args[0]
        assert event.detail["run_id"] == RUN
        assert event.detail["request_hash"] == sha256_hex(canonical_json(payload()))
        assert event.target_ref == ENGAGEMENT


def test_protected_http_auth_and_strict_lookup_precede_any_read_or_work(monkeypatch):
    client, ledger, instance, headers = install_http(monkeypatch)
    assert (
        client.post(
            "/reviewed-workflows/agents/vibhaag/invoke", json=REQUEST.model_dump()
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/reviewed-workflows/agents/vibhaag/invoke",
            json={**REQUEST.model_dump(), "input": payload()},
            headers=headers,
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/reviewed-workflows/agents/drishti/invoke", json=REQUEST.model_dump(), headers=headers
        ).status_code
        == 404
    )
    ledger.load_reviewed_workflow_dispatch.assert_not_called()
    instance.invoke.assert_not_called()


@pytest.mark.parametrize("failure", ["read", "claim", "claimed"])
def test_protected_http_never_invokes_on_unconfirmed_or_repeated_claim(monkeypatch, failure):
    client, ledger, instance, headers = install_http(monkeypatch)
    if failure == "read":
        ledger.load_reviewed_workflow_dispatch.side_effect = RuntimeError(
            "provider-private-sentinel"
        )
    elif failure == "claim":
        ledger.claim_reviewed_workflow_dispatch.side_effect = TimeoutError(
            "provider-private-sentinel"
        )
    else:
        ledger.claim_reviewed_workflow_dispatch.return_value = {"run_id": RUN, "claimed": False}
    response = client.post(
        "/reviewed-workflows/agents/vibhaag/invoke", json=REQUEST.model_dump(), headers=headers
    )
    assert response.status_code == (409 if failure == "claimed" else 503)
    assert "provider-private-sentinel" not in response.text
    instance.invoke.assert_not_called()
