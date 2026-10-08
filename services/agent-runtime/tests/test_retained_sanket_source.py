"""Synthetic consistency tests, never a SQL authority or live acceptance proof."""

from __future__ import annotations

import json
from dataclasses import FrozenInstanceError
from typing import Any

import pytest
from pydantic import ValidationError

from axiom.agents.sanket import SanketInput
from axiom.canonicalise import canonical_json, sha256_hex
from axiom.ledger_client import LedgerClient
from axiom.retained_sanket_source import (
    RetainedSanketAgent,
    RetainedSanketInput,
    RetainedSanketScope,
    prepare_retained_sanket_source,
)


def identifier(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


def scope() -> RetainedSanketScope:
    return RetainedSanketScope(
        tenant_id=identifier(1),
        actor_id=identifier(2),
        engagement_id=identifier(3),
        run_id=identifier(4),
        operation_key=identifier(5),
    )


def fixture() -> dict[str, Any]:
    capture = {
        "requestedUrl": "https://axiomminds.ai/",
        "finalUrl": "https://axiomminds.ai/",
        "checkedAt": "2026-10-08T07:41:58.139Z",
        "status": "checked",
        "httpStatus": 200,
        "bytes": 170,
        "contentSha256": "a" * 64,
        "title": "A synthetic public RFP heading",
        "headings": ["Data protection officer", "Public services"],
    }
    # Deliberately PG-style spacing: the raw persisted result hash is opaque,
    # whereas agent input has the established Python/TS canonical wire codec.
    result_text = json.dumps(capture, ensure_ascii=False)
    context = scope()
    input_value = RetainedSanketInput.model_validate(
        {
            "schema_version": 1,
            "tenant_id": context.tenant_id,
            "engagement_id": context.engagement_id,
            "correlation_id": context.operation_key,
            "source": {
                "check_id": identifier(6),
                "capture_actor_id": identifier(7),
                "capture_correlation_id": identifier(8),
                "capture_receipt": "10",
                "result_sha256": sha256_hex(result_text),
                "requested_url": capture["requestedUrl"],
                "final_url": capture["finalUrl"],
                "checked_at": capture["checkedAt"],
                "content_sha256": capture["contentSha256"],
                "byte_size": capture["bytes"],
                "title": capture["title"],
                "headings": capture["headings"],
            },
        }
    )
    input_text = canonical_json(input_value.model_dump(mode="json"))
    return {
        **context.model_dump(),
        "input_text": input_text,
        "input_hash": sha256_hex(input_text),
        "capture_result_text": result_text,
        "requested_receipt": "20",
    }


def alter_source(row: dict[str, Any], key: str, value: Any) -> None:
    raw = json.loads(row["input_text"])
    raw["source"][key] = value
    row["input_text"] = canonical_json(raw)
    row["input_hash"] = sha256_hex(row["input_text"])


def test_exact_retained_capture_preserves_projection_and_original_receipt():
    prepared = prepare_retained_sanket_source(fixture(), expected_scope=scope())
    document = prepared.public_source_batch.documents[0]
    assert document.title == "A synthetic public RFP heading"
    assert document.headings == ("Data protection officer", "Public services")
    assert document.capture_reference == identifier(6)
    assert document.content_sha256 == "a" * 64
    assert prepared.input.source.capture_receipt == "10"
    assert prepared.input.source.capture_actor_id == identifier(7)
    assert prepared.requested_receipt == "20"
    with pytest.raises(FrozenInstanceError):
        prepared.requested_receipt = "30"


@pytest.mark.parametrize("key", list(RetainedSanketScope.model_fields))
def test_every_dispatch_scope_field_is_bound(key: str):
    row = fixture()
    row[key] = identifier(99)
    with pytest.raises(ValueError, match="dispatch consistency"):
        prepare_retained_sanket_source(row, expected_scope=scope())


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("title", "Invented hiring notice"),
        ("headings", ["Invented vacancy"]),
        ("requested_url", "https://other-company.ai/"),
        ("final_url", "https://other-company.ai/"),
        ("checked_at", "2026-10-09T07:00:00Z"),
        ("byte_size", 171),
        ("content_sha256", "b" * 64),
    ],
)
def test_rehashed_input_cannot_relabel_original_capture(key: str, value: Any):
    row = fixture()
    alter_source(row, key, value)
    with pytest.raises(ValueError, match="capture projection"):
        prepare_retained_sanket_source(row, expected_scope=scope())


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("status", "failed"),
        ("httpStatus", "200"),
        ("httpStatus", True),
        ("bytes", True),
        ("headings", "Data protection officer"),
    ],
)
def test_even_consistent_result_hash_requires_successful_typed_capture(key: str, value: Any):
    row = fixture()
    raw = json.loads(row["capture_result_text"])
    raw[key] = value
    row["capture_result_text"] = json.dumps(raw)
    alter_source(row, "result_sha256", sha256_hex(row["capture_result_text"]))
    with pytest.raises(ValueError, match="capture projection"):
        prepare_retained_sanket_source(row, expected_scope=scope())


@pytest.mark.parametrize("field", ["tenant_id", "engagement_id", "correlation_id"])
def test_consistent_input_hash_cannot_change_dispatch_context(field: str):
    row = fixture()
    raw = json.loads(row["input_text"])
    raw[field] = identifier(99)
    row["input_text"] = canonical_json(raw)
    row["input_hash"] = sha256_hex(row["input_text"])
    with pytest.raises(ValueError, match="input consistency"):
        prepare_retained_sanket_source(row, expected_scope=scope())


def test_exact_bytes_not_reserialized_pg_result_determine_result_hash():
    row = fixture()
    row["capture_result_text"] += " "
    with pytest.raises(ValueError, match="input consistency"):
        prepare_retained_sanket_source(row, expected_scope=scope())
    row = fixture()
    row["input_text"] += " "
    row["input_hash"] = sha256_hex(row["input_text"])
    with pytest.raises(ValueError, match="input consistency"):
        prepare_retained_sanket_source(row, expected_scope=scope())


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("byte_size", True),
        ("headings", ["x"] * 13),
        ("headings", ["x" * 301]),
        ("headings", ["x" * 501]),
        ("capture_receipt", "0"),
        ("capture_receipt", 10),
        ("check_id", "not-a-uuid"),
        ("title", "x" * 301),
    ],
)
def test_strict_source_schema_rejects_malformed_projection(key: str, value: Any):
    row = fixture()
    alter_source(row, key, value)
    with pytest.raises((ValidationError, ValueError)):
        prepare_retained_sanket_source(row, expected_scope=scope())


def test_utf8_budget_and_unknown_authority_fields_refused():
    row = fixture()
    raw = json.loads(row["capture_result_text"])
    raw["irrelevant"] = "界" * 15000
    row["capture_result_text"] = json.dumps(raw, ensure_ascii=False)
    alter_source(row, "result_sha256", sha256_hex(row["capture_result_text"]))
    with pytest.raises(ValueError, match="dispatch consistency"):
        prepare_retained_sanket_source(row, expected_scope=scope())


def test_boolean_version_and_duplicate_input_keys_refused():
    row = fixture()
    raw = json.loads(row["input_text"])
    raw["schema_version"] = True
    row["input_text"] = canonical_json(raw)
    row["input_hash"] = sha256_hex(row["input_text"])
    with pytest.raises(ValidationError):
        prepare_retained_sanket_source(row, expected_scope=scope())
    row = fixture()
    row["input_text"] = row["input_text"][:-1] + ',"schema_version":1}'
    row["input_hash"] = sha256_hex(row["input_text"])
    with pytest.raises(ValueError, match="input consistency"):
        prepare_retained_sanket_source(row, expected_scope=scope())
    row = fixture()
    row["approved"] = True
    with pytest.raises(ValidationError):
        prepare_retained_sanket_source(row, expected_scope=scope())


def test_generic_business_schema_cannot_install_retained_source_capability():
    raw = json.loads(fixture()["input_text"])
    with pytest.raises(ValidationError):
        SanketInput.model_validate(raw)


@pytest.mark.parametrize("receipt", ["20", "21"])
def test_named_request_receipt_must_follow_original_human_capture(receipt: str):
    row = fixture()
    alter_source(row, "capture_receipt", receipt)
    with pytest.raises(ValueError, match="input consistency"):
        prepare_retained_sanket_source(row, expected_scope=scope())


async def test_component_invocation_commits_source_input_and_never_infers_intent():
    row = fixture()
    prepared = prepare_retained_sanket_source(row, expected_scope=scope())
    ledger = LedgerClient.in_memory()
    agent = RetainedSanketAgent(ledger=ledger, prepared=prepared)
    result = await agent.invoke(
        prepared.input.model_dump(mode="json"), correlation_id=scope().operation_key
    )
    assert result.status == "succeeded"
    assert result.output is not None
    assert result.output["high_intent"] == []
    assert {signal["score"] for signal in result.output["signals"]} == {0}
    assert result.output["source_observations"][0]["capture_reference"] == identifier(6)
    assert len(result.ledger_entry_ids) == 2
    assert [entry["input_hash"] for entry in ledger.memory_entries] == [
        row["input_hash"],
        row["input_hash"],
    ]


@pytest.mark.parametrize("field", ["title", "capture_receipt", "result_sha256"])
async def test_installed_source_cannot_be_substituted_at_actual_invoke(field: str):
    prepared = prepare_retained_sanket_source(fixture(), expected_scope=scope())
    changed = prepared.input.model_dump(mode="json")
    changed["source"][field] = {
        "title": "Invented heading",
        "capture_receipt": "11",
        "result_sha256": "b" * 64,
    }[field]
    agent = RetainedSanketAgent(ledger=LedgerClient.in_memory(), prepared=prepared)
    result = await agent.invoke(changed, correlation_id=scope().operation_key)
    assert result.status == "failed"
    assert result.output is None


def test_business_json_cannot_construct_dedicated_agent_capability():
    with pytest.raises(ValueError, match="service capability required"):
        RetainedSanketAgent(ledger=LedgerClient.in_memory(), prepared=fixture())  # type: ignore[arg-type]
