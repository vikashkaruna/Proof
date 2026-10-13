"""Actual public-source agent work and refusals, without a database authority claim."""

from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from axiom.agents.base import AgentName, DispatchContext
from axiom.agents.drishti import DrishtiAgent, DrishtiInput, DrishtiInvocationInput, DrishtiOutput
from axiom.agents.public_source import (
    MAX_COUNT,
    DrishtiPublicOutput,
    PublicFormMetadata,
    VibhaagPublicOutput,
)
from axiom.agents.vibhaag import VibhaagAgent, VibhaagInput, VibhaagOutput
from axiom.app import app

# Explicit independent synthetic tenant; no default production identity.
SYNTHETIC_TENANT_ID = "47480000-0000-4000-8000-000000000005"

TENANT = "a0000000-0000-4000-8000-000000000001"
ENGAGEMENT = "b0000000-0000-4000-8000-000000000002"
CHECK = "c0000000-0000-4000-8000-000000000003"
RUN = "d0000000-0000-4000-8000-000000000004"
CORRELATION = "e0000000-0000-4000-8000-000000000005"


def binding():
    return {
        "tenant_id": TENANT,
        "engagement_id": ENGAGEMENT,
        "check_id": CHECK,
        "root_content_sha256": "a" * 64,
        "projection_sha256": "c" * 64,
        "projection_version": 1,
    }


def control(ordinal, input_type="text", *, element="input", required=False, disabled=False):
    return {
        "ordinal": ordinal,
        "element": element,
        **({"inputType": input_type} if element == "input" else {}),
        "requiredAttribute": required,
        "disabledAttribute": disabled,
    }


def metadata(digest="a" * 64, *, forms=None, observed_form_count=None):
    forms = [] if forms is None else forms
    count = len(forms) if observed_form_count is None else observed_form_count
    return {
        "version": 1,
        "scope": "static_html_form_descendants",
        "sourceSha256": digest,
        "observedFormCount": count,
        "formsTruncated": count > 3,
        "forms": forms,
    }


def form(*, ordinal=1, controls=None, observed=None, excluded=0):
    controls = [] if controls is None else controls
    count = len(controls) + excluded if observed is None else observed
    return {
        "ordinal": ordinal,
        "method": "post",
        "observedControlCount": count,
        "excludedControlCount": excluded,
        "controlsTruncated": count - excluded > 12,
        "controls": controls,
    }


def discovery_input():
    return {
        "mode": "public_website",
        "tenant_id": TENANT,
        "engagement_id": ENGAGEMENT,
        "source": {
            "version": 1,
            "binding": binding(),
            "pages": [
                {
                    "page": "root",
                    "status": "checked",
                    "content_sha256": "a" * 64,
                    "form_metadata": metadata(),
                },
                {
                    "page": "contact",
                    "status": "checked",
                    "content_sha256": "b" * 64,
                    "form_metadata": metadata(
                        "b" * 64,
                        forms=[
                            form(
                                controls=[
                                    control(1, "email", required=True),
                                    control(2, "tel", disabled=True),
                                    control(3, element="textarea"),
                                    control(4),
                                ],
                                excluded=1,
                            )
                        ],
                    ),
                },
                {"page": "privacy", "status": "checked", "content_sha256": "d" * 64},
                {"page": "terms", "status": "unavailable"},
            ],
        },
    }


def agent_fixture(agent_type, *, append=None):
    ledger = SimpleNamespace(
        append=append or AsyncMock(side_effect=[SimpleNamespace(id="1"), SimpleNamespace(id="2")])
    )
    evidence = SimpleNamespace(write=AsyncMock())
    gateway = SimpleNamespace(invoke=AsyncMock())
    return agent_type(ledger=ledger, evidence=evidence, model_gateway=gateway)


async def classification_input():
    result = await agent_fixture(DrishtiAgent).invoke(discovery_input())
    assert result.status == "succeeded"
    return {
        "mode": "public_website",
        "tenant_id": TENANT,
        "engagement_id": ENGAGEMENT,
        "source_binding": binding(),
        "observation": result.output["observation"],
    }


@pytest.mark.asyncio
async def test_actual_discovery_to_classification_preserves_source_and_unknown_private_facts(
    monkeypatch,
):
    def forbidden_legacy_inference(*_args):
        pytest.fail("Public facts must not use private inventory inference")

    monkeypatch.setattr(
        "axiom.agents.drishti.evaluate_residency_and_cross_border", forbidden_legacy_inference
    )
    monkeypatch.setattr("axiom.agents.vibhaag.pattern_classify", forbidden_legacy_inference)
    payload = discovery_input()
    original = deepcopy(payload)
    drishti = agent_fixture(DrishtiAgent)
    result = await drishti.invoke(payload, correlation_id=CORRELATION)
    assert result.status == "succeeded"
    assert payload == original
    output = DrishtiPublicOutput.model_validate(result.output)
    observation = output.observation
    assert observation.binding.model_dump() == binding()
    assert observation.requires_human_review is True
    assert observation.private_facts.model_dump() == {
        "hosting_region": "unknown",
        "backend_personal_data": "unknown",
        "cross_border_processing": "unknown",
    }
    assert [page.form_state for page in observation.pages] == [
        "observed",
        "observed",
        "unexamined",
        "unavailable",
    ]
    assert observation.pages[0].form_metadata.observedFormCount == 0
    assert observation.pages[1].form_metadata.forms[0].excludedControlCount == 1
    assert "form_metadata" not in result.output["observation"]["pages"][2]
    assert result.output["observation"]["pages"][3] == {
        "page": "terms",
        "status": "unavailable",
        "form_state": "unavailable",
    }
    assert (
        "inputType"
        not in result.output["observation"]["pages"][1]["form_metadata"]["forms"][0]["controls"][2]
    )
    vibhaag = agent_fixture(VibhaagAgent)
    classified = await vibhaag.invoke(
        {
            "mode": "public_website",
            "tenant_id": TENANT,
            "engagement_id": ENGAGEMENT,
            "source_binding": binding(),
            "observation": result.output["observation"],
        }
    )
    assert classified.status == "succeeded"
    classification = VibhaagPublicOutput.model_validate(classified.output)
    assert classification.source_binding == observation.binding
    assert classification.private_facts == observation.private_facts
    assert classification.unexamined_pages == ["privacy"]
    assert classification.unavailable_pages == ["terms"]
    assert classification.scope_limited is True
    assert [item.model_dump() for item in classification.indicators] == [
        {
            "page": "contact",
            "content_sha256": "b" * 64,
            "form_ordinal": 1,
            "control_ordinal": ordinal,
            "input_type": input_type,
            "indicator": "potential_contact_collection",
            "requires_human_review": True,
        }
        for ordinal, input_type in [(1, "email"), (2, "tel")]
    ]
    for agent in (drishti, vibhaag):
        assert agent.ledger.append.await_count == 2
        agent.evidence.write.assert_not_called()
        agent.model_gateway.invoke.assert_not_called()
    assert "inventory" not in result.output
    assert "classifications" not in classified.output


@pytest.mark.asyncio
async def test_uuid_normalization_matches_envelope_binding_and_actual_ledger_context():
    payload = discovery_input()
    payload["tenant_id"] = TENANT.upper()
    payload["engagement_id"] = ENGAGEMENT.upper()
    payload["source"]["binding"]["check_id"] = CHECK.upper()
    agent = agent_fixture(DrishtiAgent)
    rejected = await agent.invoke(
        payload, dispatch_context=DispatchContext(run_id=RUN, request_hash="f" * 64)
    )
    assert rejected.status == "failed"
    assert rejected.error == "validation_failed"
    agent.ledger.append.assert_not_called()
    payload["tenant_id"] = TENANT
    result = await agent.invoke(
        payload, dispatch_context=DispatchContext(run_id=RUN, request_hash="f" * 64)
    )
    assert result.status == "succeeded"
    assert result.output["observation"]["binding"] == binding()
    for call in agent.ledger.append.await_args_list:
        receipt = call.args[0]
        assert receipt.tenant_id == TENANT
        assert receipt.target_ref == ENGAGEMENT
        assert receipt.detail["run_id"] == RUN
        assert receipt.detail["request_hash"] == "f" * 64


@pytest.mark.asyncio
async def test_explicit_public_root_model_tenant_remains_supported():
    agent = agent_fixture(DrishtiAgent)
    model = DrishtiInvocationInput.model_validate(discovery_input())
    result = await agent.invoke(model)
    assert result.status == "succeeded"
    assert [call.args[0].tenant_id for call in agent.ledger.append.await_args_list] == [
        TENANT,
        TENANT,
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", [None, "legacy_inventory"])
@pytest.mark.parametrize(
    ("agent_type", "public_field"),
    [(DrishtiAgent, "source"), (VibhaagAgent, "observation"), (VibhaagAgent, "source_binding")],
)
async def test_public_facts_cannot_fall_back_to_legacy_mode(agent_type, public_field, mode):
    payload = {"tenant_id": TENANT, "engagement_id": ENGAGEMENT, public_field: {}}
    if mode is not None:
        payload["mode"] = mode
    agent = agent_fixture(agent_type)
    result = await agent.invoke(payload)
    assert result.status == "failed"
    assert result.error == "validation_failed"
    assert result.output is None
    agent.ledger.append.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("interview", {}),
        ("systems", []),
        ("inventory", []),
        ("field_hints", {}),
        ("title", "Singapore Frankfurt us-east-1"),
        ("description", "Public article about US customers"),
    ],
)
async def test_public_discovery_rejects_legacy_fields_and_geographic_text(field, value):
    payload = discovery_input()
    payload[field] = value
    agent = agent_fixture(DrishtiAgent)
    result = await agent.invoke(payload)
    assert result.error == "validation_failed"
    assert result.output is None
    agent.ledger.append.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [("inventory", []), ("field_hints", {}), ("source", {}), ("systems", []), ("interview", {})],
)
async def test_public_classification_rejects_legacy_inputs_and_arbitrary_hints(field, value):
    payload = await classification_input()
    payload[field] = value
    agent = agent_fixture(VibhaagAgent)
    result = await agent.invoke(payload)
    assert result.error == "validation_failed"
    agent.ledger.append.assert_not_called()


def assign(payload, path, value):
    target = payload
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("mode",), "unsupported"),
        (("tenant_id",), "not-a-uuid"),
        (("tenant_id",), CHECK),
        (("engagement_id",), CHECK),
        (("source", "binding", "tenant_id"), CHECK),
        (("source", "binding", "engagement_id"), CHECK),
        (("source", "binding", "check_id"), 123),
        (("source", "binding", "root_content_sha256"), "f" * 64),
        (("source", "binding", "projection_sha256"), "C" * 64),
        (("source", "binding", "projection_version"), True),
        (("source", "version"), "1"),
        (("source", "version"), 2),
        (("source", "pages"), []),
        (("source", "pages", 0, "page"), "privacy"),
        (("source", "pages", 0, "content_sha256"), "f" * 64),
        (("source", "pages", 1, "page"), "root"),
        (("source", "pages", 1, "content_sha256"), "f" * 64),
        (("source", "pages", 3, "form_metadata"), metadata()),
        (("source", "pages", 3, "content_sha256"), "a" * 64),
        (("source", "pages", 0, "title"), "Singapore Frankfurt London"),
        (("source", "pages", 0, "form_metadata", "observedFormCount"), 1),
        (("source", "pages", 1, "form_metadata", "sourceSha256"), "f" * 64),
        (
            ("source", "pages", 1, "form_metadata", "forms", 0, "controls", 0, "name"),
            "private-sentinel",
        ),
        (
            ("source", "pages", 1, "form_metadata", "forms", 0, "controls", 0, "label"),
            "private-sentinel",
        ),
        (
            ("source", "pages", 1, "form_metadata", "forms", 0, "controls", 0, "value"),
            "private-sentinel",
        ),
        (("source", "pages", 1, "form_metadata", "forms", 0, "action"), "private-sentinel"),
        (
            ("source", "pages", 1, "form_metadata", "forms", 0, "controls", 0, "requiredAttribute"),
            "false",
        ),
        (
            ("source", "pages", 1, "form_metadata", "forms", 0, "controls", 0, "disabledAttribute"),
            1,
        ),
    ],
)
async def test_malformed_or_wrong_bound_discovery_refuses_before_work_and_ledger(path, value):
    payload = discovery_input()
    assign(payload, path, value)
    agent = agent_fixture(DrishtiAgent)
    work = AsyncMock()
    agent._run = work
    result = await agent.invoke(payload)
    assert result.status == "failed"
    assert result.error == "validation_failed"
    assert result.output is None
    assert result.ledger_entry_ids == []
    work.assert_not_called()
    agent.ledger.append.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("tenant_id", CHECK),
        ("engagement_id", CHECK),
        ("check_id", TENANT),
        ("root_content_sha256", "f" * 64),
        ("projection_sha256", "f" * 64),
        ("projection_version", 2),
    ],
)
async def test_classification_expected_binding_cannot_be_substituted(field, value):
    payload = await classification_input()
    payload["source_binding"][field] = value
    agent = agent_fixture(VibhaagAgent)
    result = await agent.invoke(payload)
    assert result.error == "validation_failed"
    agent.ledger.append.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("hosting_region", "ap-south-1"),
        ("hosting_region", "Singapore"),
        ("backend_personal_data", False),
        ("backend_personal_data", True),
        ("cross_border_processing", False),
        ("cross_border_processing", True),
    ],
)
async def test_discovery_private_unknowns_cannot_be_replaced_with_claims(field, value):
    payload = await classification_input()
    payload["observation"]["private_facts"][field] = value
    agent = agent_fixture(VibhaagAgent)
    result = await agent.invoke(payload)
    assert result.error == "validation_failed"
    agent.ledger.append.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("value", [False, 1, "true", None])
async def test_human_review_requirement_is_strict_true(value):
    payload = await classification_input()
    payload["observation"]["requires_human_review"] = value
    agent = agent_fixture(VibhaagAgent)
    result = await agent.invoke(payload)
    assert result.error == "validation_failed"
    agent.ledger.append.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("page_index", "state"), [(0, "unexamined"), (2, "observed"), (3, "observed")]
)
async def test_observed_zero_unexamined_and_unavailable_cannot_be_interchanged(page_index, state):
    payload = await classification_input()
    payload["observation"]["pages"][page_index]["form_state"] = state
    result = await agent_fixture(VibhaagAgent).invoke(payload)
    assert result.error == "validation_failed"


@pytest.mark.asyncio
async def test_truncated_forms_controls_and_excluded_ordinals_are_preserved():
    payload = discovery_input()
    controls = [control(index + 2, "email" if index == 0 else "text") for index in range(12)]
    truncated_forms = [
        form(ordinal=index + 1, controls=controls, observed=15, excluded=2) for index in range(3)
    ]
    payload["source"]["pages"][1]["form_metadata"] = metadata(
        "b" * 64, forms=truncated_forms, observed_form_count=8
    )
    observed = await agent_fixture(DrishtiAgent).invoke(payload)
    assert observed.status == "succeeded"
    retained = observed.output["observation"]["pages"][1]["form_metadata"]
    assert retained == payload["source"]["pages"][1]["form_metadata"]
    assert retained["formsTruncated"] is True
    assert all(item["controlsTruncated"] is True for item in retained["forms"])
    classified = await agent_fixture(VibhaagAgent).invoke(
        {
            "mode": "public_website",
            "tenant_id": TENANT,
            "engagement_id": ENGAGEMENT,
            "source_binding": binding(),
            "observation": observed.output["observation"],
        }
    )
    assert classified.status == "succeeded"
    assert [item["control_ordinal"] for item in classified.output["indicators"]] == [2, 2, 2]
    assert [item["form_ordinal"] for item in classified.output["indicators"]] == [1, 2, 3]
    assert classified.output["scope_limited"] is True


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("version",), True),
        (("scope",), "dynamic_dom"),
        (("observedFormCount",), -1),
        (("observedFormCount",), MAX_COUNT + 1),
        (("observedFormCount",), "1"),
        (("formsTruncated",), "false"),
        (("formsTruncated",), True),
        (("forms", 0, "ordinal"), 2),
        (("forms", 0, "method"), "connect"),
        (("forms", 0, "observedControlCount"), MAX_COUNT + 1),
        (("forms", 0, "observedControlCount"), 0),
        (("forms", 0, "excludedControlCount"), 2),
        (("forms", 0, "controlsTruncated"), True),
        (("forms", 0, "controls", 0, "ordinal"), 0),
        (("forms", 0, "controls", 0, "ordinal"), 2),
        (("forms", 0, "controls", 0, "inputType"), "password"),
        (("forms", 0, "controls", 0, "element"), "button"),
        (("forms", 0, "controls", 0, "element"), "select"),
    ],
)
def test_shared_metadata_bounds_and_semantics_are_enforced(path, value):
    payload = metadata(forms=[form(controls=[control(1)])])
    assign(payload, path, value)
    with pytest.raises(ValidationError):
        PublicFormMetadata.model_validate(payload)


@pytest.mark.parametrize(
    "input_type",
    [
        "text",
        "email",
        "tel",
        "url",
        "search",
        "number",
        "date",
        "datetime-local",
        "time",
        "month",
        "week",
        "color",
        "range",
        "checkbox",
        "radio",
    ],
)
def test_shared_supported_input_types_retain_original_wire_names(input_type):
    payload = metadata(forms=[form(controls=[control(1, input_type)])])
    assert PublicFormMetadata.model_validate(payload).model_dump() == payload


@pytest.mark.asyncio
async def test_maximum_bounded_public_work_and_no_category_or_confidence_claims():
    payload = discovery_input()
    payload["source"]["pages"] = [
        {
            "page": page,
            "status": "checked",
            "content_sha256": "a" * 64,
            "form_metadata": metadata(
                forms=[
                    form(
                        ordinal=index + 1,
                        controls=[control(ordinal + 1, "email") for ordinal in range(12)],
                        observed=MAX_COUNT,
                        excluded=0,
                    )
                    for index in range(3)
                ],
                observed_form_count=MAX_COUNT,
            ),
        }
        for page in ["root", "privacy", "contact", "terms"]
    ]
    result = await agent_fixture(DrishtiAgent).invoke(payload)
    assert result.status == "succeeded"
    classified = await agent_fixture(VibhaagAgent).invoke(
        {
            "mode": "public_website",
            "tenant_id": TENANT,
            "engagement_id": ENGAGEMENT,
            "source_binding": binding(),
            "observation": result.output["observation"],
        }
    )
    assert classified.status == "succeeded"
    assert len(classified.output["indicators"]) == 144
    assert all(
        "category" not in item
        and "confidence" not in item
        and item["requires_human_review"] is True
        for item in classified.output["indicators"]
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("agent_type", "legacy_input", "legacy_output"),
    [
        (DrishtiAgent, DrishtiInput, DrishtiOutput),
        (VibhaagAgent, VibhaagInput, VibhaagOutput),
    ],
)
async def test_explicit_legacy_mode_preserves_existing_wire_output_and_input_hash(
    agent_type, legacy_input, legacy_output
):
    payload = {"tenant_id": SYNTHETIC_TENANT_ID, "engagement_id": "legacy-engagement"}
    original_agent = agent_fixture(agent_type)
    original = await original_agent.invoke(legacy_input.model_validate(payload))
    explicit_agent = agent_fixture(agent_type)
    explicit = await explicit_agent.invoke({**payload, "mode": "legacy_inventory"})
    assert original.status == explicit.status == "succeeded"
    assert original.output == explicit.output
    legacy_output.model_validate(explicit.output)
    assert "mode" not in explicit.output
    assert (
        original_agent.ledger.append.await_args_list[0].args[0].input_hash
        == explicit_agent.ledger.append.await_args_list[0].args[0].input_hash
    )


@pytest.mark.asyncio
async def test_projection_digest_is_an_opaque_domain_not_recomputed_from_python_json():
    payload = discovery_input()
    payload["source"]["binding"]["projection_sha256"] = "e" * 64
    result = await agent_fixture(DrishtiAgent).invoke(payload)
    assert result.status == "succeeded"
    assert result.output["observation"]["binding"]["projection_sha256"] == "e" * 64


@pytest.mark.parametrize("agent_name", [AgentName.DRISHTI, AgentName.VIBHAAG])
def test_generic_http_cannot_run_public_mode_before_dedicated_source_composition(
    monkeypatch, agent_name
):
    agent = agent_fixture(DrishtiAgent if agent_name == AgentName.DRISHTI else VibhaagAgent)
    work = AsyncMock()
    monkeypatch.setattr(agent, "invoke", work)
    monkeypatch.setattr(
        app.state,
        "settings",
        SimpleNamespace(internal_token="public-source-fixture"),
        raising=False,
    )
    monkeypatch.setattr(app.state, "agents", {agent_name: agent}, raising=False)
    response = TestClient(app).post(
        f"/agents/{agent_name.value}/invoke",
        json={
            "correlation_id": CORRELATION,
            "input": {**discovery_input(), "extra": "private-sentinel"},
        },
        headers={"X-Internal-Token": "public-source-fixture"},
    )
    assert response.status_code == 200
    assert response.json() == {
        "agent": agent_name.value,
        "correlation_id": CORRELATION,
        "status": "failed",
        "latency_ms": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cost_usd": 0,
        "error": "public_source_workflow_required",
        "output": None,
        "ledger_entry_ids": [],
    }
    assert "private-sentinel" not in response.text
    work.assert_not_called()
    agent.ledger.append.assert_not_called()
    without_correlation = TestClient(app).post(
        f"/agents/{agent_name.value}/invoke",
        json={"input": discovery_input()},
        headers={"X-Internal-Token": "public-source-fixture"},
    )
    assert without_correlation.status_code == 200
    assert (
        str(UUID(without_correlation.json()["correlation_id"]))
        == without_correlation.json()["correlation_id"]
    )
    work.assert_not_called()
    denied = TestClient(app).post(
        f"/agents/{agent_name.value}/invoke", json={"input": discovery_input()}
    )
    assert denied.status_code == 401
    work.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("agent_type", [DrishtiAgent, VibhaagAgent])
async def test_public_mode_preserves_mandatory_start_and_completion_receipts(agent_type):
    payload = discovery_input() if agent_type is DrishtiAgent else await classification_input()
    start_failure = AsyncMock(side_effect=RuntimeError("private-sentinel"))
    result = await agent_fixture(agent_type, append=start_failure).invoke(payload)
    assert result.error == "ledger_append_failed"
    assert result.output is None
    completion_failure = AsyncMock(
        side_effect=[
            SimpleNamespace(id="1"),
            RuntimeError("private-sentinel"),
            SimpleNamespace(id="3"),
        ]
    )
    result = await agent_fixture(agent_type, append=completion_failure).invoke(payload)
    assert result.error == "audit_completion_failed"
    assert result.output is None
    assert result.ledger_entry_ids == ["1", "3"]


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", [None, True, 1, {}, []])
async def test_non_string_modes_do_not_select_public_or_legacy_execution(mode):
    payload = discovery_input()
    payload["mode"] = mode
    agent = agent_fixture(DrishtiAgent)
    result = await agent.invoke(payload)
    assert result.error == "validation_failed"
    agent.ledger.append.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [
        "too_many_pages",
        "root_unavailable",
        "metadata_without_digest",
        "duplicate_control_ordinal",
        "too_many_controls",
        "too_many_forms",
        "missing_input_type",
        "required_numeric",
        "negative_excluded",
    ],
)
async def test_additional_source_bounds_prevent_unbounded_or_impossible_work(case):
    payload = discovery_input()
    pages = payload["source"]["pages"]
    contact = pages[1]["form_metadata"]
    controls = contact["forms"][0]["controls"]
    if case == "too_many_pages":
        pages.append(deepcopy(pages[0]))
    elif case == "root_unavailable":
        pages[0] = {"page": "root", "status": "unavailable"}
    elif case == "metadata_without_digest":
        pages[1].pop("content_sha256")
    elif case == "duplicate_control_ordinal":
        controls[1]["ordinal"] = controls[0]["ordinal"]
    elif case == "too_many_controls":
        contact["forms"][0] = form(controls=[control(index + 1) for index in range(13)])
    elif case == "too_many_forms":
        contact.update(metadata("b" * 64, forms=[form(ordinal=index + 1) for index in range(4)]))
    elif case == "missing_input_type":
        controls[0].pop("inputType")
    elif case == "required_numeric":
        controls[0]["requiredAttribute"] = 0
    else:
        contact["forms"][0]["excludedControlCount"] = -1
    agent = agent_fixture(DrishtiAgent)
    result = await agent.invoke(payload)
    assert result.error == "validation_failed"
    agent.ledger.append.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [
        "duplicate_indicator",
        "duplicate_unexamined",
        "duplicate_unavailable",
        "overlapping_coverage",
        "indicator_on_unexamined",
        "review_number",
        "scope_string",
        "confidence_claim",
        "category_claim",
    ],
)
async def test_classification_output_contract_rejects_unsupported_claims_and_coverage(case):
    result = await agent_fixture(VibhaagAgent).invoke(await classification_input())
    assert result.status == "succeeded"
    output = deepcopy(result.output)
    if case == "duplicate_indicator":
        output["indicators"].append(deepcopy(output["indicators"][0]))
    elif case == "duplicate_unexamined":
        output["unexamined_pages"].append("privacy")
    elif case == "duplicate_unavailable":
        output["unavailable_pages"].append("terms")
    elif case == "overlapping_coverage":
        output["unavailable_pages"].append("privacy")
    elif case == "indicator_on_unexamined":
        output["unexamined_pages"].append("contact")
    elif case == "review_number":
        output["indicators"][0]["requires_human_review"] = 1
    elif case == "scope_string":
        output["scope_limited"] = "true"
    elif case == "confidence_claim":
        output["indicators"][0]["confidence"] = 0.99
    else:
        output["indicators"][0]["category"] = "contact"
    with pytest.raises(ValidationError):
        VibhaagPublicOutput.model_validate(output)


@pytest.mark.asyncio
async def test_legacy_classification_rules_and_sensitive_category_review_remain_available():
    agent = agent_fixture(VibhaagAgent)
    result = await agent.invoke(
        {
            "tenant_id": SYNTHETIC_TENANT_ID,
            "engagement_id": "legacy-engagement",
            "inventory": [{"name": "Confirmed CRM"}],
            "field_hints": {
                "Confirmed CRM": {
                    "fields": [
                        "email",
                        "unrecognised",
                        {"name": "guardian", "category": "children"},
                        {"name": "phone"},
                    ]
                }
            },
        }
    )
    assert result.status == "succeeded"
    output = VibhaagOutput.model_validate(result.output)
    assert [field.category for field in output.classifications] == [
        "contact",
        "other",
        "children",
        "contact",
    ]
    assert output.classifications[1].needs_review is True
    assert output.escalate is True
    inferred = await agent_fixture(VibhaagAgent).invoke(
        {
            "tenant_id": SYNTHETIC_TENANT_ID,
            "engagement_id": "legacy-engagement",
            "inventory": [
                {"name": "Confirmed CRM", "data_categories": ["health", "contact", "unrecognised"]}
            ],
        }
    )
    assert inferred.status == "succeeded"
    coarse = VibhaagOutput.model_validate(inferred.output)
    assert [item.category for item in coarse.classifications] == ["health", "contact"]
    assert all(item.confidence == 0.6 and item.needs_review for item in coarse.classifications)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path",
    [
        ("source", "pages", 2, "form_metadata"),
        ("source", "pages", 1, "form_metadata", "forms", 0, "controls", 2, "inputType"),
    ],
)
async def test_missing_optional_attributes_must_be_absent_rather_than_null(path):
    payload = discovery_input()
    assign(payload, path, None)
    result = await agent_fixture(DrishtiAgent).invoke(payload)
    assert result.error == "validation_failed"
