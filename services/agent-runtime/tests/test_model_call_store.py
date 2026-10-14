"""Synthetic scoped RPC tests; no database or receipt authority is exercised."""

import json
from copy import deepcopy

import pytest
from test_model_call_accounting import observed, uid

from axiom.canonicalise import canonical_json, sha256_hex
from axiom.model_call_accounting import CallOutcome, CallStart, derive_accounting
from axiom.model_call_store import (
    AccountingBinding,
    AccountingStoreError,
    ModelCallStore,
    Receipt,
    verify_accounting_seal,
)


def binding() -> AccountingBinding:
    return AccountingBinding.model_validate(
        {key: value for key, value in observed().items() if key in AccountingBinding.model_fields}
    )


def seal(calls: list[object] | None = None) -> dict[str, object]:
    values = calls or []
    text = json.dumps(values, ensure_ascii=False, sort_keys=True)
    return {
        **binding().model_dump(),
        "serialization": "postgres-jsonb-text-v1",
        "calls_text": text,
        "calls_sha256": sha256_hex(text),
        "summary": derive_accounting(values).model_dump(),
        "requested_receipt": {"id": "1", "entry_hash": "1" * 64},
        "agent_started_receipt": {"id": "2", "entry_hash": "2" * 64},
        "agent_completed_receipt": {"id": "5", "entry_hash": "5" * 64},
        "accounting_receipt": {"id": "6", "entry_hash": "6" * 64},
    }


class Rpc:
    def __init__(self, reply: object = None, *, fails: bool = False) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.reply = reply
        self.fails = fails

    async def call(self, name: str, args: dict[str, object]) -> object:
        self.calls.append((name, args))
        if self.fails:
            raise RuntimeError("sensitive synthetic canary")
        return self.reply


def test_pure_seal_refuses_arithmetic_only() -> None:
    with pytest.raises(AccountingStoreError, match="seal refused"):
        verify_accounting_seal(derive_accounting([]).model_dump(), binding())


def test_retained_exact_packet_summary_and_binding() -> None:
    assert verify_accounting_seal(seal([observed()]), binding()).summary.call_count == 1
    assert verify_accounting_seal(seal(), binding()).summary.basis == "no_model"


@pytest.mark.parametrize(
    "patch",
    [
        {"run_id": uid(99)},
        {"calls_text": "[] "},
        {"summary": derive_accounting([]).model_dump()},
        {"accounting_receipt": {"id": "2", "entry_hash": "6" * 64}},
    ],
)
def test_tampered_retained_packet_refused(patch: dict[str, object]) -> None:
    with pytest.raises(AccountingStoreError, match="seal refused"):
        verify_accounting_seal({**seal([observed()]), **patch}, binding())


def test_recomputed_foreign_callset_hash_refused() -> None:
    packet = seal([observed()])
    text = json.dumps([{**observed(), "tenant_id": uid(90)}])
    packet.update(calls_text=text, calls_sha256=sha256_hex(text))
    with pytest.raises(AccountingStoreError, match="seal refused"):
        verify_accounting_seal(packet, binding())


def test_duplicate_decoded_names_refused_even_matching_hash() -> None:
    packet = seal()
    text = '[{"tenant_id":"x","tenant_id":"y"}]'
    packet.update(calls_text=text, calls_sha256=sha256_hex(text))
    with pytest.raises(AccountingStoreError, match="seal refused"):
        verify_accounting_seal(packet, binding())


@pytest.mark.asyncio
async def test_load_independently_checks_all_binding_fields() -> None:
    rpc = Rpc(
        {
            **binding().model_dump(),
            "requested_receipt": {"id": "1", "entry_hash": "1" * 64},
            "claimed": True,
        }
    )
    result = await ModelCallStore(rpc).load(binding())
    assert result.run_id == binding().run_id
    assert rpc.calls == [
        ("load_model_accounting_dispatch", {"t": uid(1), "r": uid(2), "rh": "a" * 64})
    ]
    rpc.reply = {**result.model_dump(), "agent": "sanket"}
    with pytest.raises(AccountingStoreError, match="unavailable"):
        await ModelCallStore(rpc).load(binding())


@pytest.mark.asyncio
async def test_lost_begin_response_never_retries_or_reads_permission() -> None:
    start = CallStart.model_validate(
        {k: v for k, v in observed().items() if k in CallStart.model_fields}
    )
    rpc = Rpc(fails=True)
    with pytest.raises(AccountingStoreError, match=r"^Accounting start uncertain$"):
        await ModelCallStore(rpc).begin(binding(), start, canonical_json(start.model_dump()))
    assert len(rpc.calls) == 1
    assert rpc.calls[0][0] == "begin_model_accounting_call"


@pytest.mark.asyncio
async def test_duplicate_start_bytes_refuse_before_any_rpc() -> None:
    start = CallStart.model_validate(
        {k: v for k, v in observed().items() if k in CallStart.model_fields}
    )
    text = canonical_json(start.model_dump()).replace(
        '"schema_version":2', '"schema_version":2,"schema_version":2'
    )
    rpc = Rpc()
    with pytest.raises(AccountingStoreError, match="uncertain"):
        await ModelCallStore(rpc).begin(binding(), start, text)
    assert rpc.calls == []


@pytest.mark.asyncio
async def test_lost_finish_response_exposes_no_sensitive_content_or_retry() -> None:
    outcome = CallOutcome.model_validate(observed())
    rpc = Rpc(fails=True)
    with pytest.raises(AccountingStoreError, match=r"^Accounting observation uncertain$"):
        await ModelCallStore(rpc).finish(binding(), outcome, canonical_json(outcome.model_dump()))
    assert len(rpc.calls) == 1


@pytest.mark.asyncio
async def test_seal_requires_independently_expected_original_agent_receipts() -> None:
    rpc = Rpc(seal())
    start = Receipt(id="2", entry_hash="2" * 64)
    end = Receipt(id="5", entry_hash="5" * 64)
    result = await ModelCallStore(rpc).seal(binding(), start, end)
    assert result.accounting_receipt.id == "6"
    packet = deepcopy(seal())
    packet["agent_completed_receipt"] = {"id": "5", "entry_hash": "a" * 64}
    rpc.reply = packet
    with pytest.raises(AccountingStoreError, match="uncertain"):
        await ModelCallStore(rpc).seal(binding(), start, end)


@pytest.mark.asyncio
async def test_readback_does_not_repeat_seal_or_transport() -> None:
    rpc = Rpc(seal())
    result = await ModelCallStore(rpc).read(binding())
    assert result.summary.call_count == 0
    assert [name for name, _ in rpc.calls] == ["read_model_accounting_run"]


# Controlled gateway/journal doubles. No provider SDK or database is contacted.
class JournalRpc(Rpc):
    def __init__(self, *, fail: str | None = None, replay: bool = False) -> None:
        super().__init__()
        self.fail = fail
        self.replay = replay

    async def call(self, name: str, args: dict[str, object]) -> object:
        self.calls.append((name, args))
        if name == self.fail:
            raise RuntimeError("synthetic sensitive transport exception")
        base = binding().model_dump()
        if name == "load_model_accounting_dispatch":
            return {
                **base,
                "requested_receipt": {"id": "1", "entry_hash": "1" * 64},
                "claimed": True,
            }
        if name == "begin_model_accounting_call":
            parsed = json.loads(str(args["start_text"]))
            return {
                **{k: parsed[k] for k in base},
                "call_id": args["call_id"],
                "claimed": not self.replay,
                "start_sha256": sha256_hex(str(args["start_text"])),
                "started_receipt": {"id": "3", "entry_hash": "3" * 64},
            }
        if name == "finish_model_accounting_call":
            parsed = json.loads(str(args["outcome_text"]))
            return {
                **{k: parsed[k] for k in base},
                "call_id": args["call_id"],
                "outcome_sha256": sha256_hex(str(args["outcome_text"])),
                "completed_receipt": {"id": "4", "entry_hash": "4" * 64},
            }
        raise AssertionError("Unexpected fixture RPC")


class Authority:
    def __init__(self, refuse_on: int | None = None) -> None:
        self.calls = 0
        self.refuse_on = refuse_on

    async def require_current(self, expected: object) -> None:
        self.calls += 1
        if self.calls == self.refuse_on:
            raise ValueError("synthetic session revoked")


class Gateway:
    def __init__(self, *, fails: bool = False, mismatches: bool = False) -> None:
        self.calls: list[str] = []
        self.fails = fails
        self.mismatches = mismatches

    async def complete(self, request_text: str, start: CallStart) -> object:
        from axiom.model_call_accounting import CallCompletion

        self.calls.append(request_text)
        if self.fails:
            raise RuntimeError("synthetic sensitive provider exception")
        text = "controlled successful output"
        result = {**observed(), **start.model_dump(), "content_sha256": sha256_hex(text)}
        if self.mismatches:
            result["request_json_sha256"] = "f" * 64
        return CallCompletion(text=text, observation=CallOutcome.model_validate(result))


def payload() -> object:
    from axiom.model_call_accounting import CallPayload

    return CallPayload(
        model="fast",
        prompt="synthetic private payload",
        task="reasoning",
        temperature=0.2,
        max_tokens=100,
        variables={},
        pii_redact=True,
        response_format=None,
    )


class Target:
    def __init__(self, *, model: bool = True) -> None:
        self.model = model
        self.complete: object = None

    async def run(self, complete: object) -> object:
        self.complete = complete
        if self.model:
            return await complete(payload())
        return "pure deterministic output"


@pytest.mark.asyncio
async def test_pure_no_model_target_only_returns_provisional_not_verified() -> None:
    from axiom.model_call_store import AccountedComposer

    rpc, gateway = JournalRpc(), Gateway()
    result = await AccountedComposer(ModelCallStore(rpc), gateway, Authority()).compute(
        binding(), Target(model=False)
    )
    assert result.observations == ()
    assert result.accounting_proven is False
    assert gateway.calls == []
    assert [n for n, _ in rpc.calls] == ["load_model_accounting_dispatch"]


@pytest.mark.asyncio
@pytest.mark.parametrize("fail", ["begin_model_accounting_call", None])
async def test_lost_or_replayed_claim_never_calls_gateway(fail: str | None) -> None:
    from axiom.model_call_store import AccountedComposer

    rpc, gateway = JournalRpc(fail=fail, replay=fail is None), Gateway()
    result = await AccountedComposer(ModelCallStore(rpc), gateway, Authority()).compute(
        binding(), Target()
    )
    assert result.failure_code == "accounting_uncertain"
    assert result.output is None
    assert gateway.calls == []
    assert [n for n, _ in rpc.calls].count("begin_model_accounting_call") == 1
    assert not any(n == "finish_model_accounting_call" for n, _ in rpc.calls)


@pytest.mark.asyncio
async def test_start_precedes_gateway_and_finish_has_no_raw_payload() -> None:
    from axiom.model_call_store import AccountedComposer

    rpc, gateway = JournalRpc(), Gateway()
    result = await AccountedComposer(ModelCallStore(rpc), gateway, Authority()).compute(
        binding(), Target()
    )
    assert result.failure_code is None
    assert len(gateway.calls) == 1
    assert len(result.observations) == 1
    assert [n for n, _ in rpc.calls] == [
        "load_model_accounting_dispatch",
        "begin_model_accounting_call",
        "finish_model_accounting_call",
    ]
    assert "synthetic private payload" not in json.dumps(rpc.calls)


@pytest.mark.asyncio
async def test_finish_response_loss_no_alternative_failure_write_or_retry() -> None:
    from axiom.model_call_store import AccountedComposer

    rpc, gateway = JournalRpc(fail="finish_model_accounting_call"), Gateway()
    result = await AccountedComposer(ModelCallStore(rpc), gateway, Authority()).compute(
        binding(), Target()
    )
    assert result.failure_code == "accounting_uncertain"
    assert result.output is None
    assert len(gateway.calls) == 1
    assert [n for n, _ in rpc.calls].count("finish_model_accounting_call") == 1
    assert result.observations == ()


@pytest.mark.asyncio
@pytest.mark.parametrize("mismatches", [False, True])
async def test_provider_failure_or_wrong_commitment_records_unknown(mismatches: bool) -> None:
    from axiom.model_call_store import AccountedComposer

    rpc, gateway = JournalRpc(), Gateway(fails=not mismatches, mismatches=mismatches)
    result = await AccountedComposer(ModelCallStore(rpc), gateway, Authority()).compute(
        binding(), Target()
    )
    assert result.failure_code == "target_failed"
    assert result.observations[0].usage.total_tokens is None
    assert result.observations[0].failure_code == (
        "gateway_response_invalid" if mismatches else "gateway_unavailable"
    )
    assert [n for n, _ in rpc.calls].count("finish_model_accounting_call") == 1


@pytest.mark.asyncio
async def test_current_authority_recheck_after_claim_refuses_gateway() -> None:
    from axiom.model_call_store import AccountedComposer

    rpc, gateway = JournalRpc(), Gateway()
    result = await AccountedComposer(ModelCallStore(rpc), gateway, Authority(refuse_on=4)).compute(
        binding(), Target()
    )
    assert gateway.calls == []
    assert result.observations[0].failure_code == "current_authority_refused"
    assert result.failure_code == "target_failed"


@pytest.mark.asyncio
async def test_invalid_explicit_tenant_refuses_before_authority_or_rpc() -> None:
    from axiom.model_call_store import AccountedComposer

    rpc, gateway, authority = JournalRpc(), Gateway(), Authority()
    malformed = binding().model_copy(update={"tenant_id": "00000000-0000-0000-0000-000000000000"})
    with pytest.raises(ValueError, match="identity refused"):
        await AccountedComposer(ModelCallStore(rpc), gateway, authority).compute(
            malformed, Target()
        )
    assert authority.calls == 0
    assert rpc.calls == []
    assert gateway.calls == []


@pytest.mark.asyncio
async def test_escaped_capability_closes_before_any_further_write_or_transport() -> None:
    from axiom.model_call_store import AccountedComposer

    rpc, gateway, target = JournalRpc(), Gateway(), Target(model=False)
    await AccountedComposer(ModelCallStore(rpc), gateway, Authority()).compute(binding(), target)
    with pytest.raises(AccountingStoreError, match="scope closed"):
        await target.complete(payload())
    assert gateway.calls == []
    assert [n for n, _ in rpc.calls] == ["load_model_accounting_dispatch"]


@pytest.mark.asyncio
async def test_unawaited_active_child_is_cancelled_recorded_and_cannot_escape() -> None:
    import asyncio

    from axiom.model_call_store import AccountedComposer

    entered = asyncio.Event()

    class WaitingGateway(Gateway):
        async def complete(self, request_text: str, start: CallStart) -> object:
            self.calls.append(request_text)
            entered.set()
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

    child: asyncio.Task[object] | None = None

    class SpawningTarget:
        async def run(self, complete: object) -> object:
            nonlocal child
            child = asyncio.create_task(complete(payload()))
            await entered.wait()
            return "target finished before child"

    rpc, gateway = JournalRpc(), WaitingGateway()
    result = await AccountedComposer(ModelCallStore(rpc), gateway, Authority()).compute(
        binding(), SpawningTarget()
    )
    assert child is not None
    assert child.done()
    assert child.cancelled()
    assert result.observations[0].state == "cancelled"
    assert result.observations[0].usage.total_tokens is None
    assert result.accounting_proven is False


@pytest.mark.asyncio
async def test_two_simultaneous_invocations_reverse_completion_keep_tenant_and_calls_isolated() -> (
    None
):
    import asyncio

    from axiom.model_call_accounting import CallCompletion
    from axiom.model_call_store import AccountedComposer

    other = binding().model_copy(
        update={"tenant_id": uid(90), "run_id": uid(91), "correlation_id": uid(92)}
    )
    bindings = {binding().run_id: binding(), other.run_id: other}
    entered, released = asyncio.Event(), asyncio.Event()

    class TwoRpc(JournalRpc):
        async def call(self, name: str, args: dict[str, object]) -> object:
            if name == "load_model_accounting_dispatch":
                self.calls.append((name, args))
                original = bindings[str(args["r"])]
                return {
                    **original.model_dump(),
                    "requested_receipt": {"id": "1", "entry_hash": "1" * 64},
                    "claimed": True,
                }
            return await super().call(name, args)

    class ReverseGateway(Gateway):
        async def complete(self, request_text: str, start: CallStart) -> object:
            self.calls.append(request_text)
            if start.tenant_id == binding().tenant_id:
                entered.set()
                await released.wait()
                raise RuntimeError("synthetic tenant-one provider failure")
            await entered.wait()
            text = "tenant-two successful output"
            result = {**observed(), **start.model_dump(), "content_sha256": sha256_hex(text)}
            released.set()
            return CallCompletion(text=text, observation=CallOutcome.model_validate(result))

    rpc, gateway = TwoRpc(), ReverseGateway()
    composer = AccountedComposer(ModelCallStore(rpc), gateway, Authority())
    one, two = await asyncio.gather(
        composer.compute(binding(), Target()), composer.compute(other, Target())
    )
    assert one.failure_code == "target_failed"
    assert one.observations[0].tenant_id == binding().tenant_id
    assert one.observations[0].correlation_id == binding().correlation_id
    assert one.observations[0].state == "failed"
    assert two.failure_code is None
    assert two.observations[0].tenant_id == other.tenant_id
    assert two.observations[0].correlation_id == other.correlation_id
    assert two.observations[0].state == "completed"
    assert one.observations[0].call_id != two.observations[0].call_id
    for name, args in rpc.calls:
        if name == "finish_model_accounting_call":
            result = json.loads(str(args["outcome_text"]))
            assert result["tenant_id"] == args["t"]
            assert result["run_id"] == args["r"]


@pytest.mark.asyncio
async def test_revocation_during_final_completion_refuses_output_but_retains_observed_fact() -> (
    None
):
    from axiom.model_call_store import AccountedComposer

    rpc, gateway = JournalRpc(), Gateway()
    result = await AccountedComposer(ModelCallStore(rpc), gateway, Authority(refuse_on=5)).compute(
        binding(), Target()
    )
    assert result.failure_code == "current_authority_refused"
    assert result.output is None
    assert result.observations[0].state == "completed"
    assert [n for n, _ in rpc.calls].count("finish_model_accounting_call") == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("lost", [False, True])
async def test_replayed_or_lost_journal_open_never_recomputes_target(lost: bool) -> None:
    from axiom.model_call_store import AccountedComposer

    class OnceRpc(JournalRpc):
        async def call(self, name: str, args: dict[str, object]) -> object:
            if name == "load_model_accounting_dispatch":
                self.calls.append((name, args))
                if lost:
                    raise RuntimeError("synthetic sensitive claim acknowledgement loss")
                return {
                    **binding().model_dump(),
                    "requested_receipt": {"id": "1", "entry_hash": "1" * 64},
                    "claimed": False,
                }
            raise AssertionError("Replayed or uncertain owner must never start new work")

    rpc, gateway, target = OnceRpc(), Gateway(), Target()
    with pytest.raises(AccountingStoreError, match=r"^Accounting load unavailable$"):
        await AccountedComposer(ModelCallStore(rpc), gateway, Authority()).compute(
            binding(), target
        )
    assert target.complete is None
    assert gateway.calls == []
    assert [name for name, _ in rpc.calls] == ["load_model_accounting_dispatch"]
