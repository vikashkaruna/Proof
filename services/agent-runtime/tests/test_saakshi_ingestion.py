"""A provider upload is not success until its authorized pending intent settles."""

import json
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import ValidationError

from axiom.agents.saakshi import EvidenceIngestionCapability, SaakshiAgent, SaakshiInput
from axiom.canonicalise import sha256_hex
from axiom.config import get_settings
from axiom.evidence_client import SealedEvidence

TENANT = "11111111-1111-4111-8111-111111111111"
OPERATION = "22222222-2222-4222-8222-222222222222"
KEY = "33333333-3333-4333-8333-333333333333"
CORRELATION = "44444444-4444-4444-8444-444444444444"
EVIDENCE = "55555555-5555-4555-8555-555555555555"


@pytest.fixture
def fixture():
    settings = get_settings().model_copy(update={"axiom_evidence_bucket": "evidence"})
    vault = MagicMock()
    agent = SaakshiAgent(
        settings=settings, ledger=MagicMock(), evidence=vault, model_gateway=MagicMock()
    )
    input = SaakshiInput(
        tenant_id=TENANT, content="proof", evidence_type="document", mime_type="text/plain"
    )
    hash = sha256_hex(b"proof")
    key = f"tenants/{TENANT}/evidence-ingestions/{KEY}/{hash}"
    intent = {
        "id": OPERATION,
        "operation_key": KEY,
        "tenant_id": TENANT,
        "correlation_id": CORRELATION,
        "status": "pending",
        "retain_until": "2098-01-01T00:00:00Z",
        "request": {
            "content_hash": hash,
            "byte_size": 5,
            "mime_type": "text/plain",
            "filename": None,
            "evidence_type": "document",
            "description": None,
            "control_ids": [],
            "engagement_id": None,
            "collected_by_agent": "saakshi",
            "retention_policy": "seven_years",
            "legal_hold": False,
            "provider": "s3-compatible",
            "bucket": "evidence",
            "object_key": key,
        },
    }
    vault.seal.return_value = SealedEvidence(
        content_hash=hash,
        storage_uri=f"s3://evidence/{key}",
        bucket="evidence",
        key=key,
        byte_size=5,
        retain_until=datetime(2098, 1, 1, tzinfo=UTC),
        version_id="v1",
        readback_at=datetime.now(UTC),
        legal_hold=False,
        encryption="AES256",
    )
    return agent, vault, input, intent


def test_no_fabricated_tenant_content_or_authority_input():
    with pytest.raises(ValidationError):
        SaakshiInput()
    with pytest.raises(ValidationError):
        SaakshiInput(
            tenant_id=TENANT,
            content="proof",
            evidence_type="document",
            mime_type="text/plain",
            actor_id=EVIDENCE,
        )


async def test_missing_trusted_capability_fails_before_upload(fixture):
    agent, vault, input, _ = fixture
    with pytest.raises(RuntimeError, match="capability_required"):
        await agent._run(input=input, correlation_id=CORRELATION)
    vault.seal.assert_not_called()


async def test_success_requires_settled_exact_version_receipt(fixture):
    agent, vault, input, intent = fixture
    settle = AsyncMock(return_value=EVIDENCE)
    result = await agent._run(
        input=input,
        correlation_id=CORRELATION,
        evidence_ingestion=EvidenceIngestionCapability(json.dumps(intent), settle),
    )
    assert result.evidence_id == EVIDENCE
    assert result.version_id == "v1"
    receipt = settle.call_args.args[0]
    assert receipt["operation_id"] == OPERATION
    assert receipt["correlation_id"] == CORRELATION
    assert receipt["verified"] is True
    assert receipt["lock_mode"] == "COMPLIANCE"
    assert vault.seal.call_args.args[0].retain_until == datetime(2098, 1, 1, tzinfo=UTC)


@pytest.mark.parametrize("mutation", ["tenant", "hash", "key", "correlation", "settled"])
async def test_changed_artifact_or_intent_refuses_before_storage(fixture, mutation):
    agent, vault, input, intent = fixture
    if mutation == "tenant":
        intent["tenant_id"] = EVIDENCE
    elif mutation == "hash":
        intent["request"]["content_hash"] = "0" * 64
    elif mutation == "key":
        intent["request"]["object_key"] = "foreign"
    elif mutation == "correlation":
        intent["correlation_id"] = EVIDENCE
    else:
        intent["status"] = "settled"
    settle = AsyncMock()
    with pytest.raises(RuntimeError, match="intent_mismatch"):
        await agent._run(
            input=input,
            correlation_id=CORRELATION,
            evidence_ingestion=EvidenceIngestionCapability(json.dumps(intent), settle),
        )
    vault.seal.assert_not_called()
    settle.assert_not_called()


@pytest.mark.parametrize("failure", ["upload", "settlement", "empty_receipt"])
async def test_uncertain_operation_never_returns_empty_success_or_private_error(fixture, failure):
    agent, vault, input, intent = fixture
    settle = AsyncMock(return_value=EVIDENCE)
    if failure == "upload":
        vault.seal.side_effect = RuntimeError("private provider details")
    elif failure == "settlement":
        settle.side_effect = RuntimeError("private database details")
    else:
        settle.return_value = ""
    with pytest.raises(RuntimeError, match=r"^evidence_ingestion_pending_reconciliation$"):
        await agent._run(
            input=input,
            correlation_id=CORRELATION,
            evidence_ingestion=EvidenceIngestionCapability(json.dumps(intent), settle),
        )
    assert vault.seal.call_count == 1
    assert intent["status"] == "pending"
