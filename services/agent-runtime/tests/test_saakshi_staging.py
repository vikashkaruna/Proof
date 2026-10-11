"""Unwired contract proofs only; no agent, provider or cloud acceptance claim."""

import hashlib
import hmac
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from axiom.canonicalise import canonical_json, sha256_hex
from axiom.saakshi_staging import (
    EvidenceStageInput,
    EvidenceStagePort,
    EvidenceStageReceipt,
    SignedEvidenceStageRequest,
    StagedEvidenceOutput,
    stage_owned_evidence,
    verify_evidence_stage_request,
)

TENANT = "11111111-1111-4111-8111-111111111111"
ACTOR = "22222222-2222-4222-8222-222222222222"
OPERATION = "aaaaaaaa-3333-4333-8333-333333333333"
CORRELATION = "44444444-4444-4444-8444-444444444444"
HASH = "a" * 64
SOURCE_KEY = "test-source-key-not-secret-" + "x" * 40
PEER_KEY = "test-peer-key-not-secret-" + "y" * 40
NOW = datetime(2026, 10, 8, 0, 0, tzinfo=UTC)


def source(**changes):
    return EvidenceStageInput.model_validate(
        {
            "purpose": "saakshi_owned_resource_stage_v1",
            "tenant_id": TENANT,
            "actor_id": ACTOR,
            "engagement_id": None,
            "operation_id": OPERATION,
            "operation_key": OPERATION,
            "owned_resource_id": ACTOR,
            "human_request_hash": HASH,
            "content_hash": HASH,
            "byte_size": 3,
            "provider": "s3-compatible",
            "bucket": "owned-fixture",
            "object_key": f"tenants/{TENANT}/evidence-ingestions/{OPERATION}/{HASH}",
            "retain_until": "2033-10-08T00:00:01Z",
            "legal_hold": False,
            "encryption": "AES256",
            **changes,
        }
    )


def receipt(**changes):
    value = source().model_dump()
    for name in ["purpose", "actor_id", "operation_key", "owned_resource_id", "human_request_hash"]:
        value.pop(name)
    return EvidenceStageReceipt.model_validate(
        {
            **value,
            "correlation_id": CORRELATION,
            "version_id": "actual-version-id",
            "collected_by_agent": "saakshi",
            "readback_at": "2026-10-08T00:00:00Z",
            "lock_mode": "COMPLIANCE",
            "verified": True,
            **changes,
        }
    )


def request(*, key=SOURCE_KEY, input_value=None, changes=None, whitespace=False):
    text = canonical_json(input_value or source().model_dump(mode="json"))
    value = {
        "version": 1,
        "input_text": text,
        "correlation_id": CORRELATION,
        "dispatch_context": {"run_id": OPERATION, "request_hash": sha256_hex(text)},
        "expires_at": int(NOW.timestamp()) + 60,
        **(changes or {}),
    }
    signed = canonical_json(value)
    if whitespace:
        signed += " "
    signature = hmac.new(
        key.encode(), b"axiom-saakshi-stage-v1\0" + signed.encode(), hashlib.sha256
    ).hexdigest()
    return SignedEvidenceStageRequest(signed_text=signed, signature=signature)


def verify(value, **kwargs):
    return verify_evidence_stage_request(
        value, SOURCE_KEY, peer_secret=PEER_KEY, now=NOW.timestamp(), **kwargs
    )


def test_distinct_source_key_and_exact_dispatch_without_runtime_credentials():
    value, correlation, dispatch = verify(request())
    assert value == source()
    assert correlation == CORRELATION
    assert str(dispatch.run_id) == OPERATION
    assert "source_url" not in value.model_dump()
    assert "content" not in value.model_dump()


@pytest.mark.parametrize(
    "change",
    [
        {"version": True},
        {"expires_at": int(NOW.timestamp())},
        {"expires_at": int(NOW.timestamp()) + 121},
        {"dispatch_context": {"run_id": OPERATION, "request_hash": "f" * 64}},
        {
            "dispatch_context": {
                "run_id": OPERATION.upper(),
                "request_hash": sha256_hex(canonical_json(source().model_dump(mode="json"))),
            }
        },
        {"unexpected_authority": True},
    ],
)
def test_changed_or_expired_envelope_refused(change):
    with pytest.raises(ValueError, match=r"Evidence stage|Evidence placement|validation error"):
        verify(request(changes=change))


def test_peer_key_and_reused_other_workflow_key_refused():
    with pytest.raises(ValueError, match=r"Evidence stage|Evidence placement|validation error"):
        verify(request(key=PEER_KEY))
    with pytest.raises(ValueError, match=r"Evidence stage|Evidence placement|validation error"):
        verify_evidence_stage_request(
            request(), SOURCE_KEY, peer_secret=SOURCE_KEY, now=NOW.timestamp()
        )
    with pytest.raises(ValueError, match=r"Evidence stage|Evidence placement|validation error"):
        verify(request(), other_secrets=(SOURCE_KEY,))
    with pytest.raises(ValueError, match=r"Evidence stage|Evidence placement|validation error"):
        verify(request(whitespace=True))


@pytest.mark.parametrize(
    "change",
    [
        {"source_url": "https://private.invalid"},
        {"storage_credentials": {"secret": "forbidden"}},
        {"evidence_id": OPERATION},
        {"object_key": "foreign/path"},
        {"byte_size": True},
        {"legal_hold": 0},
    ],
)
def test_input_cannot_supply_urls_credentials_registration_or_coerced_authority(change):
    with pytest.raises(ValueError, match=r"Evidence stage|Evidence placement|validation error"):
        source(**change)


@pytest.mark.asyncio
async def test_exact_port_output_is_pending_registration_only():
    calls = []

    async def stage(value, correlation):
        calls.append((value, correlation))
        return receipt()

    result = await stage_owned_evidence(
        source(), CORRELATION, EvidenceStagePort(source(), CORRELATION, stage), now=NOW
    )
    assert result.kind == "sealed_pending_registration"
    assert result.accepted is False
    assert len(calls) == 1
    assert "evidence_id" not in result.model_dump()
    with pytest.raises(ValidationError):
        StagedEvidenceOutput.model_validate({**result.model_dump(), "accepted": True})
    with pytest.raises(ValidationError):
        StagedEvidenceOutput.model_validate({**result.model_dump(), "accepted": 0})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change",
    [
        {"tenant_id": ACTOR},
        {"provider": "s3"},
        {"operation_id": ACTOR},
        {"bucket": "foreign-bucket"},
        {"content_hash": "b" * 64},
        {"byte_size": 4},
        {"legal_hold": True},
        {"encryption": "aws:kms"},
        {"correlation_id": ACTOR},
        {"retain_until": "2033-10-08T00:00:00Z"},
        {"readback_at": "2026-10-07T23:54:59Z"},
    ],
)
async def test_changed_provider_receipt_cannot_become_staged_source(change):
    async def stage(*_):
        return receipt(**change)

    with pytest.raises(ValueError, match=r"Evidence stage|Evidence placement|validation error"):
        await stage_owned_evidence(
            source(), CORRELATION, EvidenceStagePort(source(), CORRELATION, stage), now=NOW
        )


@pytest.mark.asyncio
async def test_foreign_source_or_context_refuses_before_port_call():
    calls = []

    async def stage(*args):
        calls.append(args)
        return receipt()

    port = EvidenceStagePort(source(), CORRELATION, stage)
    with pytest.raises(ValueError, match=r"Evidence stage|Evidence placement|validation error"):
        await stage_owned_evidence(source(actor_id=TENANT), CORRELATION, port, now=NOW)
    with pytest.raises(ValueError, match=r"Evidence stage|Evidence placement|validation error"):
        await stage_owned_evidence(source(), ACTOR, port, now=NOW)
    assert calls == []


@pytest.mark.parametrize(
    "change",
    [
        {"verified": 1},
        {"verified": False},
        {"lock_mode": "GOVERNANCE"},
        {"version_id": "null"},
        {"version_id": ""},
        {"readback_at": "2026-10-08T00:00:00"},
    ],
)
def test_unverified_or_unversioned_receipt_is_not_output(change):
    with pytest.raises(ValueError, match=r"Evidence stage|Evidence placement|validation error"):
        receipt(**change)
