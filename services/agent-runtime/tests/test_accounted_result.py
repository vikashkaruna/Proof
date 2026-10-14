"""Pure synthetic witnesses; not live store, workload or release acceptance."""

from copy import deepcopy

import pytest
from pydantic import ValidationError
from test_model_call_accounting import failed, observed
from test_model_call_store import binding, seal

from axiom.accounted_result import (
    AccountedResult,
    ExpectedResult,
    LegacyAccountingView,
    ResultRefused,
    verify_accounted_result,
)
from axiom.canonicalise import sha256_hex
from axiom.model_call_accounting import AccountingSummary, legacy_projection
from axiom.model_call_store import AccountingSeal


def fixture(calls: list[object] | None = None, *, failure: bool = False):
    packet = seal(calls)
    text = None if failure else '{"inventory": [], "score": 3.0}'
    metrics = legacy_projection(AccountingSummary.model_validate(packet["summary"]))
    value = {
        **binding().model_dump(),
        "kind": "accounted_agent_result",
        "status": "failed" if failure else "succeeded",
        "latency_ms": 1,
        **metrics.model_dump(),
        "error": "agent_failed" if failure else None,
        "runtime_output_text": text,
        "ledger_entry_ids": ["2", "5"],
        "accounting_reference": {
            "calls_sha256": packet["calls_sha256"],
            "receipt": packet["accounting_receipt"],
        },
    }
    expected = ExpectedResult(
        binding=binding(),
        seal=AccountingSeal.model_validate(packet),
        terminal_status="failed" if failure else "succeeded",
        runtime_output_sha256=sha256_hex(text) if text is not None else None,
    )
    return value, expected


def test_unknown_success_has_nullable_metrics_and_exact_business_bytes():
    call = observed()
    call.update(
        usage={
            "availability": "unavailable",
            "input_tokens": None,
            "output_tokens": None,
            "total_tokens": None,
        },
        pricing={
            "basis": "unavailable",
            "scope": "successful_response_only",
            "config_sha256": None,
            "estimate_usd": None,
        },
    )
    value, expected = fixture([call])
    actual = verify_accounted_result(value, expected)
    assert (actual.result.input_tokens, actual.result.output_tokens, actual.result.cost_usd) == (
        None,
        None,
        None,
    )
    assert actual.output == {"inventory": [], "score": 3.0}
    assert actual.result.runtime_output_text == '{"inventory": [], "score": 3.0}'
    assert actual.accounting_status == "sealed_observed_journal"


def test_zero_projection_alone_never_establishes_no_model():
    value, expected = fixture()
    nonempty, nonempty_expected = fixture([observed()])
    assert verify_accounted_result(value, expected).result.cost_usd == "0.000000"
    assert verify_accounted_result(nonempty, nonempty_expected).result.cost_usd == "0.000000"
    assert expected.seal.summary.basis == "no_model"
    assert nonempty_expected.seal.summary.basis == "all_known"


def test_failed_unknown_has_no_output():
    value, expected = fixture([failed()], failure=True)
    actual = verify_accounted_result(value, expected)
    assert actual.output is None
    assert actual.result.cost_usd is None


@pytest.mark.parametrize(
    ("key", "replacement"),
    [
        ("tenant_id", "10000000-0000-0000-0000-000000000099"),
        ("run_id", "10000000-0000-0000-0000-000000000099"),
        ("correlation_id", "10000000-0000-0000-0000-000000000099"),
        ("request_sha256", "9" * 64),
        ("agent_version", "0.2.0"),
        ("status", "failed"),
        ("runtime_output_text", '{"score":3,"inventory":[]}'),
        ("ledger_entry_ids", ["2", "7"]),
        ("cost_usd", "0.000001"),
        ("input_tokens", 0),
    ],
)
def test_substitution_refused(key, replacement):
    value, expected = fixture([observed()])
    value[key] = replacement
    with pytest.raises(ResultRefused, match="accounted_result_contract_refused"):
        verify_accounted_result(value, expected)


@pytest.mark.parametrize("field", ["calls_sha256", "receipt"])
def test_reference_cannot_replace_actual_seal(field):
    value, expected = fixture()
    value = deepcopy(value)
    value["accounting_reference"][field] = (
        "9" * 64 if field == "calls_sha256" else {"id": "6", "entry_hash": "9" * 64}
    )
    with pytest.raises(ResultRefused):
        verify_accounted_result(value, expected)


@pytest.mark.parametrize(
    "text",
    [
        '{"x":1,"x":1}',
        '{"x":NaN}',
        '{"x":9007199254740992}',
        "[]",
        '{"x":0.100000000000000005}',
        '{"x":"\\u0000"}',
    ],
)
def test_matching_hash_cannot_make_ambiguous_output_valid(text):
    value, expected = fixture()
    value["runtime_output_text"] = text
    expected = expected.model_copy(update={"runtime_output_sha256": sha256_hex(text)})
    with pytest.raises(ResultRefused):
        verify_accounted_result(value, expected)


def test_legacy_zero_and_null_readable_but_never_no_model():
    for count in (0, None):
        view = LegacyAccountingView(
            input_tokens=count, output_tokens=count, total_tokens=count, cost_usd=count
        )
        assert view.accounting_status == "legacy_unverified"
        assert "no_model" not in view.model_dump().values()
    with pytest.raises(ValidationError):
        LegacyAccountingView(
            input_tokens=0,
            output_tokens=0,
            total_tokens=0,
            cost_usd=0,
            accounting_status="sealed_observed_journal",
        )


def test_parsing_alone_is_not_verification():
    value, _ = fixture()
    actual = AccountedResult.model_validate(value)
    assert not hasattr(actual, "accounting_status")
    assert not hasattr(actual, "verified")
