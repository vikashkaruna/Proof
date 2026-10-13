"""Synthetic transport tests with actual BaseAgent invocation; NOT PostgreSQL proof."""

from copy import deepcopy
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from test_prativedan_assessment_draft_codec import claimed, receipt
from test_prativedan_assessment_draft_codec import packet as codec_packet

from axiom.agents.prativedan import PrativedanAgent
from axiom.canonicalise import canonical_json, sha256_hex
from axiom.ledger_client import AppendOnlyLedgerClient
from axiom.prativedan_assessment_dispatch import (
    AssessmentDispatchRefusedError,
    AssessmentInvocationUncertainError,
    invoke_assessment_draft,
    recover_assessment_draft,
)
from axiom.prativedan_assessment_store import PrativedanAssessmentStore

NOW = datetime(2026, 10, 13, 10, tzinfo=UTC)


@pytest.fixture
def harness():
    packet = codec_packet.__wrapped__()
    rows = []
    client = Mock()

    def rpc(name, args):
        assert name == "append_agent_ledger"
        identifier = str(9007199254740993 + len(rows))
        rows.append({"id": identifier, "entry_hash": sha256_hex(canonical_json(args)), **args})
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=identifier))

    client.rpc.side_effect = rpc
    agent = object.__new__(PrativedanAgent)
    agent.ledger = AppendOnlyLedgerClient(client)
    agent.log = Mock()
    context = SimpleNamespace(
        packet=packet, rows=rows, calls=[], agent=agent, claimed=False, edit=None, fail=None
    )

    async def call(name, args):
        context.calls.append((name, args))
        if name == context.fail:
            raise TimeoutError("Synthetic transport loss")
        if name == "load_prativedan_assessment_dispatch":
            return deepcopy(claimed(packet) if context.claimed else packet["readback"])
        if name == "claim_prativedan_assessment_draft":
            replay = context.claimed
            context.claimed = True
            journal = claimed(packet)
            return (
                {"claimed": False, "invocation_uncertain": True, "readback": journal}
                if replay
                else {
                    "claimed": True,
                    "expires_at": journal["claim_expires_at"],
                    "readback": journal,
                }
            )
        assert name == "read_prativedan_assessment_runtime_receipts"
        journal = claimed(packet)
        b = packet["binding"]
        w = {
            key: getattr(b, key)
            for key in (
                "tenant_id",
                "engagement_id",
                "source_id",
                "assessment_run_id",
                "run_id",
                "operation_key",
                "source_sha256",
            )
        }
        w.update(
            schema_version=2,
            request_sha256=sha256_hex(b.request_text),
            runtime_normalized_input_sha256=rows[1]["p_input_hash"],
            runtime_output_sha256=rows[1]["p_output_hash"],
            renderer_config_version=journal["renderer_config_version"],
            renderer_config_sha256=journal["renderer_config_sha256"],
            agent="prativedan",
            agent_version="0.1.0",
            correlation_id=b.operation_key,
            target_ref=b.engagement_id,
            requested_receipt=journal["requested_receipt"],
            claimed_receipt=journal["claimed_receipt"],
            started_receipt={key: rows[0][key] for key in ("id", "entry_hash")},
            completed_receipt={key: rows[1][key] for key in ("id", "entry_hash")},
            claim_expires_at=journal["claim_expires_at"],
            completed_at="2026-10-13T10:00:01+00:00",
        )
        if context.edit:
            context.edit(w)
        return w

    context.store = PrativedanAssessmentStore(SimpleNamespace(call=call))
    return context


@pytest.mark.asyncio
async def test_actual_base_invoke_and_independent_huge_string_receipts(harness):
    envelope = await invoke_assessment_draft(
        harness.store, harness.packet["binding"], harness.agent, clock=lambda: NOW
    )
    assert envelope.started_receipt.id == "9007199254740993"
    assert envelope.completed_receipt.id == "9007199254740994"
    assert sha256_hex(envelope.runtime_output_text) == envelope.runtime_output_sha256
    assert len(harness.rows) == 2
    assert harness.rows[0]["p_detail"]["phase"] == "started"
    assert harness.rows[1]["p_detail"]["started_entry"] == envelope.started_receipt.id
    assert [c[0] for c in harness.calls] == [
        "load_prativedan_assessment_dispatch",
        "claim_prativedan_assessment_draft",
        "read_prativedan_assessment_runtime_receipts",
    ]
    assert harness.calls[-1][1]["started"] == "9007199254740993"


@pytest.mark.asyncio
async def test_invalid_agent_zero_calls(harness):
    with pytest.raises(AssessmentDispatchRefusedError):
        await invoke_assessment_draft(
            harness.store, harness.packet["binding"], Mock(), clock=lambda: NOW
        )
    assert harness.calls == []
    assert harness.rows == []


@pytest.mark.asyncio
async def test_existing_claim_refused_without_second_claim(harness):
    harness.claimed = True
    with pytest.raises(AssessmentDispatchRefusedError):
        await invoke_assessment_draft(
            harness.store, harness.packet["binding"], harness.agent, clock=lambda: NOW
        )
    assert len(harness.calls) == 1
    assert harness.rows == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "rpc", ["claim_prativedan_assessment_draft", "read_prativedan_assessment_runtime_receipts"]
)
async def test_transport_loss_uncertain_never_retried(harness, rpc):
    harness.fail = rpc
    with pytest.raises(AssessmentInvocationUncertainError):
        await invoke_assessment_draft(
            harness.store, harness.packet["binding"], harness.agent, clock=lambda: NOW
        )
    assert sum(name == rpc for name, _ in harness.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("runtime_output_sha256", "0" * 64),
        ("runtime_normalized_input_sha256", "0" * 64),
        ("renderer_config_sha256", "0" * 64),
        ("tenant_id", "47520000-0000-4000-8000-000000000099"),
        ("completed_at", "2026-10-13T10:05:01+00:00"),
        ("claim_expires_at", "2026-10-13T15:35:00+05:30"),
        ("started_receipt", receipt(5)),
    ],
)
async def test_mismatched_independent_witness_refused(harness, key, value):
    harness.edit = lambda w: w.update({key: value})
    with pytest.raises(AssessmentInvocationUncertainError):
        await invoke_assessment_draft(
            harness.store, harness.packet["binding"], harness.agent, clock=lambda: NOW
        )


@pytest.mark.asyncio
async def test_expired_claim_no_invocation(harness):
    with pytest.raises(AssessmentInvocationUncertainError):
        await invoke_assessment_draft(
            harness.store,
            harness.packet["binding"],
            harness.agent,
            clock=lambda: NOW.replace(minute=6),
        )
    assert harness.rows == []


@pytest.mark.asyncio
async def test_recovery_read_only_uncertain(harness):
    harness.claimed = True
    result = await recover_assessment_draft(harness.store, harness.packet["binding"])
    assert result.state == "invocation_uncertain"
    assert len(harness.calls) == 1
    assert harness.rows == []


@pytest.mark.asyncio
async def test_real_started_rpc_retains_null_output_hash(harness):
    await invoke_assessment_draft(
        harness.store, harness.packet["binding"], harness.agent, clock=lambda: NOW
    )
    assert harness.rows[0]["p_output_hash"] is None
    assert harness.rows[1]["p_output_hash"] is not None


@pytest.mark.asyncio
async def test_cancellation_after_claim_is_uncertain_without_retry(harness):
    import asyncio
    from unittest.mock import AsyncMock

    harness.agent.invoke = AsyncMock(side_effect=asyncio.CancelledError)
    with pytest.raises(AssessmentInvocationUncertainError):
        await invoke_assessment_draft(
            harness.store, harness.packet["binding"], harness.agent, clock=lambda: NOW
        )
    assert harness.agent.invoke.await_count == 1
    assert len(harness.calls) == 2


@pytest.mark.asyncio
async def test_render_timeout_uncertain_never_retried(harness, monkeypatch):
    import asyncio
    from unittest.mock import AsyncMock

    from axiom import prativedan_assessment_dispatch as dispatch

    async def delayed(*args, **kwargs):
        await asyncio.sleep(1)

    harness.agent.invoke = AsyncMock(side_effect=delayed)
    monkeypatch.setattr(dispatch, "RENDER_TIMEOUT_SECONDS", 0.001)
    with pytest.raises(AssessmentInvocationUncertainError):
        await invoke_assessment_draft(
            harness.store, harness.packet["binding"], harness.agent, clock=lambda: NOW
        )
    assert harness.agent.invoke.await_count == 1
    assert len(harness.calls) == 2


@pytest.mark.asyncio
async def test_two_contenders_only_one_actual_invocation(harness):
    import asyncio

    original = harness.store._rpc.call
    barrier = asyncio.Event()
    loaded = 0

    async def call(name, args):
        nonlocal loaded
        if name == "load_prativedan_assessment_dispatch":
            captured = await original(name, args)
            loaded += 1
            if loaded == 2:
                barrier.set()
            await barrier.wait()
            return captured
        return await original(name, args)

    harness.store._rpc.call = call
    results = await asyncio.gather(
        *(
            invoke_assessment_draft(
                harness.store, harness.packet["binding"], harness.agent, clock=lambda: NOW
            )
            for _ in range(2)
        ),
        return_exceptions=True,
    )
    assert loaded == 2
    assert len(harness.rows) == 2
    assert sum(isinstance(x, AssessmentInvocationUncertainError) for x in results) == 1
    assert sum(name == "claim_prativedan_assessment_draft" for name, _ in harness.calls) == 2


@pytest.mark.asyncio
async def test_requested_load_loss_is_refused_without_claim(harness):
    harness.fail = "load_prativedan_assessment_dispatch"
    with pytest.raises(AssessmentDispatchRefusedError):
        await invoke_assessment_draft(
            harness.store, harness.packet["binding"], harness.agent, clock=lambda: NOW
        )
    assert len(harness.calls) == 1
    assert harness.rows == []


@pytest.mark.asyncio
async def test_changed_renderer_is_refused_before_any_rpc(harness):
    harness.agent.renderer_configuration = Mock(return_value=("wrong", "wrong", "0" * 64))
    with pytest.raises(AssessmentDispatchRefusedError):
        await invoke_assessment_draft(
            harness.store, harness.packet["binding"], harness.agent, clock=lambda: NOW
        )
    assert harness.calls == []


@pytest.mark.asyncio
async def test_nil_binding_refuses_before_any_rpc(harness):
    binding = harness.packet["binding"].model_copy(
        update={"tenant_id": "00000000-0000-0000-0000-000000000000"}
    )
    with pytest.raises(AssessmentDispatchRefusedError):
        await invoke_assessment_draft(harness.store, binding, harness.agent, clock=lambda: NOW)
    assert harness.calls == []


@pytest.mark.asyncio
async def test_rpc_output_none_is_never_success(harness):
    original = harness.store._rpc.call

    async def call(name, args):
        if name == "read_prativedan_assessment_runtime_receipts":
            return None
        return await original(name, args)

    harness.store._rpc.call = call
    with pytest.raises(AssessmentInvocationUncertainError):
        await invoke_assessment_draft(
            harness.store, harness.packet["binding"], harness.agent, clock=lambda: NOW
        )


@pytest.mark.parametrize("key", [None, "invalid"])
def test_scoped_factory_missing_writer_never_falls_back(key, monkeypatch):
    from axiom import prativedan_assessment_store as store

    factory = Mock()
    monkeypatch.setattr(store, "create_client", factory)
    settings = SimpleNamespace(
        supabase_agent_ledger_writer_key=key,
        supabase_service_key=None,
        supabase_url="http://localhost",
        supabase_anon_key="public",
    )
    with pytest.raises((ValueError, RuntimeError)):
        PrativedanAssessmentStore.from_settings(settings)
    factory.assert_not_called()


def test_scoped_factory_has_no_reader_or_service_client(monkeypatch):
    import base64
    import json
    import time

    from axiom import prativedan_assessment_store as store

    claims = (
        base64.urlsafe_b64encode(
            json.dumps({"role": "agent_ledger_writer", "exp": time.time() + 300}).encode()
        )
        .decode()
        .rstrip("=")
    )
    writer = "synthetic." + claims + ".synthetic"
    client = Mock()
    factory = Mock(return_value=client)
    monkeypatch.setattr(store, "create_client", factory)
    settings = SimpleNamespace(
        supabase_agent_ledger_writer_key=writer,
        supabase_service_key="different",
        supabase_url="https://test.invalid",
        supabase_anon_key="public",
    )
    scoped, ledger = PrativedanAssessmentStore.from_settings(settings)
    assert type(ledger) is AppendOnlyLedgerClient
    assert ledger._read_client is None
    assert ledger.in_memory_mode is False
    assert isinstance(scoped, PrativedanAssessmentStore)
    assert factory.call_count == 1
    assert factory.call_args.args == ("https://test.invalid", "public")


@pytest.mark.asyncio
async def test_scoped_rpc_actual_remote_call(harness):
    from axiom.prativedan_assessment_store import _ScopedRpc

    client = Mock()
    client.rpc.return_value.execute.return_value = SimpleNamespace(data={"retained": True})
    result = await _ScopedRpc(client).call("load_prativedan_assessment_dispatch", {"t": "scope"})
    assert result == {"retained": True}
    client.rpc.assert_called_once_with("load_prativedan_assessment_dispatch", {"t": "scope"})


@pytest.mark.asyncio
async def test_server_claim_sample_after_client_send_is_valid(harness):
    from datetime import timedelta

    original = harness.store._rpc.call
    expiry = "2026-10-13T10:05:01+00:00"

    async def call(name, args):
        result = await original(name, args)
        if name == "claim_prativedan_assessment_draft":
            result["expires_at"] = expiry
            result["readback"]["claim_expires_at"] = expiry
        return result

    harness.store._rpc.call = call
    harness.edit = lambda w: w.update(claim_expires_at=expiry)
    samples = iter([NOW, NOW, NOW + timedelta(seconds=2), NOW + timedelta(seconds=2)])
    envelope = await invoke_assessment_draft(
        harness.store, harness.packet["binding"], harness.agent, clock=lambda: next(samples)
    )
    assert envelope.claim_expires_at == expiry
