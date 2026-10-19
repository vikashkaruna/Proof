"""Tests for the Python Approval Engine — must mirror the TypeScript tests."""

import pytest

from axiom.approval_engine import ApprovalEngine


@pytest.fixture
def engine():
    return ApprovalEngine(signing_key="test-signing-key-must-be-long-enough-for-hmac")


@pytest.mark.asyncio
async def test_issue_and_verify(engine):
    token = await engine.issue(
        tenant_id="t1",
        plan_id="p1",
        action_ids=["a1", "a2"],
        approver_id="u1",
        mode="batch",
        concurrency=1,
        stop_on_failure=True,
        expires_at="2099-01-01T00:00:00Z",
    )
    result = await engine.verify(
        "t1",
        {"spec": token.spec.to_canonical(), "signature": token.signature},
    )
    assert result.valid is True


@pytest.mark.asyncio
async def test_signature_mismatch_detected(engine):
    token = await engine.issue(
        tenant_id="t1",
        plan_id="p1",
        action_ids=["a1"],
        approver_id="u1",
        mode="batch",
        concurrency=1,
        stop_on_failure=True,
        expires_at="2099-01-01T00:00:00Z",
    )
    bad = {"spec": token.spec.to_canonical(), "signature": "a" * 64}
    result = await engine.verify("t1", bad)
    assert result.valid is False
    assert result.reason == "signature_mismatch"


@pytest.mark.asyncio
async def test_expiry_check(engine):
    token = await engine.issue(
        tenant_id="t1",
        plan_id="p1",
        action_ids=["a1"],
        approver_id="u1",
        mode="batch",
        concurrency=1,
        stop_on_failure=True,
        expires_at="2000-01-01T00:00:00Z",
    )
    result = await engine.verify(
        "t1",
        {"spec": token.spec.to_canonical(), "signature": token.signature},
    )
    assert result.valid is False
    assert result.reason == "expired"


@pytest.mark.asyncio
async def test_per_tenant_secrets():
    e1 = ApprovalEngine()
    e1.set_tenant_key("t1", "tenant-1-secret-32-bytes-12345")
    e1.set_tenant_key("t2", "tenant-2-secret-32-bytes-67890")

    t1 = await e1.issue(
        "t1",
        plan_id="p",
        action_ids=["a"],
        approver_id="u",
        mode="batch",
        concurrency=1,
        stop_on_failure=True,
        expires_at="2099-01-01T00:00:00Z",
    )
    # Cross-tenant verification should fail
    result = await e1.verify("t2", {"spec": t1.spec.to_canonical(), "signature": t1.signature})
    assert result.valid is False
    assert result.reason == "signature_mismatch"


@pytest.mark.asyncio
async def test_canonical_action_ids(engine):
    """Per the TS test: spec is canonicalised so verifier order doesn't matter."""
    token = await engine.issue(
        tenant_id="t1",
        plan_id="p1",
        action_ids=["a2", "a1", "a3"],
        approver_id="u1",
        mode="batch",
        concurrency=1,
        stop_on_failure=True,
        expires_at="2099-01-01T00:00:00Z",
    )
    # Verify the spec was already sorted at construction
    assert token.spec.action_ids == ["a1", "a2", "a3"]
    # Verify that the canonical form equals the sorted form
    spec = token.spec.to_canonical()
    assert spec["actionIds"] == ["a1", "a2", "a3"]
    # Verify still works
    result = await engine.verify("t1", {"spec": spec, "signature": token.signature})
    assert result.valid is True


@pytest.mark.asyncio
@pytest.mark.parametrize("purpose", ["owned_synthetic_enrollment_v1", "unknown", None, 123])
async def test_signed_foreign_purpose_cannot_authorize_same_action(engine, purpose):
    from dataclasses import replace

    token = await engine.issue("t1", "p1", ["a1"], "u1", "batch", 1, True, "2099-01-01T00:00:00Z")
    spec = replace(token.spec, conditions={"purpose": purpose})
    signature = await engine.sign("t1", spec)
    result = await engine.verify("t1", {"spec": spec.to_canonical(), "signature": signature})
    assert not result.valid
    assert result.reason == "purpose_mismatch"
