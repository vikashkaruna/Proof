"""Tests for Pramaan (प्रमाण · Statutory Closure & Proof Attestation Agent).

Validates:
- Non-mutating guarantee (can_mutate == False, mutates_client_estate == False)
- State writing & autonomy level (writes_axiom_state == True, autonomy == L1)
- Synthesis of all 5 dossier types (board_executive, dpb_statutory, auditor_assurance, technical_register, full_closure)
- Institutional branding enforcement in HTML and Markdown
- Inclusion of maker-checker (Samadhan) and ledger (Lekha) roots in the proof seal
- Deterministic cryptographic hashing (Merkle root, Manifest digest, ProofSeal)
- Statutory exposure calculation and DPDPA Section 33 cap (₹250 Cr)
- Untrusted content HTML escaping
- End-to-end agent invoke lifecycle with ledger
"""

from __future__ import annotations

import re
from typing import Any
from unittest.mock import AsyncMock

import pytest

from axiom.agents.base import AgentName, AutonomyLevel
from axiom.agents.pramaan import (
    COMPANY_NAME,
    COMPANY_WEBSITE,
    PRODUCT_NAME,
    PRODUCT_DOMAIN,
    TAGLINE,
    WORKBENCH_URL,
    DossierStatus,
    DossierType,
    PramaanAgent,
    PramaanInput,
    PramaanOutput,
)
from axiom.config import Settings


class FakeLedger:
    def __init__(self) -> None:
        self.appended: list[Any] = []

    async def append(self, entry: Any) -> Any:
        self.appended.append(entry)
        mock_res = AsyncMock()
        mock_res.id = f"ledger-entry-{len(self.appended)}"
        return mock_res


@pytest.fixture
def fake_ledger() -> FakeLedger:
    return FakeLedger()


@pytest.fixture
def pramaan_agent(fake_ledger: FakeLedger) -> PramaanAgent:
    settings = Settings(
        postgres_url="postgresql://fake:fake@localhost:5432/fake",
        model_gateway_url="http://localhost:9999",
        axiom_deployment="dev",
    )
    return PramaanAgent(settings=settings, ledger=fake_ledger)


@pytest.fixture
def sample_findings() -> list[dict[str, Any]]:
    return [
        {
            "control_id": "DPDPA-SEC-8-5",
            "title": "Reasonable Security Safeguards for Personal Data",
            "severity": "critical",
            "score": 40.0,
            "risk_points": 60,
            "evidence_ids": ["ev-sec-8-5-001"],
            "evidence_required": [{"evidence_id": "ev-sec-8-5-req"}],
            "rationale": "Missing multi-region automated database encryption at rest.",
        },
        {
            "control_id": "DPDPA-SEC-6-1",
            "title": "Itemised and Clear Consent Notice",
            "severity": "high",
            "score": 55.0,
            "risk_points": 45,
            "evidence_ids": ["ev-sec-6-1-001"],
            "rationale": "Consent notice lacks explicit vernacular language translations.",
        },
        {
            "control_id": "DPDPA-SEC-11-1",
            "title": "Data Principal Rights Management & Redressal",
            "severity": "medium",
            "score": 70.0,
            "risk_points": 30,
            "evidence_ids": ["ev-sec-11-1-001"],
            "rationale": "DSAR turnaround time exceeds 72 hours for erasure requests.",
        },
    ]


@pytest.fixture
def sample_reconciliation() -> list[dict[str, Any]]:
    return [
        {
            "batch_id": "00000000-0000-0000-0000-000000000001",
            "verdict": "clean",
            "statement": "Execution strictly matched approved token. Zero out-of-scope mutations.",
            "statement_signature": "a" * 64,
        },
        {
            "batch_id": "00000000-0000-0000-0000-000000000002",
            "verdict": "clean",
            "statement": "Parameter diffs recomputed clean. No drift detected.",
            "statement_signature": "b" * 64,
        },
    ]


@pytest.fixture
def sample_ledger_entries() -> list[dict[str, Any]]:
    return [
        {
            "entry_id": "le-001",
            "action_type": "execution.started",
            "current_hash": "c" * 64,
        },
        {
            "entry_id": "le-002",
            "action_type": "execution.reconciliation.recorded",
            "current_hash": "d" * 64,
        },
    ]


# ─── 1. Metadata and Non-Mutating Guarantee ──────────────────────────

def test_pramaan_agent_metadata_and_non_mutating_guarantee():
    """Validates Pramaan's architectural identity and non-mutating guarantee (can_mutate == False)."""
    assert PramaanAgent.name == AgentName.PRAMAAN
    assert PramaanAgent.name.value == "pramaan"
    assert PramaanAgent.can_mutate is False
    assert PramaanAgent.mutates_client_estate is False
    assert PramaanAgent.writes_axiom_state is True
    assert PramaanAgent.autonomy == AutonomyLevel.L1
    assert sorted(PramaanAgent.tool_scopes) == sorted([
        "findings.read",
        "plan.read",
        "reconciliation.read",
        "evidence.read",
        "ledger.read",
        "dossier.write",
        "pdf.render",
    ])
    assert "Statutory Closure & Proof Attestation Agent" in PramaanAgent.description
    assert PramaanAgent.one_liner == "I turn findings, ledgers, and evidence into unassailable, auditor-ready proof."


# ─── 2. Synthesis of All 5 Dossier Types ──────────────────────────────

@pytest.mark.asyncio
@pytest.mark.parametrize(
    "dossier_type,expected_section_type",
    [
        (DossierType.BOARD_EXECUTIVE, "board_risk_summary"),
        (DossierType.DPB_STATUTORY, "dpb_statutory_submission"),
        (DossierType.AUDITOR_ASSURANCE, "auditor_traceability_matrix"),
        (DossierType.TECHNICAL_REGISTER, "technical_remediation_register"),
        (DossierType.FULL_CLOSURE, "comprehensive_closure_matrix"),
    ],
)
async def test_synthesis_of_all_five_dossier_types(
    pramaan_agent: PramaanAgent,
    sample_findings: list[dict[str, Any]],
    sample_reconciliation: list[dict[str, Any]],
    sample_ledger_entries: list[dict[str, Any]],
    dossier_type: DossierType,
    expected_section_type: str,
):
    """Verifies synthesis across all 5 statutory dossier types."""
    input_data = PramaanInput(
        tenant_id="11111111-1111-1111-1111-111111111111",
        engagement_id="22222222-2222-2222-2222-222222222222",
        dossier_type=dossier_type,
        title=f"Test {dossier_type.value} Pack",
        findings=sample_findings,
        plan_ids=["plan-001", "plan-002"],
        reconciliation_ids=["rec-001"],
        reconciliation_statements=sample_reconciliation,
        ledger_entries=sample_ledger_entries,
        evidence_ids=["ev-extra-001"],
    )

    output = await pramaan_agent._run(correlation_id="corr-test-1", input=input_data)

    assert isinstance(output, PramaanOutput)
    assert output.status == DossierStatus.DRAFT.value
    assert output.dossier_type == dossier_type.value
    assert re.match(r"^[0-9a-f]{64}$", output.merkle_root)
    assert re.match(r"^[0-9a-f]{64}$", output.manifest_hash)
    assert re.match(r"^[0-9a-f]{64}$", output.proof_seal_hash)
    assert output.generated_by_agent == "pramaan"

    # Verify cited evidence IDs deduplication
    assert "ev-sec-8-5-001" in output.cited_evidence_ids
    assert "ev-sec-8-5-req" in output.cited_evidence_ids
    assert "ev-extra-001" in output.cited_evidence_ids

    # Verify required common sections
    section_types = [s.get("type") for s in output.sections]
    assert "executive_summary" in section_types
    assert "maker_checker_attestation" in section_types
    assert "ledger_chain_verification" in section_types
    assert "evidence_manifest" in section_types
    assert "proof_seal" in section_types
    assert "attribution" in section_types

    # Verify type-specific section
    assert expected_section_type in section_types

    # Verify non-empty rendered HTML and Markdown
    assert len(output.rendered_html) > 500
    assert len(output.rendered_markdown) > 300


# ─── 3. Institutional Branding Enforcement ────────────────────────────

@pytest.mark.asyncio
async def test_branding_enforcement_in_html_and_markdown(
    pramaan_agent: PramaanAgent,
    sample_findings: list[dict[str, Any]],
):
    """Enforces institutional branding constants in generated HTML and Markdown."""
    assert COMPANY_NAME == "Axiom Minds Private Limited"
    assert COMPANY_WEBSITE == "https://axiomminds.ai"
    assert PRODUCT_NAME == "Axiom Proof"
    assert PRODUCT_DOMAIN == "https://axiomproof.ai"
    assert WORKBENCH_URL == "https://app.axiomproof.ai"
    assert TAGLINE == "Agents do the work. You approve. The proof is automatic."

    input_data = PramaanInput(
        tenant_id="11111111-1111-1111-1111-111111111111",
        dossier_type=DossierType.FULL_CLOSURE,
        title="Full Statutory Attestation",
        findings=sample_findings,
    )
    output = await pramaan_agent._run(correlation_id="corr-branding", input=input_data)

    # Check HTML branding
    html = output.rendered_html
    assert COMPANY_NAME in html
    assert COMPANY_WEBSITE in html
    assert PRODUCT_NAME in html
    assert PRODUCT_DOMAIN in html
    assert WORKBENCH_URL in html
    assert TAGLINE in html

    # Check Markdown branding
    md = output.rendered_markdown
    assert COMPANY_NAME in md
    assert COMPANY_WEBSITE in md
    assert PRODUCT_NAME in md
    assert PRODUCT_DOMAIN in md
    assert WORKBENCH_URL in md
    assert TAGLINE in md


# ─── 4. Maker-Checker & Ledger Roots in Proof Seal ───────────────────

@pytest.mark.asyncio
async def test_inclusion_of_maker_checker_and_ledger_roots_in_proof_seal(
    pramaan_agent: PramaanAgent,
    sample_findings: list[dict[str, Any]],
    sample_reconciliation: list[dict[str, Any]],
    sample_ledger_entries: list[dict[str, Any]],
):
    """Proves that changing reconciliations or ledger entries alters the proof seal."""
    base_input = PramaanInput(
        tenant_id="11111111-1111-1111-1111-111111111111",
        engagement_id="22222222-2222-2222-2222-222222222222",
        dossier_type=DossierType.FULL_CLOSURE,
        findings=sample_findings,
        reconciliation_statements=sample_reconciliation,
        ledger_entries=sample_ledger_entries,
        metadata={"dossier_id": "dossier-fixed-id-1234"},
        created_at="2026-09-28T00:00:00.000Z",
    )
    base_output = await pramaan_agent._run(correlation_id="corr-base", input=base_input)

    # 1. Determinism check: identical inputs yield identical seal
    identical_output = await pramaan_agent._run(correlation_id="corr-base-2", input=base_input)
    assert identical_output.proof_seal_hash == base_output.proof_seal_hash
    assert identical_output.merkle_root == base_output.merkle_root
    assert identical_output.ledger_root == base_output.ledger_root
    assert identical_output.maker_checker_root == base_output.maker_checker_root

    # 2. Modify Maker-Checker statement -> maker_checker_root AND proof_seal_hash MUST change
    tampered_recon = list(sample_reconciliation)
    tampered_recon[0] = {
        **tampered_recon[0],
        "statement_signature": "f" * 64,
    }
    recon_input = base_input.model_copy(update={"reconciliation_statements": tampered_recon})
    recon_output = await pramaan_agent._run(correlation_id="corr-recon", input=recon_input)
    assert recon_output.maker_checker_root != base_output.maker_checker_root
    assert recon_output.proof_seal_hash != base_output.proof_seal_hash

    # 3. Modify Ledger entry -> ledger_root AND proof_seal_hash MUST change
    tampered_ledger = list(sample_ledger_entries)
    tampered_ledger[0] = {
        **tampered_ledger[0],
        "current_hash": "e" * 64,
    }
    ledger_input = base_input.model_copy(update={"ledger_entries": tampered_ledger})
    ledger_output = await pramaan_agent._run(correlation_id="corr-ledger", input=ledger_input)
    assert ledger_output.ledger_root != base_output.ledger_root
    assert ledger_output.proof_seal_hash != base_output.proof_seal_hash

    # 4. Modify Findings -> merkle_root AND proof_seal_hash MUST change
    tampered_findings = sample_findings[:1]
    findings_input = base_input.model_copy(update={"findings": tampered_findings})
    findings_output = await pramaan_agent._run(correlation_id="corr-findings", input=findings_input)
    assert findings_output.merkle_root != base_output.merkle_root
    assert findings_output.proof_seal_hash != base_output.proof_seal_hash


# ─── 5. Exposure Capping and HTML Escaping ─────────────────────────────

@pytest.mark.asyncio
async def test_statutory_exposure_capping_and_posture_calculation(
    pramaan_agent: PramaanAgent,
):
    """Validates that statutory exposure is capped at ₹250 Crores per DPDPA Section 33."""
    # 10 critical findings = ₹500 Cr uncapped, but should cap at ₹250 Cr
    many_findings = [
        {"control_id": f"CTRL-{i}", "severity": "critical", "risk_points": 50}
        for i in range(10)
    ]
    input_data = PramaanInput(
        findings=many_findings,
        dossier_type=DossierType.BOARD_EXECUTIVE,
    )
    output = await pramaan_agent._run(correlation_id="corr-exposure", input=input_data)

    exec_summary = next(s for s in output.sections if s["type"] == "executive_summary")
    assert exec_summary["exposure_cr"] == 250.0  # Exactly 250 Crores capped
    assert "₹250.00 Cr" in exec_summary["body"]


@pytest.mark.asyncio
async def test_html_escaping_of_untrusted_inputs(pramaan_agent: PramaanAgent):
    """Guards against XSS injection into the rendered HTML dossier."""
    input_data = PramaanInput(
        title="<script>alert('xss')</script>",
        findings=[
            {
                "control_id": "<img src=x onerror=alert(1)>",
                "title": "<b>Unsanitized Input</b>",
                "severity": "high",
                "risk_points": 20,
            }
        ],
        dossier_type=DossierType.AUDITOR_ASSURANCE,
    )
    output = await pramaan_agent._run(correlation_id="corr-xss", input=input_data)

    assert "<script>alert('xss')</script>" not in output.rendered_html
    assert "&lt;script&gt;alert(&#x27;xss&#x27;)&lt;/script&gt;" in output.rendered_html
    assert "<img src=x onerror=alert(1)>" not in output.rendered_html
    assert "&lt;img src=x onerror=alert(1)&gt;" in output.rendered_html


# ─── 6. Agent Invoke Lifecycle with Ledger ────────────────────────────

@pytest.mark.asyncio
async def test_pramaan_agent_invoke_lifecycle(
    pramaan_agent: PramaanAgent,
    fake_ledger: FakeLedger,
    sample_findings: list[dict[str, Any]],
):
    """Tests full agent invoke lifecycle recording started and completed ledger entries."""
    raw_input = {
        "tenant_id": "00000000-0000-0000-0000-000000000001",
        "engagement_id": "11111111-1111-1111-1111-111111111111",
        "dossier_type": "full_closure",
        "title": "Authoritative Closure Attestation Pack",
        "findings": sample_findings,
    }

    result = await pramaan_agent.invoke(raw_input, correlation_id="corr-invoke-1")

    assert result.status == "succeeded"
    assert result.agent == AgentName.PRAMAAN
    assert result.output is not None
    assert result.output["status"] == "draft"
    assert len(result.output["proof_seal_hash"]) == 64
    assert len(result.ledger_entry_ids) == 2

    # Check ledger records
    assert len(fake_ledger.appended) == 2
    started = fake_ledger.appended[0]
    completed = fake_ledger.appended[1]

    assert started.actor_id == "pramaan"
    assert started.action_type == "closure.pramaan.drafted"
    assert started.result == "pending"

    assert completed.actor_id == "pramaan"
    assert completed.action_type == "closure.pramaan.drafted"
    assert completed.result == "success"
