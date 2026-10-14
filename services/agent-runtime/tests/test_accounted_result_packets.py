"""Exact shared synthetic wire packets; no live authorization claim."""

import json
from pathlib import Path

import pytest
from axiom_model_accounting import ExpectedResult, verify_accounted_result

CASES = json.loads(
    (
        Path(__file__).resolve().parents[3]
        / "tests/fixtures/model-accounting/accounted-results.json"
    ).read_text()
)["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_exact_packet_and_original_output_bytes(case):
    expected = ExpectedResult.model_validate(case["expected"])
    actual = verify_accounted_result(json.loads(case["wire_text"]), expected)
    assert actual.result.runtime_output_text == case["runtime_output_text"]
    assert actual.result.cost_usd == case["cost_projection"]
    assert expected.seal.summary.basis == case["basis"]
    assert actual.accounting_status == "sealed_observed_journal"
