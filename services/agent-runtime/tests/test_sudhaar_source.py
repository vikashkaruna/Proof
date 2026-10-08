"""Signature tests use only synthetic facts and in-memory audit telemetry."""

import hashlib
import hmac
import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from test_sudhaar import source_input

from axiom.agents.base import AgentName
from axiom.agents.sudhaar import SudhaarAgent
from axiom.canonicalise import canonical_json, sha256_hex
from axiom.sudhaar_source import SignedPlanningRequest, verify_planning_request

KEY = "synthetic-only-key-" + "x" * 32
PEER = "synthetic-peer-only-" + "y" * 32
NOW = 1_800_000_000
RUN = "55555555-5555-4555-8555-555555555555"
CORRELATION = "66666666-6666-4666-8666-666666666666"


def signed(value=None, **updates):
    text = canonical_json(value or source_input())
    payload = {
        "version": 1,
        "input_text": text,
        "correlation_id": CORRELATION,
        "dispatch_context": {"run_id": RUN, "request_hash": sha256_hex(text)},
        "expires_at": NOW + 90,
        **updates,
    }
    raw = canonical_json(payload)
    return {
        "signed_text": raw,
        "signature": hmac.new(
            KEY.encode(), b"axiom-sudhaar-source-v1\0" + raw.encode(), hashlib.sha256
        ).hexdigest(),
    }


def test_valid_signature_binds_exact_source_input_and_dispatch():
    value, correlation, context = verify_planning_request(
        SignedPlanningRequest(**signed()), KEY, NOW
    )
    assert value.model_dump(mode="json") == source_input()
    assert correlation == CORRELATION
    assert str(context.run_id) == RUN


@pytest.mark.parametrize(
    "case", ["signature", "body", "expiry", "future", "context", "scope", "secret", "serialization"]
)
def test_invalid_planning_capability_refused(case):
    value = signed()
    key = KEY
    if case == "signature":
        value["signature"] = "0" * 64
    if case == "body":
        value["signed_text"] = value["signed_text"].replace("Control", "Forged")
    if case == "expiry":
        value = signed(expires_at=NOW - 1)
    if case == "future":
        value = signed(expires_at=NOW + 10000)
    if case == "context":
        value = signed(dispatch_context={"run_id": RUN, "request_hash": "0" * 64})
    if case == "scope":
        source = source_input()
        source["scope_hints"] = {}
        value = signed(source)
    if case == "secret":
        key = "short"
    if case == "serialization":
        payload = json.loads(value["signed_text"])
        value["signed_text"] = json.dumps(payload)
        value["signature"] = hmac.new(
            KEY.encode(),
            b"axiom-sudhaar-source-v1\0" + value["signed_text"].encode(),
            hashlib.sha256,
        ).hexdigest()
    with pytest.raises(ValueError, match=r"Planning|SudhaarInput"):
        verify_planning_request(SignedPlanningRequest(**value), key, NOW)


@pytest.mark.asyncio
async def test_real_runtime_http_signed_planner_and_generic_bypass_refusal(monkeypatch):
    from axiom.app import app

    monkeypatch.setattr(
        app.state,
        "settings",
        SimpleNamespace(internal_token=PEER, planning_source_signing_key=KEY),
        raising=False,
    )
    agent = SudhaarAgent()
    monkeypatch.setattr(app.state, "agents", {AgentName.SUDHAAR: agent}, raising=False)
    monkeypatch.setattr("axiom.sudhaar_source.time.time", lambda: NOW)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/assessment-source/sudhaar/invoke", json=signed(), headers={"X-Internal-Token": PEER}
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "succeeded"
        assert body["output"]["execution_allowed"] is False
        assert len(body["ledger_entry_ids"]) == 2
        assert (
            await client.post(
                "/agents/sudhaar/invoke",
                json={"input": source_input()},
                headers={"X-Internal-Token": PEER},
            )
        ).status_code == 403
        forged = signed()
        forged["signature"] = "0" * 64
        assert (
            await client.post(
                "/assessment-source/sudhaar/invoke", json=forged, headers={"X-Internal-Token": PEER}
            )
        ).status_code == 403
        assert (
            await client.post("/assessment-source/sudhaar/invoke", json=signed())
        ).status_code == 401
        assert len(agent.ledger.memory_entries) == 2


@pytest.mark.asyncio
async def test_actual_python_planner_matches_shared_typescript_signed_46_row_fixture():
    fixture = json.loads(
        (Path(__file__).resolve().parents[3] / "tests/contracts/sudhaar-source.v1.json").read_text()
    )
    assert fixture["syntheticOnly"] is True
    value, correlation, context = verify_planning_request(
        SignedPlanningRequest(**fixture["envelope"]), KEY, fixture["nowSeconds"]
    )
    assert value.model_dump(mode="json") == fixture["input"]
    result = await SudhaarAgent().invoke(
        value, correlation_id=correlation, dispatch_context=context
    )
    assert result.status == "succeeded"
    assert result.output == fixture["expectedOutput"]
    assert len(result.output["review_tasks"]) == 46
    assert sum(f.answer_counts.unknown for f in value.findings) == 65
    assert len(result.ledger_entry_ids) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["peer_forgery", "absent", "weak", "equal"])
async def test_peer_auth_alone_never_establishes_planning_source_authority(monkeypatch, mode):
    from unittest.mock import AsyncMock

    from axiom.app import app

    key = {"absent": None, "weak": "short", "equal": PEER}.get(mode, KEY)
    agent = SudhaarAgent()
    invocation = AsyncMock(wraps=agent.invoke)
    monkeypatch.setattr(agent, "invoke", invocation)
    monkeypatch.setattr(
        app.state,
        "settings",
        SimpleNamespace(internal_token=PEER, planning_source_signing_key=key),
        raising=False,
    )
    monkeypatch.setattr(app.state, "agents", {AgentName.SUDHAAR: agent}, raising=False)
    monkeypatch.setattr("axiom.sudhaar_source.time.time", lambda: NOW)
    envelope = signed()
    if mode in {"peer_forgery", "equal"}:
        envelope["signature"] = hmac.new(
            PEER.encode(),
            b"axiom-sudhaar-source-v1\0" + envelope["signed_text"].encode(),
            hashlib.sha256,
        ).hexdigest()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/assessment-source/sudhaar/invoke", json=envelope, headers={"X-Internal-Token": PEER}
        )
    assert response.status_code == (503 if mode == "absent" else 403)
    invocation.assert_not_called()
    assert agent.ledger.memory_entries == []


@pytest.mark.parametrize("mode", ["absent", "weak", "equal", "independent"])
def test_runtime_configuration_source_key_is_optional_but_never_shared(mode):
    from axiom.config import Settings

    kwargs = {"internal_token": PEER}
    if mode != "absent":
        kwargs["planning_source_signing_key"] = {
            "weak": "short",
            "equal": PEER,
            "independent": KEY,
        }[mode]
    if mode in {"weak", "equal"}:
        with pytest.raises(ValueError, match="AXIOM_PLANNING_SOURCE_SIGNING_KEY"):
            Settings(**kwargs)
    else:
        assert Settings(**kwargs).planning_source_signing_key == (
            KEY if mode == "independent" else None
        )


@pytest.mark.parametrize("field", ["approval_signing_key", "model_gateway_api_key"])
def test_runtime_refuses_source_key_reused_from_other_peer_credentials(field):
    from axiom.config import Settings

    with pytest.raises(ValueError, match="AXIOM_PLANNING_SOURCE_SIGNING_KEY"):
        Settings(planning_source_signing_key=KEY, **{field: KEY})


def test_hardened_runtime_refuses_committed_placeholder_source_key():
    from axiom.config import Settings

    with pytest.raises(ValueError, match="AXIOM_PLANNING_SOURCE_SIGNING_KEY"):
        Settings(environment="staging", planning_source_signing_key="dev-" + "p" * 40)


def test_invalid_key_startup_error_and_settings_repr_do_not_print_source_secret():
    from axiom.config import Settings

    marker = "dev-sensitive-source-key-" + "p" * 40
    with pytest.raises(ValueError, match="AXIOM_PLANNING_SOURCE_SIGNING_KEY") as caught:
        Settings(environment="staging", planning_source_signing_key=marker)
    assert marker not in str(caught.value)
    assert KEY not in repr(Settings(planning_source_signing_key=KEY))
