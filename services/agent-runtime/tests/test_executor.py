"""W5 · M3.4 — the durable executor.

The structural guarantees live in the migration-0061 functions; these
tests script those functions' responses and assert what the executor
itself must do: re-validate the token before anything runs, check the
kill switch twice, honour stop-on-failure, halt on a blast-radius
breach, replay a redelivery without executing, and surface every RPC
refusal instead of guessing past it.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from axiom.executor import ExecutorDb, ExecutorRefused, execute_batch
from axiom.kill_switch import KillSwitchEngaged
from axiom.write_adapters import ReferenceWriteAdapter, WriteRefused


class FakeDb:
    def __init__(self) -> None:
        self.rpc_calls: list[tuple[str, dict[str, Any]]] = []
        self.rpc_script: dict[str, Any] = {}
        self.rows: dict[str, dict[str, Any]] = {}

    def script(self, fn: str, response: dict[str, Any]) -> None:
        self.rpc_script[fn] = response

    def rpc(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        self.rpc_calls.append((name, args))
        scripted = self.rpc_script.get(name)
        if scripted is not None and len(self.rpc_script[name]) > 0:
            if isinstance(scripted, list):
                return scripted.pop(0)
            return scripted
        if name == "finish_execution_batch":
            # Echo the requested status: the database's terminal status is
            # what the executor reports.
            return {
                "batch": {"id": "b-1", "status": args.get("p_status", "completed")},
                "replay": False,
            }
        defaults = {
            "start_execution_batch": {"batch": {"id": "b-1", "status": "dispatched"}, "replay": False},
            "mark_execution_action_started": {"ok": True},
            "settle_execution_action": {"ok": True},
        }
        return defaults.get(name, {"ok": True})

    def action_row(self, tenant_id: str, action_id: str) -> dict[str, Any] | None:
        return self.rows.get(action_id)


class FakeKillSwitch:
    def __init__(self, engage_after: int | None = None) -> None:
        self.checks = 0
        self.engage_after = engage_after  # None = never engages

    def raise_if_engaged(self, tenant_id: str | None = None) -> None:
        self.checks += 1
        if self.engage_after is not None and self.checks > self.engage_after:
            raise KillSwitchEngaged("tenant", "operator stop")


class FakeAdapter:
    def __init__(self, results: dict[str, Any] | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.results = results or {}

    async def execute(self, action_type: str, parameters: dict[str, Any]) -> Any:
        self.calls.append((action_type, parameters))
        result = self.results.get(action_type, {"rows_affected": 1})
        if isinstance(result, Exception):
            raise result
        return SimpleNamespace(
            rows_affected=result.get("rows_affected", 1),
            pre_state_ref=result.get("pre_state_ref"),
            post_state_ref=result.get("post_state_ref"),
        )


def make_payload(**overrides: Any) -> SimpleNamespace:
    base = {
        "contract_version": 2,
        "tenant_id": "t-1",
        "plan_id": "p-1",
        "correlation_id": "c-1",
        "action_ids": ["a-1", "a-2"],
        "request_key": "req-1",
        "mode": "batch",
        "concurrency": 2,
        "stop_on_failure": True,
        "approval_token": {"signature": "s", "spec": {"nonce": "n-1", "actionIds": ["a-1", "a-2"]}},
        "content_digest": "d" * 64,
    }
    base.update(overrides)
    return SimpleNamespace(**base)


async def verify_token_ok(tenant_id: str, token: dict[str, Any]) -> tuple[bool, str | None]:
    return True, None


def settled(db: FakeDb, action_id: str) -> dict[str, Any] | None:
    for fn, args in db.rpc_calls:
        if fn == "settle_execution_action" and args["p_action_id"] == action_id:
            return args
    return None


@pytest.mark.asyncio
async def test_happy_path_executes_and_settles_every_action() -> None:
    db = FakeDb()
    db.rows["a-1"] = {"id": "a-1", "action_type": "data.mask", "parameters": {"system": "crm"}, "blast_radius": {}}
    db.rows["a-2"] = {"id": "a-2", "action_type": "policy.publish", "parameters": {"document": "d"}, "blast_radius": {}}
    adapter = FakeAdapter()
    result = await execute_batch(
        make_payload(), db=db, kill_switch=FakeKillSwitch(), adapter=adapter, verify_token=verify_token_ok
    )
    assert result.replay is False
    assert result.status == "completed"
    assert sorted((o.action_id, o.outcome) for o in result.outcomes) == [("a-1", "succeeded"), ("a-2", "succeeded")]
    started = [args for fn, args in db.rpc_calls if fn == "mark_execution_action_started"]
    assert len(started) == 2
    finish = next(args for fn, args in db.rpc_calls if fn == "finish_execution_batch")
    assert finish["p_status"] == "completed"


@pytest.mark.asyncio
async def test_replay_does_not_execute() -> None:
    db = FakeDb()
    db.script("start_execution_batch", {"batch": {"id": "b-1", "status": "completed"}, "replay": True})
    adapter = FakeAdapter()
    result = await execute_batch(
        make_payload(), db=db, kill_switch=FakeKillSwitch(), adapter=adapter, verify_token=verify_token_ok
    )
    assert result.replay is True
    assert adapter.calls == []
    assert len(db.rpc_calls) == 1  # only the start call


@pytest.mark.asyncio
async def test_stop_on_failure_skips_the_remainder() -> None:
    db = FakeDb()
    db.rows["a-1"] = {"id": "a-1", "action_type": "data.mask", "parameters": {}, "blast_radius": {}}
    adapter = FakeAdapter(results={"data.mask": WriteRefused("write_refused_by_target")})
    result = await execute_batch(
        make_payload(), db=db, kill_switch=FakeKillSwitch(), adapter=adapter, verify_token=verify_token_ok
    )
    # Nothing succeeded, so the batch failed; the remainder was swept, not run.
    assert result.status == "failed"
    outcomes = {o.action_id: o.outcome for o in result.outcomes}
    assert outcomes["a-1"] == "failed"
    assert outcomes["a-2"] == "skipped"
    assert adapter.calls == [("data.mask", {})]
    assert settled(db, "a-1")["p_error_code"] == "write_refused_by_target"


@pytest.mark.asyncio
async def test_kill_switch_halts_mid_batch() -> None:
    db = FakeDb()
    db.rows["a-1"] = {"id": "a-1", "action_type": "data.mask", "parameters": {}, "blast_radius": {}}
    adapter = FakeAdapter()
    result = await execute_batch(
        make_payload(concurrency=1),
        db=db,
        kill_switch=FakeKillSwitch(engage_after=1),  # clear at start, engaged at a-1's boundary
        adapter=adapter,
        verify_token=verify_token_ok,
    )
    assert result.status == "halted"
    assert adapter.calls == []
    outcomes = {o.action_id: o.outcome for o in result.outcomes}
    assert set(outcomes.values()) == {"skipped"}


@pytest.mark.asyncio
async def test_blast_radius_breach_halts_the_batch() -> None:
    db = FakeDb()
    db.rows["a-1"] = {"id": "a-1", "action_type": "data.delete", "parameters": {}, "blast_radius": {"records": 10}}
    adapter = FakeAdapter(results={"data.delete": {"rows_affected": 11}})
    result = await execute_batch(
        make_payload(), db=db, kill_switch=FakeKillSwitch(), adapter=adapter, verify_token=verify_token_ok
    )
    assert result.status == "halted"
    settle = settled(db, "a-1")
    assert settle["p_error_code"] == "blast_radius_breach"
    assert settle["p_detail"] == {"rows_affected": 11, "declared_records": 10}
    outcomes = {o.action_id: o.outcome for o in result.outcomes}
    assert outcomes["a-2"] == "skipped"


@pytest.mark.asyncio
async def test_undeclared_blast_radius_cannot_breach() -> None:
    db = FakeDb()
    db.rows["a-1"] = {"id": "a-1", "action_type": "data.delete", "parameters": {}, "blast_radius": {}}
    db.rows["a-2"] = {"id": "a-2", "action_type": "data.delete", "parameters": {}, "blast_radius": {}}
    adapter = FakeAdapter(results={"data.delete": {"rows_affected": 10**9}})
    result = await execute_batch(
        make_payload(), db=db, kill_switch=FakeKillSwitch(), adapter=adapter, verify_token=verify_token_ok
    )
    assert result.status == "completed"


@pytest.mark.asyncio
async def test_start_refusals_surface_as_executor_refusals() -> None:
    for code in ("scope_exceeded", "digest_mismatch", "token_not_found", "request_key_conflict"):
        db = FakeDb()
        db.script("start_execution_batch", {"error": code})
        with pytest.raises(ExecutorRefused) as excinfo:
            await execute_batch(
                make_payload(), db=db, kill_switch=FakeKillSwitch(), adapter=FakeAdapter(),
                verify_token=verify_token_ok,
            )
        assert excinfo.value.reason == code


@pytest.mark.asyncio
async def test_invalid_token_refuses_before_the_database_is_touched() -> None:
    db = FakeDb()
    calls = []

    async def verify_token(tenant_id: str, token: dict[str, Any]) -> tuple[bool, str | None]:
        calls.append(1)
        return False, "signature_mismatch"

    with pytest.raises(ExecutorRefused) as excinfo:
        await execute_batch(
            make_payload(), db=db, kill_switch=FakeKillSwitch(), adapter=FakeAdapter(),
            verify_token=verify_token,
        )
    assert "signature_mismatch" in excinfo.value.reason
    assert calls
    assert db.rpc_calls == []


@pytest.mark.asyncio
async def test_engaged_kill_switch_refuses_the_whole_batch() -> None:
    class Engaged:
        def raise_if_engaged(self, tenant_id: str | None = None) -> None:
            raise KillSwitchEngaged("tenant", "operator stop")

    db = FakeDb()
    with pytest.raises(ExecutorRefused) as excinfo:
        await execute_batch(
            make_payload(), db=db, kill_switch=Engaged(), adapter=FakeAdapter(),
            verify_token=verify_token_ok,
        )
    assert excinfo.value.reason.startswith("kill_switch_engaged")
    assert db.rpc_calls == []


@pytest.mark.asyncio
async def test_spec_membership_is_defence_in_depth() -> None:
    db = FakeDb()
    db.rows["a-1"] = {"id": "a-1", "action_type": "data.mask", "parameters": {}, "blast_radius": {}}
    payload = make_payload(
        action_ids=["a-1"],
        approval_token={"signature": "s", "spec": {"nonce": "n-1", "actionIds": ["other"]}},
    )
    result = await execute_batch(
        payload, db=db, kill_switch=FakeKillSwitch(), adapter=FakeAdapter(), verify_token=verify_token_ok
    )
    assert settled(db, "a-1")["p_error_code"] == "scope_exceeded"
    assert result.status == "halted"


# ── the reference write adapter ────────────────────────────────────────


def test_reference_adapter_requires_http_origin() -> None:
    with pytest.raises(ValueError, match="http"):
        ReferenceWriteAdapter("ftp://example.com", "t")


@pytest.mark.asyncio
async def test_reference_adapter_refuses_an_error_target() -> None:
    class FakeResponse:
        status_code = 403
        def json(self) -> dict:
            return {}

    class FakeClient:
        def __init__(self, *a: Any, **k: Any) -> None:
            pass
        async def __aenter__(self) -> FakeClient:
            return self
        async def __aexit__(self, *a: Any) -> None:
            return None
        async def post(self, *a: Any, **k: Any) -> FakeResponse:
            return FakeResponse()

    import axiom.write_adapters as wa

    original = wa.httpx.AsyncClient
    wa.httpx.AsyncClient = FakeClient  # type: ignore[misc]
    try:
        adapter = ReferenceWriteAdapter("https://reference-mock.internal", "t")
        with pytest.raises(WriteRefused) as excinfo:
            await adapter.execute("data.mask", {})
        assert excinfo.value.reason == "write_refused_by_target"
    finally:
        wa.httpx.AsyncClient = original


# ── the fail-closed db wrapper ─────────────────────────────────────────


def test_db_wrapper_refuses_on_transport_failure() -> None:
    class BrokenClient:
        def rpc(self, name: str, args: dict[str, Any]) -> Any:
            raise RuntimeError("connection refused")

    with pytest.raises(ExecutorRefused) as excinfo:
        ExecutorDb(BrokenClient()).rpc("start_execution_batch", {})
    assert excinfo.value.reason == "record_unavailable"


def test_db_wrapper_refuses_on_non_dict_payload() -> None:
    class OddClient:
        def rpc(self, name: str, args: dict[str, Any]) -> Any:
            return SimpleNamespace(execute=lambda: SimpleNamespace(data=["not-a-dict"]))

    with pytest.raises(ExecutorRefused):
        ExecutorDb(OddClient()).rpc("start_execution_batch", {})
