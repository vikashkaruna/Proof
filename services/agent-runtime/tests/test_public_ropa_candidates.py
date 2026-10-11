"""Component proof only: retained-source ownership and receipt verification stay server gates."""

from copy import deepcopy

import pytest
from pydantic import ValidationError
from test_public_source_agents import agent_fixture, classification_input

from axiom.agents.public_source import PublicSourceBinding, VibhaagPublicInput, VibhaagPublicOutput
from axiom.agents.vibhaag import VibhaagAgent
from axiom.public_ropa_candidates import PublicRopaCandidate, build_public_ropa_candidates


async def inputs():
    raw = await classification_input()
    result = await agent_fixture(VibhaagAgent).invoke(raw)
    assert result.status == "succeeded"
    return VibhaagPublicInput.model_validate(raw), VibhaagPublicOutput.model_validate(result.output)


@pytest.mark.asyncio
async def test_actual_agents_build_one_candidate_per_form_without_private_facts():
    source, output = await inputs()
    candidates = build_public_ropa_candidates(
        source, output, expected_binding=source.source_binding
    )
    assert candidates.source_binding == source.observation.binding
    assert candidates.unexamined_pages == ["privacy"]
    assert candidates.unavailable_pages == ["terms"]
    assert len(candidates.candidates) == 1
    candidate = candidates.candidates[0]
    assert candidate.page == "contact"
    assert candidate.content_sha256 == "b" * 64
    assert candidate.form_ordinal == 1
    assert candidate.form_method == "post"
    assert [control.inputType for control in candidate.observed_controls] == ["email", "tel"]
    assert candidate.observed_controls[1].disabledAttribute is True
    assert candidate.observed_control_count == 5
    assert candidate.excluded_control_count == 1
    assert candidate.status == "unpublished_review_candidate"
    assert candidate.requires_human_review is True
    private = [
        "personal_data_processing",
        "purpose",
        "data_categories",
        "data_principals",
        "processors",
        "recipients",
        "lawful_basis",
        "retention_period",
        "hosting_region",
        "cross_border",
        "destination_countries",
        "transfer_safeguards",
    ]
    assert all(candidate.model_dump()[key] is None for key in private)
    assert '"processors":null' in candidate.model_dump_json()
    assert "no submission" in candidates.limitations


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field", ["tenant_id", "engagement_id", "check_id", "root_content_sha256", "projection_sha256"]
)
async def test_expected_binding_changes_refuse(field):
    source, output = await inputs()
    raw = source.source_binding.model_dump()
    raw[field] = "e" * 64 if field.endswith("sha256") else "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
    with pytest.raises(ValueError, match="binding mismatch"):
        build_public_ropa_candidates(
            source, output, expected_binding=PublicSourceBinding.model_validate(raw)
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation",
    [
        "add",
        "remove",
        "digest",
        "type",
        "form",
        "control",
        "order",
        "coverage",
        "classification_binding",
    ],
)
async def test_classification_drift_refused(mutation):
    source, output = await inputs()
    raw = deepcopy(output.model_dump())
    if mutation == "add":
        extra = deepcopy(raw["indicators"][0])
        extra["control_ordinal"] = 4
        raw["indicators"].append(extra)
    elif mutation == "remove":
        raw["indicators"].pop()
    elif mutation == "order":
        raw["indicators"].reverse()
    elif mutation == "coverage":
        raw["unexamined_pages"] = []
    elif mutation == "classification_binding":
        raw["source_binding"]["projection_sha256"] = "e" * 64
    else:
        field, value = {
            "digest": ("content_sha256", "e" * 64),
            "type": ("input_type", "tel"),
            "form": ("form_ordinal", 2),
            "control": ("control_ordinal", 4),
        }[mutation]
        raw["indicators"][0][field] = value
    changed = VibhaagPublicOutput.model_validate(raw)
    with pytest.raises(ValueError, match=r"binding mismatch|classification does not match"):
        build_public_ropa_candidates(source, changed, expected_binding=source.source_binding)


@pytest.mark.asyncio
async def test_no_contact_indicator_is_not_a_none_processing_declaration():
    source, _ = await inputs()
    raw = source.model_dump()
    controls = raw["observation"]["pages"][1]["form_metadata"]["forms"][0]["controls"]
    controls[0]["inputType"] = "text"
    controls[1]["inputType"] = "text"
    result = await agent_fixture(VibhaagAgent).invoke(raw)
    source = VibhaagPublicInput.model_validate(raw)
    output = VibhaagPublicOutput.model_validate(result.output)
    candidates = build_public_ropa_candidates(
        source, output, expected_binding=source.source_binding
    )
    assert candidates.candidates == []
    assert "absence of processing" in candidates.limitations
    assert "bounded observation" in candidates.empty_result_means


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("processors", []),
        ("cross_border", False),
        ("purpose", "Marketing"),
        ("personal_data_processing", True),
        ("status", "published"),
        ("requires_human_review", False),
    ],
)
async def test_candidate_contract_rejects_promoted_private_facts(field, value):
    source, output = await inputs()
    raw = (
        build_public_ropa_candidates(source, output, expected_binding=source.source_binding)
        .candidates[0]
        .model_dump()
    )
    raw[field] = value
    with pytest.raises(ValidationError):
        PublicRopaCandidate.model_validate(raw)


@pytest.mark.asyncio
async def test_truncated_source_remains_bounded_and_visible():
    source, _ = await inputs()
    raw = source.model_dump()
    meta = raw["observation"]["pages"][1]["form_metadata"]
    form = meta["forms"][0]
    form["observedControlCount"] = 14
    form["controlsTruncated"] = True
    form["controls"] += [
        {
            "ordinal": index,
            "element": "input",
            "inputType": "text",
            "requiredAttribute": False,
            "disabledAttribute": False,
        }
        for index in range(5, 13)
    ]
    result = await agent_fixture(VibhaagAgent).invoke(raw)
    assert result.status == "succeeded"
    source = VibhaagPublicInput.model_validate(raw)
    output = VibhaagPublicOutput.model_validate(result.output)
    candidate = build_public_ropa_candidates(
        source, output, expected_binding=source.source_binding
    ).candidates[0]
    assert candidate.controls_truncated is True
    assert candidate.observed_control_count == 14
    assert len(candidate.observed_controls) == 2
    assert candidate.personal_data_processing is None
