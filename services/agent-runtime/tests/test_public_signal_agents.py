"""Actual capture processing is separate from guarded network/source authority.

Synthetic captures test deterministic proposals; they are not live-fetch proof.
"""

from dataclasses import FrozenInstanceError, asdict

import pytest
from pydantic import ValidationError

from axiom.agents.nazar import NazarAgent, NazarInput
from axiom.agents.sanket import SanketAgent, SanketInput
from axiom.canonicalise import sha256_hex
from axiom.ledger_client import LedgerClient
from axiom.public_signal_sources import (
    GuardedPublicDocument,
    VerifiedPublicSourceBatch,
    public_source_url,
    require_public_sources,
)

TENANT = "11111111-1111-4111-8111-111111111111"
CORRELATION = "22222222-2222-4222-8222-222222222222"
REFERENCE = "33333333-3333-4333-8333-333333333333"
GOV_URL = "https://www.meity.gov.in/"
PUBLIC_URL = "https://axiomminds.ai/"


def document(
    url=GOV_URL,
    *,
    content=b"<title>Public government website</title>",
    title="Public government website",
    headings=(),
    checked_at="2026-10-05T06:00:00Z",
):
    return GuardedPublicDocument.from_guarded_capture(
        requested_url=url,
        final_url=url,
        checked_at=checked_at,
        content_sha256=sha256_hex(content),
        body=content,
        title=title,
        headings=headings,
        capture_reference=REFERENCE
        if checked_at == "2026-10-05T06:00:00Z"
        else "44444444-4444-4444-8444-444444444444",
    )


def batch(agent="nazar", documents=None, previous=()):
    documents = documents or (document(),)
    origins = tuple(dict.fromkeys("https://" + item.final_url.split("/")[2] for item in documents))
    return VerifiedPublicSourceBatch(
        tenant_id=TENANT,
        correlation_id=CORRELATION,
        agent=agent,
        approved_origins=origins,
        documents=documents,
        previous_documents=previous,
    )


@pytest.mark.parametrize(
    "url",
    [
        "http://meity.gov.in/",
        "https://127.0.0.1/",
        "https://localhost/",
        "https://user:secret@meity.gov.in/",
        "https://meity.gov.in:444/",
        "https://meity.gov.in/?token=value",
        "https://meity.gov.in/#section",
        "https://example.invalid/",
        "https://meity.gov.in/ bad",
    ],
)
def test_capture_url_transport_consistency_refuses_unsafe_urls(url):
    with pytest.raises(ValueError, match="public_source_url_refused"):
        public_source_url(url)


def test_guarded_capture_digest_and_content_budget_required():
    with pytest.raises(ValueError, match="guarded_capture_content_mismatch"):
        GuardedPublicDocument.from_guarded_capture(
            requested_url=GOV_URL,
            final_url=GOV_URL,
            checked_at="2026-10-05T06:00:00Z",
            content_sha256="0" * 64,
            body=b"real body",
            title="Public website",
            headings=(),
            capture_reference=REFERENCE,
        )
    with pytest.raises(ValueError, match="guarded_capture_content_mismatch"):
        document(content=b"x" * (512 * 1024 + 1))


def test_guarded_projection_malformed_metadata_and_input_bounds_refused():
    from dataclasses import replace

    from axiom.public_signal_sources import capture_time

    for metadata in (
        {"content_sha256": "x" * 64},
        {"byte_size": True},
        {"title": "x" * 501},
        {"headings": ("x",) * 13},
        {"checked_at": "2026-10-05T06:00:00"},
    ):
        with pytest.raises(ValueError, match="public_"):
            replace(document(), **metadata)
    for value in (None, "2026-10-05T06:00:00"):
        with pytest.raises(ValueError, match="public_capture_time_refused"):
            capture_time(value)
    with pytest.raises(ValueError, match="public_source_url_refused"):
        public_source_url(None)
    for metadata in ({"agent": "karya"}, {"approved_origins": ()}):
        with pytest.raises(
            ValueError, match=r"public_signal_agent_refused|approved_public_origins_required"
        ):
            replace(batch(), **metadata)


def test_capability_is_immutable_and_not_business_json_authority():
    value = batch()
    with pytest.raises(FrozenInstanceError):
        value.agent = "sanket"
    with pytest.raises(ValueError, match="trusted_public_source_capability_required"):
        require_public_sources(
            asdict(value), agent="nazar", tenant_id=TENANT, correlation_id=CORRELATION
        )
    with pytest.raises(ValidationError):
        NazarInput(tenant_id=TENANT, public_source_batch=asdict(value))
    with pytest.raises(ValidationError):
        SanketInput(tenant_id=TENANT, signals=[{"score": 100}])


@pytest.mark.parametrize("changed", ["agent", "tenant_id", "correlation_id"])
def test_capability_bound_to_agent_tenant_and_correlation(changed):
    args = {"agent": "nazar", "tenant_id": TENANT, "correlation_id": CORRELATION}
    args[changed] = "sanket" if changed == "agent" else REFERENCE
    with pytest.raises(ValueError, match="public_source_dispatch_binding_refused"):
        require_public_sources(batch(), **args)


def test_government_allowlist_rejects_lookalikes_and_public_customer_site():
    for url in ("https://meity.gov.in.attacker.ai/", PUBLIC_URL):
        with pytest.raises(ValueError, match="government_source_required"):
            batch(documents=(document(url),))


def test_origin_scope_and_baseline_freshness_required():
    current = document()
    with pytest.raises(ValueError, match="unapproved_public_source_refused"):
        VerifiedPublicSourceBatch(
            tenant_id=TENANT,
            correlation_id=CORRELATION,
            agent="nazar",
            approved_origins=("https://egazette.gov.in",),
            documents=(current,),
        )
    with pytest.raises(ValueError, match="earlier_source_baseline_required"):
        batch(previous=(current,))
    from dataclasses import replace

    earlier = document(checked_at="2026-10-04T06:00:00Z")
    with pytest.raises(ValueError, match="earlier_source_baseline_required"):
        batch(previous=(replace(earlier, capture_reference=current.capture_reference),))
    with pytest.raises(ValueError, match="duplicate_guarded_source_refused"):
        batch(documents=(current, current))
    with pytest.raises(ValueError, match="bounded_guarded_documents_required"):
        VerifiedPublicSourceBatch(
            tenant_id=TENANT,
            correlation_id=CORRELATION,
            agent="nazar",
            approved_origins=("https://www.meity.gov.in",),
            documents=(),
        )


@pytest.mark.asyncio
async def test_missing_composition_fails_instead_of_claiming_sources_checked():
    for agent, input_data in (
        (NazarAgent, {"tenant_id": TENANT}),
        (SanketAgent, {"tenant_id": TENANT}),
    ):
        result = await agent(ledger=LedgerClient.in_memory()).invoke(
            input_data, correlation_id=CORRELATION
        )
        assert result.status == "failed"
        assert result.output is None


@pytest.mark.asyncio
async def test_first_government_capture_is_baseline_and_unfetched_sources_stay_unchecked():
    result = await NazarAgent(ledger=LedgerClient.in_memory(), public_source_batch=batch()).invoke(
        {"tenant_id": TENANT}, correlation_id=CORRELATION
    )
    assert result.status == "succeeded"
    out = result.output
    assert out["sources_checked"] == ["www.meity.gov.in"]
    assert out["sources_unchecked"] == ["dpb.gov.in", "egazette.gov.in"]
    assert out["changes"] == []
    assert out["source_observations"][0]["baseline_status"] == "first_capture_baseline"
    assert out["source_observations"][0]["content_sha256"] == document().content_sha256
    assert out["source_observations"][0]["projection_sha256"] == document().projection_sha256
    assert out["escalate"] is False
    assert "not publication" in out["notes"]


@pytest.mark.asyncio
async def test_changed_capture_is_review_candidate_not_law_change_or_control_update():
    before = document(content=b"previous HTML", checked_at="2026-10-04T06:00:00Z")
    result = await NazarAgent(
        ledger=LedgerClient.in_memory(), public_source_batch=batch(previous=(before,))
    ).invoke({"tenant_id": TENANT, "sources": ["meity.gov.in"]}, correlation_id=CORRELATION)
    assert result.status == "succeeded"
    out = result.output
    assert out["escalate"] is True
    change = out["changes"][0]
    assert change["severity"] == "info"
    assert change["affected_control_ids"] == []
    assert "not a verified legal change" in change["summary"]
    assert out["source_observations"][0]["previous_content_sha256"] == before.content_sha256


@pytest.mark.asyncio
async def test_unchanged_capture_does_not_claim_absence_of_regulatory_change():
    before = document(checked_at="2026-10-04T06:00:00Z")
    result = await NazarAgent(
        ledger=LedgerClient.in_memory(), public_source_batch=batch(previous=(before,))
    ).invoke({"tenant_id": TENANT}, correlation_id=CORRELATION)
    assert result.status == "succeeded"
    assert result.output["changes"] == []
    assert result.output["source_observations"][0]["baseline_status"] == "content_unchanged"
    assert "does not prove absence" in result.output["notes"]


@pytest.mark.asyncio
async def test_public_heading_markers_do_not_invent_purchase_intent_or_identity():
    source = document(
        PUBLIC_URL,
        content=b"actual public heading fixture",
        title="Public vacancies",
        headings=("Data Protection Officer", "Request for proposals"),
    )
    result = await SanketAgent(
        ledger=LedgerClient.in_memory(), public_source_batch=batch("sanket", (source,))
    ).invoke({"tenant_id": TENANT}, correlation_id=CORRELATION)
    assert result.status == "succeeded"
    out = result.output
    assert {signal["signal"] for signal in out["signals"]} == {
        "public_dpo_heading",
        "public_rfp_heading",
        "public_hiring_heading",
    }
    assert all(
        signal["score"] == 0 and signal["company"] == "axiomminds.ai" for signal in out["signals"]
    )
    assert all("buying intent are unverified" in signal["context"] for signal in out["signals"])
    assert out["high_intent"] == []
    assert out["source_observations"][0]["content_sha256"] == source.content_sha256
    assert out["source_observations"][0]["requires_human_review"] is True


@pytest.mark.asyncio
async def test_no_public_markers_still_records_real_processed_capture_without_fabricated_signal():
    source = document(
        PUBLIC_URL, content=b"public company website", title="Axiom Minds", headings=("Welcome",)
    )
    result = await SanketAgent(
        ledger=LedgerClient.in_memory(), public_source_batch=batch("sanket", (source,))
    ).invoke({"tenant_id": TENANT}, correlation_id=CORRELATION)
    assert result.status == "succeeded"
    assert result.output["signals"] == []
    assert result.output["high_intent"] == []
    assert len(result.output["source_observations"]) == 1
    assert "Sector/geography preferences do not establish" in result.output["notes"]


@pytest.mark.asyncio
async def test_uncomposed_source_and_stale_market_capture_fail_closed():
    result = await NazarAgent(ledger=LedgerClient.in_memory(), public_source_batch=batch()).invoke(
        {"tenant_id": TENANT, "sources": ["unapproved.ai"]}, correlation_id=CORRELATION
    )
    assert result.status == "failed"
    source = document(PUBLIC_URL)
    result = await SanketAgent(
        ledger=LedgerClient.in_memory(), public_source_batch=batch("sanket", (source,))
    ).invoke({"tenant_id": TENANT, "since": "2026-10-06T00:00:00Z"}, correlation_id=CORRELATION)
    assert result.status == "failed"
    assert result.output is None


@pytest.mark.asyncio
async def test_stale_capture_and_cross_dispatch_cannot_run():
    value = batch()
    agent = NazarAgent(ledger=LedgerClient.in_memory(), public_source_batch=value)
    for input_data, correlation in (
        ({"tenant_id": TENANT, "since": "2026-10-06T00:00:00Z"}, CORRELATION),
        ({"tenant_id": REFERENCE}, CORRELATION),
        ({"tenant_id": TENANT}, REFERENCE),
    ):
        result = await agent.invoke(input_data, correlation_id=correlation)
        assert result.status == "failed"
        assert result.output is None
