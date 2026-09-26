"""W5 · M3.2 — the dry-run engine.

The simulator is pure and deterministic: the same declared content always
produces the same structured diff, refusals are outcomes (not errors),
and unknown or free-text-shaped parameters never reach a diff. Doc 04
§3.2 is the design rule under test: if the diff cannot be rendered
legibly, the action is not eligible for agent execution.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from axiom.app import DRY_RUN_CONTRACT_VERSION, InternalDryRunRequest, app
from axiom.dry_run import simulate

FIXTURE = (
    Path(__file__).resolve().parents[3] / "tests" / "contracts" / "dry-run.v1.json"
)

MASK_PARAMS = {"system": "crm", "fields": ["phone", "email"]}
ROLLBACK = {"steps": [{"op": "restore_from_backup"}]}


# ── the simulator ──────────────────────────────────────────────────────


def test_data_mask_renders_a_structured_diff() -> None:
    outcome = simulate("data.mask", MASK_PARAMS, {"records": 1204}, ROLLBACK)
    assert outcome.status == "succeeded"
    assert outcome.diff is not None
    assert outcome.refusal_reason is None
    assert outcome.diff["renderable"] is True
    assert outcome.diff["simulated_from"] == "declared_parameters"
    assert outcome.diff["records_declared"] is True
    assert outcome.diff["targets"] == [{"system": "crm", "records": 1204}]
    assert outcome.diff["changes"] == [
        {"field": "phone", "before": "value_as_stored", "after": "masked", "records_affected": 1204},
        {"field": "email", "before": "value_as_stored", "after": "masked", "records_affected": 1204},
    ]
    assert outcome.diff["rollback"] == {"defined": True}


def test_undeclared_record_count_is_never_invented() -> None:
    outcome = simulate("data.delete", {"system": "crm", "criteria": "expired"}, {}, ROLLBACK)
    assert outcome.status == "succeeded"
    assert outcome.diff is not None
    assert outcome.diff["records_declared"] is False
    assert outcome.diff["changes"][0]["records_affected"] is None


def test_simulation_is_deterministic() -> None:
    first = simulate("data.mask", MASK_PARAMS, {"records": 5}, ROLLBACK)
    second = simulate("data.mask", MASK_PARAMS, {"records": 5}, ROLLBACK)
    assert first.diff == second.diff
    assert json.dumps(first.diff, sort_keys=True) == json.dumps(second.diff, sort_keys=True)


def test_every_named_enum_type_except_custom_is_simulable() -> None:
    simulable = {
        "policy.publish": {"document": "retention-policy"},
        "policy.update": {"document": "retention-policy"},
        "notice.update": {"document": "privacy-notice"},
        "consent.update": {"document": "consent-text"},
        "data.portability_export": {"system": "crm", "destination": "dsg-box"},
        "config.rbac_update": {"role": "support", "grant_permissions": ["ticket.read"]},
        "config.mfa_enforce": {"scope": "tenant"},
        "config.backup_encrypt": {"enabled": True},
        "config.audit_log_enable": {"enabled": True},
        "config.consent_ui_update": {"surface": "checkout"},
        "dpo.appoint": {"fields": ["name", "email"]},
        "dpa.execute": {"counterparty": "vendor-1"},
        "dpo.contact_publish": {"fields": ["email"]},
        "breach.playbook_publish": {"playbook": "breach-72h"},
        "training.run": {"programme": "dp-basics"},
        "review.accept_risk": {"finding": "f-1"},
        "connector.scan": {"system": "crm"},
        "connector.classify": {"system": "crm"},
    }
    for action_type, params in simulable.items():
        outcome = simulate(action_type, params, {}, ROLLBACK)
        assert outcome.status == "succeeded", f"{action_type} should simulate: {outcome.refusal_reason}"
        assert outcome.diff is not None
        assert outcome.diff["renderable"] is True


def test_custom_is_refused_to_manual_handling() -> None:
    outcome = simulate("custom", {"anything": "goes"}, {}, ROLLBACK)
    assert outcome.status == "refused"
    assert outcome.refusal_reason == "action_type_not_simulable"
    assert outcome.diff is None


def test_unknown_type_is_refused() -> None:
    outcome = simulate("data.transmogrify", {}, {}, ROLLBACK)
    assert outcome.status == "refused"
    assert outcome.refusal_reason == "action_type_not_simulable"


def test_missing_required_parameter_is_refused() -> None:
    outcome = simulate("data.mask", {"system": "crm"}, {}, ROLLBACK)
    assert outcome.status == "refused"
    assert outcome.refusal_reason == "parameters_invalid"


def test_free_text_parameter_value_is_refused() -> None:
    outcome = simulate(
        "data.mask", {"system": "crm; drop table users", "fields": ["phone"]}, {}, ROLLBACK
    )
    assert outcome.status == "refused"
    assert outcome.refusal_reason == "parameters_invalid"


def test_extra_parameter_key_is_refused() -> None:
    outcome = simulate("data.mask", {**MASK_PARAMS, "raw_values": ["+91..."]}, {}, ROLLBACK)
    assert outcome.status == "refused"
    assert outcome.refusal_reason == "parameters_invalid"


def test_oversized_parameters_are_refused() -> None:
    outcome = simulate("data.mask", {"system": "x" * 70_000, "fields": ["phone"]}, {}, ROLLBACK)
    assert outcome.status == "refused"
    assert outcome.refusal_reason == "parameters_oversized"


def test_connector_scan_declares_no_mutation() -> None:
    outcome = simulate("connector.scan", {"system": "crm"}, {}, ROLLBACK)
    assert outcome.status == "succeeded"
    assert outcome.diff is not None
    assert outcome.diff["changes"] == []


# ── the shared contract fixture ────────────────────────────────────────


def test_contract_fixture_exists() -> None:
    assert FIXTURE.is_file(), f"shared contract fixture missing at {FIXTURE}"


def test_runtime_accepts_the_bff_payload() -> None:
    payload = json.loads(FIXTURE.read_text())
    parsed = InternalDryRunRequest(**payload)
    assert parsed.action_type == payload["action_type"]
    assert parsed.parameters == payload["parameters"]
    assert parsed.blast_radius == payload["blast_radius"]
    assert parsed.rollback_definition == payload["rollback_definition"]


def test_contract_versions_agree() -> None:
    payload = json.loads(FIXTURE.read_text())
    assert payload["contract_version"] == DRY_RUN_CONTRACT_VERSION


def test_camel_case_is_refused() -> None:
    with pytest.raises(ValidationError):
        InternalDryRunRequest(
            tenantId="t",
            actionId="a",
            actionType="data.mask",
            parameters={},
            rollbackDefinition={},
            correlationId="c",
        )


# ── the /internal/dry-run route ────────────────────────────────────────


def _post(client: TestClient, payload: dict) -> object:
    return client.post(
        "/internal/dry-run",
        json=payload,
        headers={"X-Internal-Token": "fixture-token"},
    )


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(
        app.state, "settings", SimpleNamespace(internal_token="fixture-token"), raising=False
    )
    return TestClient(app)


def test_route_requires_internal_token(client: TestClient) -> None:
    payload = json.loads(FIXTURE.read_text())
    response = TestClient(app).post("/internal/dry-run", json=payload)
    assert response.status_code == 401


def test_success_returns_the_recorded_dry_run(client: TestClient) -> None:
    payload = json.loads(FIXTURE.read_text())
    recorded = {
        "dryRun": {
            "id": "dry-run-1",
            "status": "succeeded",
            "renderable": True,
            "refusalReason": None,
            "expiresAt": "2026-09-27T00:00:00+00:00",
            "createdAt": "2026-09-26T00:00:00+00:00",
        }
    }
    with patch("axiom.app._record_dry_run_via_rpc", return_value=recorded) as recorder:
        response = _post(client, payload)
    assert response.status_code == 200
    body = response.json()
    assert body["accepted"] is True
    assert body["contract_version"] == DRY_RUN_CONTRACT_VERSION
    assert body["dry_run"]["id"] == "dry-run-1"
    # The RPC receives exactly the simulated outcome bound to the sent content.
    args = recorder.call_args
    assert args.args[1].action_id == payload["action_id"]
    assert args.args[2].status == "succeeded"


def test_refusal_is_still_recorded_and_returned_as_an_outcome(client: TestClient) -> None:
    payload = json.loads(FIXTURE.read_text())
    payload["action_type"] = "custom"
    payload["parameters"] = {"anything": "goes"}
    recorded = {
        "dryRun": {
            "id": "dry-run-2",
            "status": "refused",
            "renderable": False,
            "refusalReason": "action_type_not_simulable",
            "expiresAt": "2026-09-27T00:00:00+00:00",
            "createdAt": "2026-09-26T00:00:00+00:00",
        }
    }
    with patch("axiom.app._record_dry_run_via_rpc", return_value=recorded):
        response = _post(client, payload)
    assert response.status_code == 200
    body = response.json()
    assert body["accepted"] is True
    assert body["dry_run"]["status"] == "refused"


def test_recorder_error_is_a_refusal_not_a_diff(client: TestClient) -> None:
    payload = json.loads(FIXTURE.read_text())
    with patch("axiom.app._record_dry_run_via_rpc", return_value={"error": "content_mismatch"}):
        response = _post(client, payload)
    assert response.status_code == 409
    assert response.json() == {"accepted": False, "reason": "content_mismatch"}


def test_recorder_unavailability_returns_503_and_no_result(client: TestClient) -> None:
    payload = json.loads(FIXTURE.read_text())
    with patch("axiom.app._record_dry_run_via_rpc", side_effect=RuntimeError("db down")):
        response = _post(client, payload)
    assert response.status_code == 503
    assert response.json() == {"accepted": False, "reason": "recorder_unavailable"}


def test_wrong_contract_version_is_a_400(client: TestClient) -> None:
    payload = json.loads(FIXTURE.read_text())
    payload["contract_version"] = DRY_RUN_CONTRACT_VERSION + 1
    response = _post(client, payload)
    assert response.status_code == 400
