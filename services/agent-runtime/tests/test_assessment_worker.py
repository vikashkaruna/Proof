"""Pure worker contract and failure behavior; physical isolation has a Docker lane."""

import hashlib
import json
from copy import deepcopy

import pytest

from axiom.assessment_worker import execute, parse_json
from axiom.control_library_loader import load_default_library


def fixture():
    from dataclasses import asdict

    library = load_default_library()
    control = asdict(next(iter(library)))
    control["library_version"] = "worker-test"
    control["scoring"] = {"baseline": 0, "weight": 1, "penaltyPoints": 10, "maxPenaltyINR": 1000000}
    control["assessment_questions"] = [
        {"id": "Q1", "type": "boolean"},
        {"id": "Q2", "type": "boolean"},
    ]
    raw = {
        "tenant_id": "50500000-0000-4000-8000-000000000001",
        "engagement_id": "50500000-0000-4000-8000-000000000002",
        "library_version": "worker-test",
        "answers": {control["id"]: {"Q1": False, "Q2": False, "invented": True}},
    }
    wire = json.dumps(raw)
    envelope = {
        "tenantId": raw["tenant_id"],
        "runId": "50500000-0000-4000-8000-000000000003",
        "taskProof": "a" * 43,
        "inputJson": wire,
        "inputHash": hashlib.sha256(wire.encode()).hexdigest(),
        "spiffeId": "spiffe://local.axiomproof.test/agent/parikshan",
    }
    packet = {
        "engagement_id": raw["engagement_id"],
        "library_version": raw["library_version"],
        "library_digest": "b" * 64,
        "controls": [control],
        "started_receipt": "1",
    }
    calls = []

    def call(operation, request, spiffe_id):
        calls.append((operation, deepcopy(request), spiffe_id))
        if operation == "assessment.start":
            return packet
        return {"completed_receipt": "2", "result_digest": "c" * 64}

    return envelope, packet, calls, call


def test_exact_input_and_zero_scores_are_persisted_before_success():
    envelope, _, calls, call = fixture()
    receipt = execute(envelope, call)
    assert receipt["status"] == "persisted"
    assert [c[0] for c in calls] == ["assessment.start", "assessment.complete"]
    result = calls[1][1]["result"]
    assert result["posture_score"] == 0
    assert result["findings"][0]["score"] == 0
    assert result["findings"][0]["risk_points"] == 10
    assert result["estimated_exposure_inr"] == 10_000_000
    assert "answers" not in result
    assert "taskProof" not in receipt


def test_changed_wire_input_refused_before_tools():
    envelope, _, calls, call = fixture()
    envelope["inputJson"] += " "
    with pytest.raises(ValueError, match="Input binding"):
        execute(envelope, call)
    assert calls == []


@pytest.mark.parametrize(
    "change", ["version", "engagement", "empty", "duplicate", "control_version", "weight"]
)
def test_invalid_library_snapshot_has_no_write(change):
    envelope, packet, calls, call = fixture()
    if change == "version":
        packet["library_version"] = "foreign"
    elif change == "engagement":
        packet["engagement_id"] = envelope["runId"]
    elif change == "empty":
        packet["controls"] = []
    elif change == "duplicate":
        packet["controls"] *= 2
    elif change == "control_version":
        packet["controls"][0]["library_version"] = "foreign"
    else:
        packet["controls"][0]["scoring"]["weight"] = -1
    with pytest.raises(
        ValueError, match=r"Packet context|Invalid controls|Invalid library|Invalid scoring"
    ):
        execute(envelope, call)
    assert len(calls) == 1


def test_refused_write_never_becomes_computed_success():
    envelope, _, calls, call = fixture()

    def refused(operation, request, spiffe_id):
        if operation == "assessment.complete":
            raise ValueError("Tool refused")
        return call(operation, request, spiffe_id)

    with pytest.raises(ValueError, match="Tool refused"):
        execute(envelope, refused)
    assert len(calls) == 1


@pytest.mark.parametrize("value", ['{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}'])
def test_noncanonical_json_is_refused(value):
    with pytest.raises(ValueError, match=r"Duplicate field|Non-finite"):
        parse_json(value)
