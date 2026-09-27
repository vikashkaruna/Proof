"""Storage failure and provider ambiguity must never produce sealed proof."""

import hashlib
import io
from datetime import UTC, datetime
from unittest.mock import MagicMock

import pytest

from axiom.config import get_settings
from axiom.evidence_client import EvidenceVault, SealInput


@pytest.fixture
def vault(monkeypatch):
    client = MagicMock()
    client.get_object_lock_configuration.return_value = {
        "ObjectLockConfiguration": {"ObjectLockEnabled": "Enabled"}
    }
    client.put_object.return_value = {"VersionId": "immutable-version"}
    client.get_object_retention.return_value = {
        "Retention": {
            "Mode": "COMPLIANCE",
            "RetainUntilDate": datetime(2099, 1, 1, tzinfo=UTC),
        }
    }
    client.get_object_legal_hold.return_value = {"LegalHold": {"Status": "OFF"}}
    client.get_object.side_effect = lambda **kw: {
        "VersionId": "immutable-version",
        "ContentLength": 5,
        "Body": io.BytesIO(b"proof"),
        "ServerSideEncryption": "AES256",
        "Metadata": {
            "axiom-content-sha256": hashlib.sha256(b"proof").hexdigest(),
            "axiom-tenant-id": "tenant-a",
            "axiom-engagement-id": "",
            "axiom-collected-by-agent": "",
        },
    }
    monkeypatch.setattr("axiom.evidence_client.boto3.client", lambda *a, **kw: client)
    settings = get_settings().model_copy(
        update={"environment": "local", "axiom_storage_endpoint": None, "s3_endpoint": None}
    )
    return EvidenceVault(settings), client


def seal_input(**kw):
    return SealInput(
        bucket="evidence",
        key="key",
        body=b"proof",
        content_type="text/plain",
        retention_days=1,
        tenant_id="tenant-a",
        **kw,
    )


def test_uploaded_version_must_have_confirmed_compliance_retention(vault):
    subject, client = vault
    result = subject.seal(
        seal_input(metadata={"axiom-tenant-id": "foreign", "AXIOM-RETENTION-ASSURANCE": "verified"})
    )
    assert result.retention_assurance == "verified"
    assert result.lock_mode == "COMPLIANCE"
    client.get_object_retention.assert_called_once_with(
        Bucket="evidence", Key="key", VersionId="immutable-version"
    )
    metadata = client.put_object.call_args.kwargs["Metadata"]
    assert metadata["axiom-tenant-id"] == "tenant-a"
    assert metadata["axiom-retention-assurance"] == "unverified"
    assert "AXIOM-RETENTION-ASSURANCE" not in metadata


@pytest.mark.parametrize(
    "retention",
    [
        {},
        {"Mode": "GOVERNANCE"},
        {"Mode": "COMPLIANCE", "RetainUntilDate": datetime(2000, 1, 1, tzinfo=UTC)},
    ],
)
def test_insufficient_retention_cannot_seal(vault, retention):
    subject, client = vault
    client.get_object_retention.return_value = {"Retention": retention}
    with pytest.raises(RuntimeError, match="COMPLIANCE"):
        subject.seal(seal_input())


def test_local_upload_failure_does_not_produce_mock_compliance_evidence(vault):
    subject, client = vault
    client.put_object.side_effect = RuntimeError("upload failed")
    with pytest.raises(RuntimeError, match="upload failed"):
        subject.seal(seal_input())


def test_gcs_requires_provider_proof_before_upload(vault):
    subject, client = vault
    settings = subject._settings.model_copy(
        update={"axiom_storage_endpoint": "https://storage.googleapis.com"}
    )
    with pytest.raises(RuntimeError, match="GCS sealing requires"):
        EvidenceVault(settings).seal(seal_input())
    client.put_object.assert_not_called()


def test_missing_bucket_lock_refused_before_upload(vault):
    subject, client = vault
    client.get_object_lock_configuration.return_value = {}
    with pytest.raises(RuntimeError, match="Object Lock"):
        subject.seal(seal_input())
    client.put_object.assert_not_called()


def test_legal_hold_requires_readback(vault):
    subject, client = vault
    client.get_object_legal_hold.return_value = {"LegalHold": {"Status": "OFF"}}
    with pytest.raises(RuntimeError, match="legal hold"):
        subject.seal(seal_input(legal_hold=True))


@pytest.mark.parametrize("version", ["", "null", " "])
def test_exact_version_required_before_provider(vault, version):
    subject, client = vault
    with pytest.raises(ValueError, match="Exact evidence version"):
        subject.retrieve("evidence", "key", version)
    client.get_object.assert_not_called()


def test_exact_version_hash_and_no_latest_key_read(vault):
    subject, client = vault
    expected = hashlib.sha256(b"proof").hexdigest()
    assert subject.verify_integrity("evidence", "key", "immutable-version", expected) == (
        True,
        expected,
    )
    client.get_object.assert_called_once_with(
        Bucket="evidence", Key="key", VersionId="immutable-version"
    )
    assert subject.verify_integrity("evidence", "key", "immutable-version", "0" * 64)[0] is False


@pytest.mark.parametrize(
    "updates",
    [{"VersionId": "foreign"}, {"ContentLength": 6}, {"ContentLength": 2}, {"ContentLength": 100}],
)
def test_mismatched_or_oversized_reads_close_body(vault, updates):
    subject, client = vault
    stream = io.BytesIO(b"proof")
    client.get_object.side_effect = None
    client.get_object.return_value = {
        "VersionId": "immutable-version",
        "ContentLength": 5,
        "Body": stream,
        **updates,
    }
    with pytest.raises(RuntimeError):
        subject.retrieve("evidence", "key", "immutable-version", max_bytes=8)
    assert stream.closed


def test_stream_deadline_never_returns_verified_bytes(vault, monkeypatch):
    subject, client = vault
    stream = io.BytesIO(b"proof")
    client.get_object.side_effect = None
    client.get_object.return_value = {
        "VersionId": "immutable-version",
        "ContentLength": 5,
        "Body": stream,
    }
    ticks = iter([0, 0, 0, 0, 2])
    monkeypatch.setattr("axiom.evidence_client.time.monotonic", lambda: next(ticks))
    with pytest.raises(TimeoutError):
        subject.retrieve("evidence", "key", "immutable-version", timeout_seconds=1)
    assert stream.closed


def test_encryption_readback_required(vault):
    subject, client = vault
    original = client.get_object.side_effect
    client.get_object.side_effect = lambda **kw: {**original(**kw), "ServerSideEncryption": None}
    with pytest.raises(RuntimeError, match="encryption"):
        subject.seal(seal_input())


def test_fixed_operation_retention_is_not_extended_on_retry(vault):
    subject, client = vault
    deadline = datetime(2098, 1, 1, tzinfo=UTC)
    original = client.get_object.side_effect

    def returned(**kw):
        result = original(**kw)
        result["Metadata"]["axiom-operation-id"] = "operation"
        return result

    client.get_object.side_effect = returned
    subject.seal(seal_input(retain_until=deadline, operation_id="operation"))
    assert client.put_object.call_args.kwargs["ObjectLockRetainUntilDate"] == deadline
    assert client.put_object.call_args.kwargs["Metadata"]["axiom-operation-id"] == "operation"
