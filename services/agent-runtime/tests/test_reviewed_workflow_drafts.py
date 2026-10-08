"""Actual credentialless draft work; caller-shaped input is not DB authority."""

import hashlib
import json
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from axiom.agents.base import AgentName
from axiom.agents.reviewed_workflow_agent import VibhaagReviewDraftAgent
from axiom.agents.reviewed_workflows import (
    ReviewedWorkflowInput,
    ReviewedWorkflowOutput,
    build_reviewed_workflow_drafts,
)
from axiom.agents.vibhaag import VibhaagInput
from axiom.app import app
from axiom.canonicalise import canonical_json
from axiom.policy_generator import (
    build_consent_notice,
    build_dpa_template,
    build_privacy_notice,
    build_retention_policy,
)
from axiom.ropa_generator import build_ropa_records

TENANT = "a0000000-0000-4000-8000-000000000001"
ENGAGEMENT = "b0000000-0000-4000-8000-000000000002"
ACTOR = "c0000000-0000-4000-8000-000000000003"
CORRELATION = "d0000000-0000-4000-8000-000000000004"


def processing_record():
    return {
        "id": "e0000000-0000-4000-8000-000000000005",
        "tenant_id": TENANT,
        "operation_key": "f0000000-0000-4000-8000-000000000006",
        "created_by": ACTOR,
        "created_at": "2026-10-08T02:00:00.000001Z",
        "content_sha256": None,
        "receipt_id": "1",
        "kind": "ropa",
        "payload": {
            "engagementId": ENGAGEMENT,
            "sourceNote": "Human reviewed public website context; private facts unresolved",
            "source": {
                "observationId": "10000000-0000-4000-8000-000000000007",
                "outputSha256": "a" * 64,
            },
            "system": "axiomminds.ai public contact review",
            "purpose": None,
            "legalBasis": None,
            "retentionMonths": None,
            "dataCategories": None,
            "dataPrincipals": [],
            "processors": [],
            "recipients": None,
            "destinationCountries": [],
            "transferSafeguards": None,
            "dpiaRequired": False,
            "region": None,
            "crossBorder": False,
            "securityMeasures": None,
        },
    }


def task_record(number=8, *, duration=5, repetitions=2):
    return {
        "id": f"20000000-0000-4000-8000-{number:012d}",
        "tenant_id": TENANT,
        "operation_key": f"30000000-0000-4000-8000-{number:012d}",
        "created_by": ACTOR,
        "created_at": "2026-10-08T02:00:00.000002+00:00",
        "content_sha256": None,
        "receipt_id": str(number),
        "kind": "delivery_task",
        "payload": {
            "engagementId": ENGAGEMENT,
            "taskName": f"Measured task {number}",
            "source": "Human timing observation",
            "durationMinutes": duration,
            "repetitions": repetitions,
            "notes": "",
        },
    }


def payload(records=None):
    records = [processing_record(), task_record()] if records is None else records
    return {
        "schema_version": 1,
        "mode": "reviewed_workflow",
        "tenant_id": TENANT,
        "engagement_id": ENGAGEMENT,
        "source_records_sha256": hashlib.sha256(canonical_json(records).encode()).hexdigest(),
        "records": records,
    }


def refresh_digest(value):
    value["source_records_sha256"] = hashlib.sha256(
        canonical_json(value["records"]).encode()
    ).hexdigest()
    return value


def agent():
    append = AsyncMock(side_effect=[SimpleNamespace(id="31"), SimpleNamespace(id="32")])
    narrow = SimpleNamespace(append=append)
    ledger = SimpleNamespace(append_only_view=lambda: narrow)
    return VibhaagReviewDraftAgent(
        ledger=ledger, evidence=object(), model_gateway=object(), settings=object()
    )


@pytest.mark.asyncio
async def test_actual_agent_preserves_every_declaration_and_receipt_without_domain_credentials():
    value = payload()
    original = deepcopy(value)
    instance = agent()
    assert not hasattr(instance, "settings")
    assert not hasattr(instance, "evidence")
    assert not hasattr(instance, "model_gateway")
    assert not hasattr(instance.ledger, "load_public_source_dispatch")
    assert instance.can_mutate is instance.writes_axiom_state is False
    result = await instance.invoke(value, correlation_id=CORRELATION)
    assert result.status == "succeeded"
    assert result.ledger_entry_ids == ["31", "32"]
    assert value == original
    output = ReviewedWorkflowOutput.model_validate(result.output)
    review = output.processing_reviews[0]
    assert review.declarations.model_dump() == value["records"][0]["payload"]
    assert review.source.record_id == value["records"][0]["id"]
    assert review.source.human_receipt_id == "1"
    assert review.source.created_by == ACTOR
    assert review.declaration_status == "human_recorded_unverified"
    assert "purpose" in review.unresolved_fields
    assert "crossBorder" not in review.unresolved_fields
    assert "processors" not in review.unresolved_fields
    assert {draft.category for draft in output.policy_drafts} == {
        "privacy_notice",
        "consent_notice",
        "retention",
        "dpa_template",
    }
    for draft in output.policy_drafts:
        assert draft.source == review.source
        assert draft.source_ropa_id == review.source.record_id
        assert "Recorded processors: Human recorded none" in draft.content
        assert "Recorded cross-border processing: Human recorded no" in draft.content
        assert "Recorded purpose: Unknown" in draft.content
        assert "Public HTML provenance does not establish private processing facts" in draft.content
        assert draft.publication_status == "unpublished"
        assert draft.review_required is draft.legal_review_required is True
    assert output.persistence == "not_saved"
    assert output.publication_allowed is output.execution_allowed is False
    for call in instance.ledger.append.call_args_list:
        assert call.args[0].actor_type == "agent"
        assert call.args[0].actor_id == "vibhaag"
        assert call.args[0].input_hash == hashlib.sha256(canonical_json(value).encode()).hexdigest()
    assert (
        instance.ledger.append.call_args_list[-1].args[0].output_hash
        == hashlib.sha256(canonical_json(result.output).encode()).hexdigest()
    )


def test_playbook_ranks_reported_time_stably_preserving_zero_and_horizon():
    records = [
        task_record(8),
        task_record(9, duration=10, repetitions=1),
        task_record(10, duration=0, repetitions=500),
        task_record(11, duration=10, repetitions=10),
    ]
    output = build_reviewed_workflow_drafts(ReviewedWorkflowInput.model_validate(payload(records)))
    assert [review.source.record_id for review in output.playbook_reviews] == [
        records[3]["id"],
        records[0]["id"],
        records[1]["id"],
        records[2]["id"],
    ]
    assert [review.reported_total_minutes for review in output.playbook_reviews] == [100, 10, 10, 0]
    by_id = {record["id"]: record for record in records}
    for review in output.playbook_reviews:
        assert review.reported_task.model_dump() == by_id[review.source.record_id]["payload"]
        assert review.time_horizon == "not_recorded"
        assert review.automation_candidate is False
        assert review.measurement_status == "not_verified"
        assert review.ranking_basis == "human_reported_time_only"
    assert not output.processing_reviews
    assert not output.policy_drafts


def test_processing_declarations_are_never_used_as_measured_tasks():
    output = build_reviewed_workflow_drafts(
        ReviewedWorkflowInput.model_validate(payload([processing_record()]))
    )
    assert len(output.processing_reviews) == 1
    assert len(output.policy_drafts) == 4
    assert not output.playbook_reviews


def test_absent_public_provenance_is_not_fabricated_or_added_as_null():
    record = processing_record()
    del record["payload"]["source"]
    value = payload([record])
    validated = ReviewedWorkflowInput.model_validate(value)
    assert validated.model_dump(mode="json") == value
    output = build_reviewed_workflow_drafts(validated)
    assert "source" not in output.processing_reviews[0].declarations.model_dump()
    assert "Retained public observation" not in output.policy_drafts[0].content


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("tenant_id", ACTOR),
        ("receipt_id", "0"),
        ("receipt_id", "9223372036854775808"),
        ("created_at", "2026-10-08T00:00:00"),
        ("content_sha256", "a" * 64),
        ("kind", "policy_review"),
    ],
)
def test_source_metadata_refused_even_when_caller_rehashes(field, value):
    request = payload()
    request["records"][0][field] = value
    with pytest.raises(ValidationError):
        ReviewedWorkflowInput.model_validate(refresh_digest(request))


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("engagementId", ACTOR),
        ("crossBorder", "false"),
        ("crossBorder", 0),
        ("dpiaRequired", 1),
        ("retentionMonths", True),
        ("retentionMonths", 0),
        ("retentionMonths", 1201),
        ("purpose", " "),
        ("system", "website\x00private"),
        ("processors", [" "]),
        ("source", None),
        ("purpose", "\ud800"),
    ],
)
def test_private_declarations_are_strict_not_inferred_or_coerced(field, value):
    request = payload()
    request["records"][0]["payload"][field] = value
    if "\ud800" not in str(value):
        refresh_digest(request)
    with pytest.raises((ValidationError, UnicodeError)):
        ReviewedWorkflowInput.model_validate(request)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("durationMinutes", None),
        ("durationMinutes", True),
        ("durationMinutes", "2"),
        ("durationMinutes", 1.5),
        ("durationMinutes", -1),
        ("durationMinutes", 1_000_001),
        ("repetitions", 0),
        ("repetitions", None),
        ("notes", " \n"),
    ],
)
def test_unmeasured_tasks_are_refused_without_inventing_duration_or_repetitions(field, value):
    record = task_record()
    record["payload"][field] = value
    with pytest.raises(ValidationError):
        ReviewedWorkflowInput.model_validate(payload([record]))


@pytest.mark.parametrize(
    "change",
    [
        "digest",
        "body",
        "duplicate_id",
        "duplicate_receipt",
        "duplicate_key",
        "empty",
        "oversize",
        "extra",
    ],
)
def test_source_register_binding_and_bounds(change):
    request = payload()
    if change == "digest":
        request["source_records_sha256"] = "b" * 64
    elif change == "body":
        request["records"][0]["payload"]["crossBorder"] = True
    elif change == "empty":
        request = payload([])
    elif change == "oversize":
        request = payload([task_record(n) for n in range(21)])
    elif change == "extra":
        request["authority"] = "verified"
    else:
        field = {
            "duplicate_id": "id",
            "duplicate_receipt": "receipt_id",
            "duplicate_key": "operation_key",
        }[change]
        request["records"][1][field] = request["records"][0][field]
        refresh_digest(request)
    with pytest.raises(ValidationError):
        ReviewedWorkflowInput.model_validate(request)


@pytest.mark.parametrize("field", ["execution_allowed", "publication_allowed"])
@pytest.mark.parametrize("value", [True, 0, 1, "false"])
def test_output_cannot_acquire_execution_or_publication_authority(field, value):
    output = build_reviewed_workflow_drafts(
        ReviewedWorkflowInput.model_validate(payload())
    ).model_dump()
    output[field] = value
    with pytest.raises(ValidationError):
        ReviewedWorkflowOutput.model_validate(output)


def test_generic_http_refuses_even_well_shaped_reviewed_source_before_work(monkeypatch):
    work = AsyncMock()
    instance = SimpleNamespace(invoke=work)
    monkeypatch.setattr(
        app.state, "settings", SimpleNamespace(internal_token="reviewed-fixture"), raising=False
    )
    monkeypatch.setattr(app.state, "agents", {AgentName.VIBHAAG: instance}, raising=False)
    response = TestClient(app).post(
        "/agents/vibhaag/invoke",
        json={"input": payload(), "correlation_id": CORRELATION},
        headers={"X-Internal-Token": "reviewed-fixture"},
    )
    assert response.status_code == 403
    assert response.json() == {"detail": "reviewed_source_workflow_required"}
    work.assert_not_called()
    with pytest.raises(ValidationError):
        VibhaagInput.model_validate(
            {"tenant_id": TENANT, "engagement_id": ENGAGEMENT, "records": []}
        )


@pytest.mark.parametrize(
    "builder",
    [build_privacy_notice, build_consent_notice, build_retention_policy, build_dpa_template],
)
def test_existing_generators_preserve_explicit_empty_and_unknown_processors(builder):
    declared = build_ropa_records(
        [{"name": "CRM", "processors": [], "data_categories": []}]
    ).records[0]
    unknown = build_ropa_records([{"name": "CRM"}]).records[0]
    assert declared.processors == []
    assert declared.data_categories == []
    assert unknown.processors is None
    assert unknown.data_categories is None
    for record, expected in [(declared, "Human recorded none"), (unknown, "To be confirmed")]:
        draft = builder("Example Ltd", [record])
        content = "\n".join(section["body"] for section in draft.sections)
        assert f"Stated processors: {expected}" in content
        if builder is build_privacy_notice:
            assert (draft.sections[1]["body"].startswith("Human recorded none")) == (
                record is declared
            )


def test_partial_unknown_categories_remain_visible_alongside_recorded_categories():
    records = build_ropa_records(
        [{"name": "CRM", "data_categories": ["contact"]}, {"name": "Other"}]
    ).records
    draft = build_privacy_notice("Example Ltd", records)
    assert draft.sections[1]["body"] == "contact; some activities require category confirmation"


def test_all_known_declarations_remain_caller_statements_without_legal_reinterpretation():
    record = processing_record()
    record["payload"].update(
        {
            "purpose": "Support inquiries",
            "legalBasis": "Human stated basis pending legal review",
            "retentionMonths": 18,
            "dataCategories": ["contact"],
            "dataPrincipals": ["Website visitors"],
            "processors": ["Declared processor"],
            "recipients": ["Declared recipient"],
            "destinationCountries": ["Declared destination"],
            "transferSafeguards": "Human stated safeguard",
            "dpiaRequired": True,
            "region": "Human stated location",
            "crossBorder": True,
            "securityMeasures": "Human stated measure",
        }
    )
    output = build_reviewed_workflow_drafts(ReviewedWorkflowInput.model_validate(payload([record])))
    assert output.processing_reviews[0].declarations.model_dump() == record["payload"]
    assert output.processing_reviews[0].unresolved_fields == []
    for draft in output.policy_drafts:
        for value in record["payload"].values():
            if isinstance(value, str):
                assert value in draft.content
        assert "Recorded retention in months: 18" in draft.content
        assert "Recorded impact assessment required: Human recorded yes" in draft.content
        assert "Recorded cross-border processing: Human recorded yes" in draft.content
        assert "not independently verified processing or legal facts" in draft.content
        assert draft.legal_review_required is True


def test_bounded_input_cannot_expand_into_unbounded_drafts():
    records = []
    for index in range(20):
        record = processing_record()
        record["id"] = f"40000000-0000-4000-8000-{index:012d}"
        record["operation_key"] = f"50000000-0000-4000-8000-{index:012d}"
        record["receipt_id"] = str(index + 1)
        record["payload"]["purpose"] = "p" * 2000
        record["payload"]["securityMeasures"] = "s" * 2000
        record["payload"]["transferSafeguards"] = "t" * 2000
        records.append(record)
    value = ReviewedWorkflowInput.model_validate(payload(records))
    with pytest.raises(ValidationError, match="Reviewed draft output refused"):
        build_reviewed_workflow_drafts(value)


@pytest.mark.asyncio
async def test_invalid_reviewed_source_does_not_write_an_agent_receipt():
    instance = agent()
    value = payload()
    value["records"][0]["tenant_id"] = ACTOR
    result = await instance.invoke(refresh_digest(value))
    assert result.status == "failed"
    assert result.error == "validation_failed"
    assert result.output is None
    instance.ledger.append.assert_not_called()


@pytest.mark.asyncio
async def test_missing_success_receipt_cannot_return_a_usable_draft():
    instance = agent()
    instance.ledger.append.side_effect = [
        SimpleNamespace(id="31"),
        RuntimeError("not persisted"),
        SimpleNamespace(id="33"),
    ]
    result = await instance.invoke(payload())
    assert result.status == "failed"
    assert result.error == "audit_completion_failed"
    assert result.output is None
    assert result.ledger_entry_ids == ["31", "33"]


def test_shared_wire_fixture_is_exact_current_python_projection():
    fixture_path = (
        Path(__file__).resolve().parents[3]
        / "packages/types/src/__fixtures__/reviewed-workflow-drafts.json"
    )
    fixture = json.loads(fixture_path.read_text())
    value = ReviewedWorkflowInput.model_validate(fixture["input"])
    assert value.model_dump(mode="json") == fixture["input"]
    assert build_reviewed_workflow_drafts(value).model_dump(mode="json") == fixture["output"]
