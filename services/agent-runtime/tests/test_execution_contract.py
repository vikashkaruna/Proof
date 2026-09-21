"""W5 · R-05 — the runtime half of the execution dispatch contract.

The BFF sent camelCase to a model requiring snake_case with no aliases, so
every dispatch to /internal/execute was a 422. The BFF never checked the
response, so it reported the batch as accepted. Both sides were internally
consistent and both test suites were green.

Only a test spanning both catches that, so both are pinned to one fixture:
``services/bff/src/routes/execution-contract.test.ts`` asserts the BFF
produces it, and this file asserts the runtime accepts it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from axiom.app import EXECUTION_CONTRACT_VERSION, InternalExecuteRequest

FIXTURE = (
    Path(__file__).resolve().parents[3] / "tests" / "contracts" / "execution-dispatch.v2.json"
)


@pytest.fixture
def payload() -> dict:
    return json.loads(FIXTURE.read_text())


def test_fixture_exists() -> None:
    assert FIXTURE.is_file(), f"shared contract fixture missing at {FIXTURE}"


def test_runtime_accepts_the_bff_payload(payload: dict) -> None:
    parsed = InternalExecuteRequest(**payload)
    assert parsed.plan_id == payload["plan_id"]
    assert parsed.action_ids == payload["action_ids"]
    assert parsed.request_key == payload["request_key"]
    assert parsed.stop_on_failure is payload["stop_on_failure"]


def test_contract_versions_agree(payload: dict) -> None:
    assert payload["contract_version"] == EXECUTION_CONTRACT_VERSION


def test_camel_case_is_refused() -> None:
    """The exact payload the BFF used to send.

    Kept as a regression: if aliases are ever added to make this "work", the
    ambiguity that caused a year of silent 422s comes back with it.
    """
    with pytest.raises(ValidationError):
        InternalExecuteRequest(
            tenantId="t",
            planId="p",
            correlationId="c",
            actionIds=["a"],
            mode="batch",
            concurrency=1,
            stopOnFailure=True,
            approvalToken={},
        )


def test_unknown_fields_are_refused(payload: dict) -> None:
    # `extra="forbid"`: a field the runtime does not declare is a refusal, not
    # something silently dropped on the floor.
    with pytest.raises(ValidationError):
        InternalExecuteRequest(**{**payload, "unexpected_field": "x"})


@pytest.mark.parametrize(
    "missing",
    [
        "contract_version",
        "tenant_id",
        "plan_id",
        "correlation_id",
        "action_ids",
        "request_key",
        # v2. A dispatch without the approved snapshot is a dispatch the
        # executor cannot verify before mutating a client estate, so the
        # contract refuses it rather than letting the executor decide.
        "content_digest",
    ],
)
def test_required_fields_are_required(payload: dict, missing: str) -> None:
    incomplete = {k: v for k, v in payload.items() if k != missing}
    with pytest.raises(ValidationError):
        InternalExecuteRequest(**incomplete)


def test_stub_refuses_execution_instead_of_claiming_responsibility(payload: dict) -> None:
    from types import SimpleNamespace

    from fastapi.testclient import TestClient

    from axiom.app import app

    # Do not start unrelated model/storage clients: this exercises the real
    # HTTP endpoint and its internal authentication, not just the Pydantic type.
    app.state.settings = SimpleNamespace(internal_token="test-internal")
    client = TestClient(app)
    assert client.post("/internal/execute", json=payload).status_code == 401
    response = client.post(
        "/internal/execute", json=payload, headers={"X-Internal-Token": "test-internal"}
    )
    assert response.status_code == 501
    assert response.json() == {
        "accepted": False,
        "contract_version": EXECUTION_CONTRACT_VERSION,
        "correlation_id": payload["correlation_id"],
        "reason": "execution_not_implemented",
    }
