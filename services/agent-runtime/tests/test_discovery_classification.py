import pytest

from axiom.agents.drishti import DrishtiAgent, DrishtiInput, DrishtiOutput
from axiom.agents.vibhaag import VibhaagAgent, VibhaagInput, VibhaagOutput

# Explicit independent synthetic tenant; no default production identity.
SYNTHETIC_TENANT_ID = "47480000-0000-4000-8000-000000000001"


@pytest.mark.asyncio
async def test_drishti_escalates_case_insensitive_sensitive_categories():
    output = await DrishtiAgent().invoke(
        DrishtiInput(
            tenant_id=SYNTHETIC_TENANT_ID,
            engagement_id="e1",
            systems=[{"name": "CRM", "type": "postgres", "data_categories": ["Children"]}],
        )
    )
    assert output.status == "succeeded"
    assert DrishtiOutput.model_validate(output.output).escalate is True


@pytest.mark.asyncio
async def test_vibhaag_accepts_documented_field_hint_shape():
    output = await VibhaagAgent().invoke(
        VibhaagInput(
            tenant_id=SYNTHETIC_TENANT_ID,
            engagement_id="e1",
            inventory=[{"name": "CRM", "data_categories": []}],
            field_hints={"CRM": {"email": {"category": "contact"}}},
        )
    )
    assert output.status == "succeeded"
    result = VibhaagOutput.model_validate(output.output)
    assert result.classifications[0].category == "contact"
    assert result.classifications[0].field_path == "CRM.email"


@pytest.mark.asyncio
async def test_drishti_does_not_invent_a_region_for_a_declared_domestic_system():
    output = await DrishtiAgent().invoke(
        DrishtiInput(
            tenant_id=SYNTHETIC_TENANT_ID,
            engagement_id="e1",
            systems=[
                {
                    "name": "Production Customer DB",
                    "type": "postgres",
                    "description": "Core database holding user credentials and KYC docs",
                    "hosts_personal_data": True,
                    "data_categories": ["aadhaar", "pan", "phone", "email"],
                    "cross_border": False,
                }
            ],
        )
    )
    assert output.status == "succeeded"
    result = DrishtiOutput.model_validate(output.output)
    assert result.system_count == 1
    assert result.personal_data_systems == 1
    assert result.cross_border_systems == 0
    assert result.escalate is False
    assert result.inventory[0].region == "Unknown — residency evidence required"
    assert result.inventory[0].cross_border is False
    assert len(result.warnings) == 0


@pytest.mark.asyncio
async def test_drishti_flags_a_foreign_region_indicator_without_overwriting_declarations():
    output = await DrishtiAgent().invoke(
        DrishtiInput(
            tenant_id=SYNTHETIC_TENANT_ID,
            engagement_id="e1",
            systems=[
                {
                    "name": "US Analytics S3 Bucket",
                    "type": "s3",
                    "description": "Log telemetry archive in us-east-1",
                    "hosts_personal_data": True,
                    "data_categories": ["ip_address", "telemetry"],
                    "cross_border": False,  # A conflict needs review, not an invented fact.
                }
            ],
        )
    )
    assert output.status == "succeeded"
    result = DrishtiOutput.model_validate(output.output)
    assert result.cross_border_systems == 0
    assert result.escalate is True
    assert result.escalation_reason == "residency_declaration_review_required"
    assert result.inventory[0].region == "Unknown — residency evidence required"
    assert result.inventory[0].cross_border is False
    assert len(result.warnings) == 1
    assert "Residency review required" in result.warnings[0]
    assert "us-east-1" in result.warnings[0]
    assert "does not establish" in result.warnings[0]


@pytest.mark.asyncio
async def test_drishti_detects_explicit_foreign_region_and_warns():
    output = await DrishtiAgent().invoke(
        DrishtiInput(
            tenant_id=SYNTHETIC_TENANT_ID,
            engagement_id="e1",
            systems=[
                {
                    "name": "Frankfurt S3 Logs",
                    "type": "s3",
                    "description": "Central backup repository",
                    "region": "eu-central-1",
                    "cross_border": False,
                }
            ],
        )
    )
    assert output.status == "succeeded"
    result = DrishtiOutput.model_validate(output.output)
    assert result.cross_border_systems == 0
    assert result.escalate is True
    assert result.inventory[0].region == "eu-central-1"
    assert result.inventory[0].cross_border is False
    assert any("Residency review required" in w for w in result.warnings)


@pytest.mark.asyncio
async def test_drishti_recognizes_indian_regions_as_domestic():
    output = await DrishtiAgent().invoke(
        DrishtiInput(
            tenant_id=SYNTHETIC_TENANT_ID,
            engagement_id="e1",
            systems=[
                {
                    "name": "Hyderabad DB",
                    "type": "postgres",
                    "region": "ap-south-2",
                    "cross_border": False,
                },
                {
                    "name": "Delhi GCP Storage",
                    "type": "gcs",
                    "region": "asia-south2",
                    "cross_border": False,
                },
                {
                    "name": "Pune Azure Lake",
                    "type": "azure_blob",
                    "region": "centralindia",
                    "cross_border": False,
                },
            ],
        )
    )
    assert output.status == "succeeded"
    result = DrishtiOutput.model_validate(output.output)
    assert result.cross_border_systems == 0
    assert result.escalate is False
    assert len(result.warnings) == 0
