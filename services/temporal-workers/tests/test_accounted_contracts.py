"""Pure synthetic witnesses; no mounted activities or actual peer authority."""

import hashlib
import json
from copy import deepcopy

import pytest
from axiom_model_accounting import (
    AccountingBinding,
    AccountingSeal,
    ExpectedResult,
    derive_accounting,
)

from temporal_workers.accounted_contracts import (
    legacy_accounting_view,
    parse_accounted_runtime_result,
    validated_accounted_output,
)
from temporal_workers.contracts import ProtocolRefused


def hash_text(text):
    return hashlib.sha256(text.encode()).hexdigest()


def fixture(failed=False):
    def uid(n):
        return f"10000000-0000-0000-0000-{n:012d}"

    binding = AccountingBinding(
        schema_version=2,
        tenant_id=uid(1),
        run_id=uid(2),
        correlation_id=uid(3),
        request_sha256="a" * 64,
        agent="drishti",
        agent_version="0.1.0",
    )

    def receipt(i):
        return {"id": i, "entry_hash": hash_text(i)}

    text = None if failed else '{"inventory": [], "score": 3.0}'
    seal = AccountingSeal(
        **binding.model_dump(),
        serialization="postgres-jsonb-text-v1",
        calls_text="[]",
        calls_sha256=hash_text("[]"),
        summary=derive_accounting([]),
        requested_receipt=receipt("1"),
        agent_started_receipt=receipt("2"),
        agent_completed_receipt=receipt("5"),
        accounting_receipt=receipt("6"),
    )
    value = {
        **binding.model_dump(),
        "kind": "accounted_agent_result",
        "status": "failed" if failed else "succeeded",
        "latency_ms": 1,
        "input_tokens": 0,
        "output_tokens": 0,
        "cost_usd": "0.000000",
        "error": "agent_failed" if failed else None,
        "runtime_output_text": text,
        "ledger_entry_ids": ["2", "5"],
        "accounting_reference": {
            "calls_sha256": seal.calls_sha256,
            "receipt": receipt("6"),
        },
    }
    expected = ExpectedResult(
        binding=binding,
        seal=seal,
        terminal_status="failed" if failed else "succeeded",
        runtime_output_sha256=hash_text(text) if text is not None else None,
    )
    return value, expected


def test_shared_empty_journal_and_legacy_are_different():
    value, expected = fixture()
    result = parse_accounted_runtime_result(value, expected)
    assert result.accounting_status == "sealed_observed_journal"
    assert result.result.runtime_output_text == '{"inventory": [], "score": 3.0}'
    assert validated_accounted_output(value, expected) == {
        "inventory": [],
        "score": 3.0,
    }
    assert (
        legacy_accounting_view(
            {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cost_usd": 0}
        ).accounting_status
        == "legacy_unverified"
    )


def test_failed_accounting_never_becomes_successful_output():
    value, expected = fixture(True)
    assert parse_accounted_runtime_result(value, expected).output is None
    with pytest.raises(ProtocolRefused, match="agent_reported_failure"):
        validated_accounted_output(value, expected)


@pytest.mark.parametrize(
    "field",
    [
        "tenant_id",
        "run_id",
        "correlation_id",
        "request_sha256",
        "agent_version",
        "runtime_output_text",
        "input_tokens",
        "cost_usd",
        "accounting_reference",
    ],
)
def test_substitutions_refused(field):
    value, expected = fixture()
    value = deepcopy(value)
    changes = {
        "tenant_id": "10000000-0000-0000-0000-000000000099",
        "run_id": "10000000-0000-0000-0000-000000000099",
        "correlation_id": "10000000-0000-0000-0000-000000000099",
        "request_sha256": "9" * 64,
        "agent_version": "0.2.0",
        "runtime_output_text": '{"score":3,"inventory":[]}',
        "input_tokens": 1,
        "cost_usd": "0.000001",
        "accounting_reference": {
            "calls_sha256": "9" * 64,
            "receipt": {"id": "6", "entry_hash": "9" * 64},
        },
    }
    value[field] = changes[field]
    with pytest.raises(ProtocolRefused, match="agent_result_unconfirmed"):
        parse_accounted_runtime_result(value, expected)


def test_nullable_legacy_is_readable_but_cannot_upgrade():
    assert (
        legacy_accounting_view(
            {
                "input_tokens": None,
                "output_tokens": None,
                "total_tokens": None,
                "cost_usd": None,
            }
        ).accounting_status
        == "legacy_unverified"
    )
    with pytest.raises(ProtocolRefused):
        legacy_accounting_view(
            {
                "input_tokens": 0,
                "output_tokens": 0,
                "total_tokens": 0,
                "cost_usd": 0,
                "accounting_status": "sealed_observed_journal",
            }
        )


def test_json_wire_retains_original_output_bytes():
    value, expected = fixture()
    assert (
        parse_accounted_runtime_result(
            json.loads(json.dumps(value)), expected
        ).result.runtime_output_text
        == value["runtime_output_text"]
    )
