import pytest
from pydantic import ValidationError

from axiom.playbook import PlaybookEntry, rank_playbook_backlog
from axiom.policy_generator import (
    build_consent_notice,
    build_dpa_template,
    build_privacy_notice,
    build_retention_policy,
)
from axiom.ropa_generator import build_ropa_records


def test_ropa_keeps_unknown_legal_facts_for_human_review():
    output = build_ropa_records(
        [
            {
                "name": "CRM",
                "description": "Customer support and account management",
                "data_categories": ["contact"],
                "processor": "Acme Cloud",
                "cross_border": True,
                "evidence_refs": ["ev-1"],
            }
        ],
        [{"system": "CRM", "field_path": "CRM.email", "category": "contact"}],
    )
    record = output.records[0]
    assert record.data_items == ["email"]
    assert record.lawful_basis.startswith("To be confirmed")
    assert record.transfer_safeguards == "To be documented"
    assert record.review_required is True


def test_policy_drafts_reference_ropa_activities():
    records = build_ropa_records([{"name": "Billing", "description": "Invoices"}]).records
    notice = build_privacy_notice("Example Ltd", records)
    retention = build_retention_policy("Example Ltd", records)
    assert notice.kind == "privacy_notice"
    assert retention.kind == "retention_policy"
    assert notice.source_activity_ids == retention.source_activity_ids
    assert notice.legal_review_required is True


def test_playbook_backlog_ranks_repeated_time_cost():
    entries = [
        PlaybookEntry(task_name="Small", source="e1", duration_minutes=30, repetitions=2),
        PlaybookEntry(task_name="Large", source="e1", duration_minutes=10, repetitions=10),
    ]
    assert [entry.task_name for entry in rank_playbook_backlog(entries)] == ["Large", "Small"]


def test_complete_field_inventory_does_not_clear_unresolved_legal_review():
    record = build_ropa_records(
        [{"name": "CRM", "description": "Customer support", "region": "ap-south-1"}],
        [{"system": "CRM", "field_path": "CRM.email", "category": "Contact"}],
    ).records[0]
    assert record.review_required is True
    assert record.purpose == "Purpose to be confirmed by the Data Fiduciary"
    assert record.data_categories == ["contact"]


def test_unknown_region_is_never_assumed_to_be_india():
    record = build_ropa_records([{"name": "Indian CRM ap-south-1"}]).records[0]
    assert record.region == "Unknown — residency evidence required"
    assert record.transfer_safeguards is None
    assert record.cross_border is None
    assert record.processors is None
    assert record.data_categories is None


@pytest.mark.parametrize("marker", ["mode", "source_type", "source_scope"])
def test_public_html_does_not_establish_private_processing_facts(marker):
    record = build_ropa_records(
        [
            {
                "name": "Public contact form",
                marker: "public_website",
                "description": "Marketing",
                "region": "us-east-1",
                "cross_border": True,
                "processor": "Claimed cloud",
                "data_categories": ["contact"],
                "evidence_refs": ["public-html-hash"],
            }
        ]
    ).records[0]
    assert record.purpose == "Purpose to be confirmed by the Data Fiduciary"
    assert record.region == "Unknown — residency evidence required"
    assert record.processors is None
    assert record.cross_border is None
    assert record.data_categories is None
    assert record.evidence_refs == ["public-html-hash"]
    assert record.review_required is True


def test_explicit_private_processor_observations_are_preserved_for_review():
    record = build_ropa_records(
        [{"name": "CRM", "processors": [" Acme ", "Acme"], "cross_border": False}]
    ).records[0]
    assert record.processors == ["Acme"]
    assert record.cross_border is False
    assert record.review_required is True


def test_stated_foreign_region_is_reviewed_without_claiming_legal_determination():
    record = build_ropa_records([{"name": "CRM", "region": "us-east-1"}]).records[0]
    assert record.cross_border is True
    assert (
        record.transfer_safeguards
        == "Transfer restrictions and safeguards to be reviewed (Stated destination: us-east-1)"
    )
    assert record.review_required is True


def test_string_false_is_not_truthy_cross_border_evidence():
    record = build_ropa_records([{"name": "CRM", "cross_border": "false"}]).records[0]
    assert record.cross_border is None


def test_ropa_keeps_system_classification_and_evidence_provenance_separate():
    records = build_ropa_records(
        [
            {"name": "Billing", "evidence_refs": ["billing-proof"]},
            {"name": "HR", "evidence_refs": ["hr-proof"]},
        ],
        [{"system": "HR", "field_path": "HR.email", "category": "contact"}],
    ).records
    assert records[0].data_items == ["Unspecified — field inventory required"]
    assert records[0].evidence_refs == ["billing-proof"]
    assert records[1].data_items == ["email"]
    assert records[1].evidence_refs == ["hr-proof"]
    assert records[0].activity_id != records[1].activity_id


@pytest.mark.parametrize(
    "builder",
    [build_privacy_notice, build_retention_policy, build_consent_notice, build_dpa_template],
)
def test_all_policy_templates_preserve_unknowns_provenance_and_review(builder):
    record = build_ropa_records([{"name": "CRM", "evidence_refs": ["ev-1"]}]).records[0]
    draft = builder("Example Ltd", [record])
    text = "\n".join(section["body"] for section in draft.sections)
    assert record.activity_id in text
    assert record.purpose in text
    assert record.lawful_basis in text
    assert record.retention_period in text
    assert record.region in text
    assert "ev-1" in text
    assert "Unpublished draft" in text
    assert draft.source_activity_ids == [record.activity_id]
    assert draft.review_required is True
    assert draft.legal_review_required is True


@pytest.mark.parametrize(
    "builder",
    [build_privacy_notice, build_retention_policy, build_consent_notice, build_dpa_template],
)
def test_empty_inventory_cannot_produce_a_silent_publishable_template(builder):
    draft = builder("Example Ltd", [])
    assert any("No processing activities recorded" in section["body"] for section in draft.sections)
    assert draft.source_activity_ids == []
    assert draft.legal_review_required is True


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("task_name", "  "),
        ("source", "\n"),
        ("duration_minutes", True),
        ("duration_minutes", "2"),
        ("duration_minutes", 1.5),
        ("repetitions", False),
        ("repetitions", 0),
    ],
)
def test_playbook_rejects_invalid_observed_task_cost(field, value):
    payload = {
        "task_name": "Review",
        "source": "Interview",
        "duration_minutes": 10,
        "repetitions": 1,
    }
    payload[field] = value
    with pytest.raises(ValidationError):
        PlaybookEntry(**payload)


def test_playbook_rank_is_stable_preserves_inputs_and_observed_cost():
    entries = [
        PlaybookEntry(task_name=" First ", source=" Interview ", duration_minutes=5, repetitions=2),
        PlaybookEntry(task_name="Second", source="Interview", duration_minutes=10),
        PlaybookEntry(task_name="Zero", source="Interview", duration_minutes=0, repetitions=500),
    ]
    ranked = rank_playbook_backlog(entries)
    assert [entry.task_name for entry in ranked] == ["First", "Second", "Zero"]
    assert ranked is not entries
    assert entries[0].source == "Interview"
    assert entries[0].total_minutes == entries[0].annual_minutes == 10
    assert entries[0].automation_candidate is False
