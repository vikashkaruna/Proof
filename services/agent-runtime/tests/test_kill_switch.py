"""SEC-4 / R-09 / FR-8.6 — the stop is checked inside the execution path.

Migration 0009 put the kill switch in shared state so every BFF replica reads
the same row. Nothing in the Python runtime ever read it, so the switch only
governed request *admission*. A batch already dispatched ran to completion no
matter how many times an operator engaged the stop, which is not what
"immediately effective" means.

These tests pin the two properties that matter: the runtime reads the shared
state, and a state it cannot read is treated as engaged.
"""

from __future__ import annotations

import pytest

from axiom.agents.karya import KaryaAgent, KaryaInput
from axiom.kill_switch import (
    CACHE_TTL_SECONDS,
    KillSwitchEngaged,
    KillSwitchReader,
)

TENANT = "11111111-1111-4111-8111-111111111111"
OTHER_TENANT = "22222222-2222-4222-8222-222222222222"


class FakeTable:
    """Stands in for the Supabase table builder."""

    def __init__(self, rows: list[dict], fail: bool) -> None:
        self._rows = rows
        self._fail = fail

    def select(self, *_a, **_k) -> FakeTable:
        return self

    def eq(self, *_a, **_k) -> FakeTable:
        return self

    def execute(self):
        if self._fail:
            raise RuntimeError("connection lost")

        rows = self._rows

        class Result:
            data = rows

        return Result()


class FakeClient:
    def __init__(self) -> None:
        self.rows: list[dict] = []
        self.fail = False
        self.reads = 0

    def table(self, _name: str) -> FakeTable:
        self.reads += 1
        return FakeTable(self.rows, self.fail)


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


# ─── reading the shared state ────────────────────────────────────────


def test_clear_state_permits_execution() -> None:
    reader = KillSwitchReader(FakeClient())
    assert reader.is_engaged(TENANT) is False
    reader.raise_if_engaged(TENANT)  # must not raise


def test_global_halt_stops_every_tenant() -> None:
    client = FakeClient()
    client.rows = [{"scope": "global", "tenant_id": None, "engaged": True, "reason": "incident"}]
    reader = KillSwitchReader(client)
    assert reader.is_engaged(TENANT) is True
    assert reader.is_engaged(OTHER_TENANT) is True
    with pytest.raises(KillSwitchEngaged) as caught:
        reader.raise_if_engaged(TENANT)
    assert caught.value.scope == "global"
    assert "incident" in caught.value.reason


def test_tenant_halt_is_scoped_to_that_tenant() -> None:
    client = FakeClient()
    client.rows = [{"scope": "tenant", "tenant_id": TENANT, "engaged": True, "reason": "drift"}]
    reader = KillSwitchReader(client)
    assert reader.is_engaged(TENANT) is True
    # One client's halt must not stop work for every other client.
    assert reader.is_engaged(OTHER_TENANT) is False


def test_unreadable_state_is_treated_as_engaged() -> None:
    """Fail safe, the opposite of how authentication fails here.

    A stop we cannot verify is clear has to be assumed engaged, or the switch
    stops working during exactly the incident it exists for.
    """
    client = FakeClient()
    client.fail = True
    reader = KillSwitchReader(client)
    assert reader.is_engaged(TENANT) is True
    with pytest.raises(KillSwitchEngaged):
        reader.raise_if_engaged(TENANT)


def test_a_recovered_read_clears_the_halt() -> None:
    client = FakeClient()
    client.fail = True
    clock = Clock()
    reader = KillSwitchReader(client, clock=clock)
    assert reader.is_engaged(TENANT) is True

    client.fail = False
    clock.now += CACHE_TTL_SECONDS + 1
    assert reader.is_engaged(TENANT) is False


def test_reads_are_cached_within_the_propagation_bound() -> None:
    client = FakeClient()
    clock = Clock()
    reader = KillSwitchReader(client, clock=clock)
    for _ in range(5):
        reader.is_engaged(TENANT)
    assert client.reads == 1, "the execute path must not pay a round trip per check"

    clock.now += CACHE_TTL_SECONDS + 0.1
    reader.is_engaged(TENANT)
    assert client.reads == 2, "the cache must expire within the propagation bound"


def test_propagation_bound_is_short() -> None:
    # This is the emergency stop; the TTL is how long a replica may keep
    # acting after an operator engages it.
    assert CACHE_TTL_SECONDS <= 5


# ─── the executor honours it ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_karya_refuses_to_start_when_halted() -> None:
    reader = KillSwitchReader(in_memory=True)
    reader.engage_in_memory(reason="operator halted execution")

    agent = KaryaAgent()
    result = await agent._run(
        correlation_id="c1",
        input=KaryaInput(tenant_id=TENANT, plan_id="p", action_id="a", approval_token={"spec": {}}),
        kill_switch=reader,
    )

    assert result.status == "denied"
    assert "kill_switch_engaged" in (result.error or "")


@pytest.mark.asyncio
async def test_karya_halt_mutates_nothing_and_stays_retryable() -> None:
    reader = KillSwitchReader(in_memory=True)
    reader.engage_in_memory(scope="tenant", tenant_id=TENANT, reason="tenant halt")

    agent = KaryaAgent()
    result = await agent._run(
        correlation_id="c1",
        input=KaryaInput(tenant_id=TENANT, plan_id="p", action_id="a", approval_token={"spec": {}}),
        kill_switch=reader,
    )

    # A halt is a refusal to act, not a failed action: nothing was mutated, so
    # there is no pre/post state and nothing to roll back.
    assert result.status == "denied"
    assert result.pre_state_uri is None
    assert result.post_state_uri is None


@pytest.mark.asyncio
async def test_karya_halts_for_an_unreadable_switch() -> None:
    client = FakeClient()
    client.fail = True
    agent = KaryaAgent()
    result = await agent._run(
        correlation_id="c1",
        input=KaryaInput(tenant_id=TENANT, plan_id="p", action_id="a", approval_token={"spec": {}}),
        kill_switch=KillSwitchReader(client),
    )
    assert result.status == "denied"
    assert "kill_switch_engaged" in (result.error or "")


@pytest.mark.asyncio
async def test_karya_checks_the_switch_before_the_token() -> None:
    """Order matters: a halt outranks every other refusal.

    With no approval token AND the switch engaged, the answer must be the
    halt — otherwise an operator watching an incident sees "approval required"
    and concludes the stop did not take effect.
    """
    reader = KillSwitchReader(in_memory=True)
    reader.engage_in_memory(reason="halted")

    agent = KaryaAgent()
    result = await agent._run(
        correlation_id="c1",
        input=KaryaInput(tenant_id=TENANT, plan_id="p", action_id="a", approval_token=None),
        kill_switch=reader,
    )
    assert "kill_switch_engaged" in (result.error or "")
