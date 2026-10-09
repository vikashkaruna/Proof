"""Synthetic restricted transport tests; not durable/live Sanket acceptance."""

import base64
import json
import secrets
import time
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from pydantic import ValidationError
from test_retained_sanket_source import alter_source, fixture, identifier, scope

from axiom.canonicalise import canonical_json, sha256_hex
from axiom.config import get_settings
from axiom.ledger_client import LedgerClient
from axiom.retained_sanket_dispatch import (
    RestrictedRetainedSanketStore,
    RetainedSanketAlreadyClaimedError,
    RetainedSanketInvokeRequest,
    prepare_claimed_retained_sanket_source,
)
from axiom.retained_sanket_router import retained_sanket_router

REQUEST = RetainedSanketInvokeRequest(
    tenant_id=scope().tenant_id, run_id=scope().run_id, operation_key=scope().operation_key
)
PATH = "/retained-public-sources/agents/sanket/invoke"


def store():
    return SimpleNamespace(
        load=AsyncMock(return_value=fixture()),
        claim=AsyncMock(return_value={"run_id": scope().run_id, "claimed": True}),
    )


async def test_canonical_source_is_checked_before_exact_exclusive_claim():
    source = store()
    prepared = await prepare_claimed_retained_sanket_source(source, REQUEST)
    assert canonical_json(prepared.input.model_dump(mode="json")) == fixture()["input_text"]
    source.load.assert_awaited_once_with(REQUEST)
    source.claim.assert_awaited_once_with(REQUEST, fixture()["input_hash"])


@pytest.mark.parametrize(
    "mutation",
    ["tenant", "run", "operation", "hash", "witness", "projection", "spacing", "extra"],
)
async def test_poisoned_saved_source_is_never_claimed(mutation):
    source = store()
    row = deepcopy(source.load.return_value)
    if mutation in {"tenant", "run", "operation"}:
        row[{"tenant": "tenant_id", "run": "run_id", "operation": "operation_key"}[mutation]] = (
            identifier(99)
        )
    elif mutation == "hash":
        row["input_hash"] = "a" * 64
    elif mutation == "witness":
        row["capture_result_text"] += " "
    elif mutation == "projection":
        alter_source(row, "title", "Forged hiring notice")
    elif mutation == "spacing":
        row["input_text"] += " "
        row["input_hash"] = sha256_hex(row["input_text"])
    else:
        row["writer_key"] = "private-sentinel"
    source.load.return_value = row
    with pytest.raises(ValueError, match=r"Retained|validation error"):
        await prepare_claimed_retained_sanket_source(source, REQUEST)
    source.claim.assert_not_called()


@pytest.mark.parametrize(
    "claim",
    [
        {"run_id": scope().run_id, "claimed": "true"},
        {"run_id": identifier(99), "claimed": True},
        {"run_id": scope().run_id, "claimed": True, "output": {}},
        {"error": "refused"},
    ],
)
async def test_malformed_or_foreign_claim_is_not_execution_permission(claim):
    source = store()
    source.claim.return_value = claim
    with pytest.raises(ValueError, match=r"Retained|validation error"):
        await prepare_claimed_retained_sanket_source(source, REQUEST)


async def test_lost_claim_is_not_retried_and_later_false_claim_cannot_run():
    source = store()
    source.claim.side_effect = [
        TimeoutError("uncertain"),
        {"run_id": scope().run_id, "claimed": False},
    ]
    with pytest.raises(TimeoutError):
        await prepare_claimed_retained_sanket_source(source, REQUEST)
    assert source.claim.await_count == 1
    with pytest.raises(RetainedSanketAlreadyClaimedError):
        await prepare_claimed_retained_sanket_source(source, REQUEST)
    assert source.claim.await_args_list[0] == source.claim.await_args_list[1]


@pytest.mark.parametrize("extra", ["actor_id", "engagement_id", "input", "source", "agent"])
def test_lookup_request_refuses_all_business_source_or_authority_fields(extra):
    with pytest.raises(ValidationError):
        RetainedSanketInvokeRequest.model_validate({**REQUEST.model_dump(), extra: identifier(99)})


async def test_scoped_rpc_exact_named_parameters_and_no_table_or_retry_fallback():
    client = Mock()
    client.rpc.return_value.execute.return_value.data = {"opaque": True}
    source = RestrictedRetainedSanketStore(client)
    assert await source.load(REQUEST) == {"opaque": True}
    client.rpc.assert_called_once_with(
        "read_retained_sanket_dispatch",
        {
            "p_tenant_id": REQUEST.tenant_id,
            "p_run_id": REQUEST.run_id,
            "p_operation_key": REQUEST.operation_key,
        },
    )
    client.rpc.reset_mock()
    await source.claim(REQUEST, fixture()["input_hash"])
    client.rpc.assert_called_once_with(
        "claim_retained_sanket_dispatch",
        {
            "p_tenant_id": REQUEST.tenant_id,
            "p_run_id": REQUEST.run_id,
            "p_operation_key": REQUEST.operation_key,
            "p_request_hash": fixture()["input_hash"],
        },
    )
    client.table.assert_not_called()
    client.rpc.reset_mock()
    client.rpc.return_value.execute.side_effect = RuntimeError("private-provider-sentinel")
    with pytest.raises(RuntimeError):
        await source.load(REQUEST)
    client.rpc.assert_called_once()
    client.table.assert_not_called()


async def test_invalid_digest_never_reaches_claim_rpc():
    client = Mock()
    with pytest.raises(ValidationError):
        await RestrictedRetainedSanketStore(client).claim(REQUEST, "caller-hash")
    client.rpc.assert_not_called()


def jwt(role="agent_ledger_writer", expiry=None):
    payload = {"role": role, "exp": time.time() + 3600 if expiry is None else expiry}
    claims = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return f"synthetic.{claims}.signature"


@pytest.mark.parametrize("writer", [None, "service", "bad", jwt("service_role"), jwt(expiry=0)])
def test_no_empty_generic_crossrole_expired_or_memory_writer_fallback(monkeypatch, writer):
    create = Mock()
    monkeypatch.setattr("axiom.retained_sanket_dispatch.create_client", create)
    settings = get_settings().model_copy(
        update={"supabase_agent_ledger_writer_key": writer, "supabase_service_key": "service"}
    )
    with pytest.raises(RuntimeError, match="configuration was refused"):
        RestrictedRetainedSanketStore.from_settings(settings)
    create.assert_not_called()


def test_configured_store_has_only_scoped_authorization_and_bounded_rpc_timeout(monkeypatch):
    create = Mock()
    monkeypatch.setattr("axiom.retained_sanket_dispatch.create_client", create)
    writer = jwt()
    settings = get_settings().model_copy(
        update={
            "supabase_anon_key": "synthetic-anon",
            "supabase_agent_ledger_writer_key": writer,
            "supabase_service_key": "synthetic-service",
        }
    )
    RestrictedRetainedSanketStore.from_settings(settings)
    assert create.call_args.args == (settings.supabase_url, "synthetic-anon")
    options = create.call_args.kwargs["options"]
    assert options.headers["Authorization"] == f"Bearer {writer}"
    assert options.postgrest_client_timeout == 10
    create.assert_called_once()


def test_missing_public_gateway_key_cannot_be_replaced_with_service_key(monkeypatch):
    create = Mock()
    monkeypatch.setattr("axiom.retained_sanket_dispatch.create_client", create)
    settings = get_settings().model_copy(
        update={"supabase_anon_key": "", "supabase_agent_ledger_writer_key": jwt()}
    )
    with pytest.raises(RuntimeError, match="configuration was refused"):
        RestrictedRetainedSanketStore.from_settings(settings)
    create.assert_not_called()


def install():
    source = store()
    ledger = LedgerClient.in_memory()
    token = secrets.token_hex(32)

    def require_peer(request: Request):
        supplied = request.headers.get("X-Internal-Token", "")
        if not secrets.compare_digest(supplied, token):
            raise HTTPException(status_code=401, detail="unauthorized_internal_caller")

    app = FastAPI()
    app.include_router(
        retained_sanket_router(
            store=source, ledger=ledger, settings=get_settings(), require_peer=require_peer
        )
    )
    return TestClient(app), source, ledger, {"X-Internal-Token": token}


def test_protected_http_calls_actual_agent_and_binds_both_runtime_receipts():
    client, source, ledger, headers = install()
    response = client.post(PATH, json=REQUEST.model_dump(), headers=headers)
    assert response.status_code == 200
    result = response.json()
    assert result["agent"] == "sanket"
    assert result["status"] == "succeeded"
    assert len(result["ledger_entry_ids"]) == 2
    assert result["output"]["high_intent"] == []
    assert {item["score"] for item in result["output"]["signals"]} == {0}
    assert result["output"]["source_observations"][0]["capture_reference"] == identifier(6)
    source.claim.assert_awaited_once()
    for entry in ledger.memory_entries:
        assert entry["tenant_id"] == scope().tenant_id
        assert entry["target_ref"] == scope().engagement_id
        assert entry["correlation_id"] == scope().operation_key
        assert entry["input_hash"] == fixture()["input_hash"]
        assert entry["detail"]["run_id"] == scope().run_id
        assert entry["detail"]["request_hash"] == fixture()["input_hash"]
    assert ledger.memory_entries[1]["output_hash"] == sha256_hex(canonical_json(result["output"]))


def test_second_http_request_cannot_repeat_work_after_original_exclusive_claim():
    client, source, ledger, headers = install()
    source.claim.side_effect = [
        {"run_id": scope().run_id, "claimed": True},
        {"run_id": scope().run_id, "claimed": False},
    ]
    assert client.post(PATH, json=REQUEST.model_dump(), headers=headers).status_code == 200
    assert len(ledger.memory_entries) == 2
    assert client.post(PATH, json=REQUEST.model_dump(), headers=headers).status_code == 409
    assert len(ledger.memory_entries) == 2
    assert source.claim.await_args_list[0] == source.claim.await_args_list[1]


def test_peer_guard_and_strict_body_precede_source_reads_or_receipts():
    client, source, ledger, headers = install()
    assert client.post(PATH, json=REQUEST.model_dump()).status_code == 401
    assert (
        client.post(PATH, json={**REQUEST.model_dump(), "source": {}}, headers=headers).status_code
        == 422
    )
    assert (
        client.post(
            PATH.replace("sanket", "nazar"), json=REQUEST.model_dump(), headers=headers
        ).status_code
        == 404
    )
    source.load.assert_not_called()
    source.claim.assert_not_called()
    assert ledger.memory_entries == []


@pytest.mark.parametrize("failure", ["load", "claim", "claimed", "source"])
def test_uncertain_or_repeated_dispatch_never_does_agent_work_and_sanitizes_errors(failure):
    client, source, ledger, headers = install()
    if failure in {"load", "claim"}:
        getattr(source, failure).side_effect = RuntimeError("private-provider-sentinel")
    elif failure == "claimed":
        source.claim.return_value = {"run_id": scope().run_id, "claimed": False}
    else:
        row = fixture()
        alter_source(row, "title", "Fabricated DPO vacancy")
        source.load.return_value = row
    response = client.post(PATH, json=REQUEST.model_dump(), headers=headers)
    assert response.status_code == (409 if failure == "claimed" else 503)
    assert "private-provider-sentinel" not in response.text
    assert ledger.memory_entries == []
    if failure in {"load", "source"}:
        source.claim.assert_not_called()


def test_agent_only_receives_append_only_audit_view(monkeypatch):
    client, source, ledger, headers = install()
    original = ledger.append_only_view
    seen = []

    def append_view():
        view = original()
        seen.append(view)
        assert view._read_client is None
        assert not hasattr(view, "load")
        return view

    monkeypatch.setattr(ledger, "append_only_view", append_view)
    assert client.post(PATH, json=REQUEST.model_dump(), headers=headers).status_code == 200
    assert len(seen) == 1
    source.claim.assert_awaited_once()
