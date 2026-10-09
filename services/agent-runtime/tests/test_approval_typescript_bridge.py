"""Actual TypeScript signer vectors, not approvals for an operational plan.

Regenerate with packages/approval-engine/src/index.ts ApprovalEngine.sign;
all keys, identities and payloads here are synthetic public test data.
"""

import copy
import json
from pathlib import Path

import pytest

from axiom.approval_engine import ApprovalEngine, ApprovalTokenSpec

VECTORS = json.loads(
    (Path(__file__).parent / "fixtures" / "approval_typescript_vectors.json").read_text()
)


@pytest.mark.parametrize("vector", VECTORS["vectors"], ids=lambda v: v["name"])
async def test_actual_typescript_signature_verifies_and_roundtrips(vector):
    engine = ApprovalEngine(VECTORS["secret"])
    token = vector["token"]
    assert (await engine.verify(VECTORS["tenant"], token)).valid
    raw = token["spec"]
    spec = ApprovalTokenSpec(
        plan_id=raw["planId"],
        action_ids=raw["actionIds"],
        approver_id=raw["approverId"],
        mode=raw["mode"],
        concurrency=raw["concurrency"],
        stop_on_failure=raw["stopOnFailure"],
        expires_at=raw["expiresAt"],
        nonce=raw["nonce"],
        conditions=raw.get("conditions"),
        content_digest=raw.get("contentDigest"),
    )
    assert await engine.sign(VECTORS["tenant"], spec) == token["signature"]
    assert spec.to_canonical() == {**raw, "actionIds": sorted(raw["actionIds"])}


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("contentDigest", "c" * 64),
        ("conditions", {"maxRows": 2}),
        ("actionIds", ["different-action"]),
        ("planId", "different-plan"),
        ("approverId", "different-approver"),
        ("nonce", "different-nonce"),
    ],
)
async def test_signed_fields_cannot_be_changed(field, value):
    token = copy.deepcopy(VECTORS["vectors"][-1]["token"])
    token["spec"][field] = value
    result = await ApprovalEngine(VECTORS["secret"]).verify(VECTORS["tenant"], token)
    assert not result.valid
    assert result.reason == "signature_mismatch"


@pytest.mark.parametrize("field", ["conditions", "contentDigest"])
async def test_signed_optional_field_cannot_be_removed(field):
    token = copy.deepcopy(VECTORS["vectors"][3]["token"])
    del token["spec"][field]
    result = await ApprovalEngine(VECTORS["secret"]).verify(VECTORS["tenant"], token)
    assert not result.valid
    assert result.reason == "signature_mismatch"


async def test_signature_and_tenant_key_remain_bound():
    token = copy.deepcopy(VECTORS["vectors"][-1]["token"])
    token["signature"] = "0" * 64
    assert not (await ApprovalEngine(VECTORS["secret"]).verify(VECTORS["tenant"], token)).valid
    token = VECTORS["vectors"][-1]["token"]
    engine = ApprovalEngine(VECTORS["secret"])
    engine.set_tenant_key("other-tenant", "another-synthetic-test-key")
    assert not (await engine.verify("other-tenant", token)).valid


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("conditions", None),
        ("conditions", []),
        ("contentDigest", None),
        ("contentDigest", 1),
        ("actionIds", "ab"),
        ("concurrency", "1"),
        ("concurrency", True),
        ("stopOnFailure", "false"),
        ("unknownSignedField", "x"),
    ],
)
async def test_malformed_fields_fail_closed_without_coercion(field, value):
    token = copy.deepcopy(VECTORS["vectors"][-1]["token"])
    token["spec"][field] = value
    result = await ApprovalEngine(VECTORS["secret"]).verify(VECTORS["tenant"], token)
    assert not result.valid
    assert result.reason == "malformed_token"


async def test_missing_required_field_fails_closed():
    token = copy.deepcopy(VECTORS["vectors"][0]["token"])
    del token["spec"]["planId"]
    result = await ApprovalEngine(VECTORS["secret"]).verify(VECTORS["tenant"], token)
    assert not result.valid
    assert result.reason == "malformed_token"
