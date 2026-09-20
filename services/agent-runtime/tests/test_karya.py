"""Tests for the Karya execution agent — the gate."""

import pytest

from axiom.agents.karya import KaryaAgent, KaryaInput


@pytest.mark.asyncio
async def test_karya_refuses_without_approval_token(monkeypatch):
    from axiom.kill_switch import KillSwitchReader
    monkeypatch.setattr(KillSwitchReader, "from_settings", lambda *args: KillSwitchReader(in_memory=True))
    agent = KaryaAgent()
    # Pass a properly-shaped but invalid token (empty spec/signature)
    out = await agent.invoke(
        KaryaInput(
            tenant_id="t1",
            plan_id="p1",
            action_id="a1",
            approval_token={"spec": {}, "signature": ""},  # malformed
        )
    )
    # Per BR-1, unapproved execution is architecturally impossible.
    # The agent must refuse. Either the agent call itself succeeds and
    # returns a denied status, or the agent call itself fails — both
    # are valid refusals.
    output = out.output or {}
    if out.status == "succeeded":
        assert output.get("status") in {"denied", "skipped"}
        if output.get("status") == "denied":
            err = output.get("error", "")
            assert "Token invalid" in err or "malformed" in err.lower()
    else:
        # The agent itself failed — the call to engine.verify raised.
        # That is also a refusal (no execution happened).
        assert out.error is not None
