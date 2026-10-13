"""Synthetic v2 codec fixtures: these are NOT captured PostgreSQL interoperability proof."""

import json
from copy import deepcopy

import pytest

from axiom.canonicalise import canonical_json, sha256_hex
from axiom.prativedan_assessment_draft_codec import (
    AssessmentDraftBinding,
    AssessmentDraftCodecError,
    parse_claim_v2,
    parse_readback_v2,
    parse_source_v2,
    project_source_v2,
)
from axiom.prativedan_renderer_config import renderer_commitment


def receipt(n):
    return {"id": str(n), "entry_hash": str(n % 10) * 64}


@pytest.fixture
def packet():
    ids = {
        key: f"47520000-0000-4000-8000-{n:012d}"
        for n, key in enumerate(
            [
                "tenant_id",
                "engagement_id",
                "assessment_run_id",
                "run_id",
                "operation_key",
                "actor_id",
            ],
            1,
        )
    }
    ids["source_id"] = ids["assessment_run_id"]
    controls = [
        {
            "id": f"C{n}",
            "title": "घोषणा <&>",
            "severity": "info",
            "library_version": "fixture-v2",
            "sdf_only": False,
            "children_only": False,
            "assessment_questions": [{"id": "Q1", "type": "boolean"}],
        }
        for n in (1, 2)
    ]
    controls_text = json.dumps(controls, ensure_ascii=False)
    declarations = [
        {
            "control_id": c["id"],
            "questions": [{"question_id": "Q1", "declaration": "unknown"}],
            "known_boolean_question_count": 1,
            "caller_affirmed_count": 0,
            "caller_denied_count": 0,
            "unknown_count": 1,
            "answer_state": "unknown",
            "applicability_state": "unconditional",
        }
        for c in controls
    ]
    result = {
        "library_version": "fixture-v2",
        "posture_score": 30.125,
        "estimated_exposure_inr": 9007199254740991,
        "findings": [
            {"control_id": c["id"], "score": 1e-7, "risk_points": 0, "rationale": "Declared <&>"}
            for c in reversed(controls)
        ],
        "questionnaire_provenance": {
            "version": 1,
            "source_library_version": "fixture-v2",
            "source_library_digest": sha256_hex(controls_text),
            "estimates": "provisional",
            "review_required": True,
            "controls": declarations,
            "applicability": {
                k: {"value": None, "provenance": "unknown"}
                for k in ["sdf_self_attested", "processes_children", "processes_health"]
            },
        },
    }
    result_text = json.dumps(result, ensure_ascii=False)
    source = {
        "schema_version": 2,
        "serialization": "postgres-jsonb-text-v1",
        "kind": "prativedan_assessment_source",
        **{k: ids[k] for k in ["tenant_id", "engagement_id", "assessment_run_id", "source_id"]},
        "title": "Synthetic assessment <&>",
        "library_version": "fixture-v2",
        "controls_text": controls_text,
        "controls_sha256": sha256_hex(controls_text),
        "result_text": result_text,
        "result_sha256": sha256_hex(result_text),
        "completed_at": "2026-10-13T10:00:00+00:00",
        "finalized_at": "2026-10-13T10:00:01+00:00",
        "receipts": {"started": receipt(1), "completed": receipt(2), "finalized": receipt(3)},
        "limitations": [
            "Recorded questionnaire computation; no independent evidence verification.",
            "Current remediation state is not included.",
            "Not a compliance certification or legal opinion.",
        ],
    }
    source_text = json.dumps(source, ensure_ascii=False)
    request_text = json.dumps(
        {
            "operationKey": ids["operation_key"],
            "engagementId": ids["engagement_id"],
            "assessmentRunId": ids["assessment_run_id"],
            "expectedSourceSha256": sha256_hex(source_text),
            "sourceReviewed": True,
        }
    )
    config_version, config_text, config_hash = renderer_commitment()
    readback = {
        "schema_version": 2,
        "kind": "prativedan_unpublished_draft",
        **ids,
        "source_text": source_text,
        "source_sha256": sha256_hex(source_text),
        "request_text": request_text,
        "request_sha256": sha256_hex(request_text),
        "renderer_config_text": config_text,
        "renderer_config_sha256": config_hash,
        "renderer_config_version": config_version,
        "requested_receipt": receipt(4),
        "state": "requested",
        "publication_allowed": False,
        "review_required": True,
        "citation_verification": "unverified_references",
    }
    binding = AssessmentDraftBinding(
        **ids, request_text=request_text, source_sha256=sha256_hex(source_text)
    )
    return {"source": source, "readback": readback, "binding": binding}


def rebind_source(packet, edit):
    source = deepcopy(packet["source"])
    edit(source)
    text = json.dumps(source, ensure_ascii=False)
    return text, sha256_hex(text)


def claimed(packet):
    result = deepcopy(packet["readback"])
    source = parse_source_v2(result["source_text"], result["source_sha256"])
    text = canonical_json(project_source_v2(source).model_dump(mode="json"))
    result.update(
        state="invocation_uncertain",
        normalized_input_text=text,
        runtime_normalized_input_sha256=sha256_hex(text),
        claimed_receipt=receipt(5),
        claim_expires_at="2026-10-13T10:05:00+00:00",
    )
    return result


def test_v2_source_projects_findings_order_and_unicode(packet):
    r = packet["readback"]
    source = parse_source_v2(r["source_text"], r["source_sha256"])
    projected = project_source_v2(source)
    assert projected.library_control_ids == ["C1", "C2"]
    assert [f["control_id"] for f in projected.findings] == ["C2", "C1"]
    assert projected.posture_score == 30.125
    assert projected.estimated_exposure_inr == 9007199254740991
    assert "evidence unverified" in projected.findings[0]["rationale"]
    assert "risk_points" not in projected.findings[0]


@pytest.mark.parametrize(
    "edit",
    [
        lambda s: s.update(schema_version=True),
        lambda s: s.update(schema_version=1, kind="board_source"),
        lambda s: s.update(source_id="47520000-0000-4000-8000-000000000099"),
        lambda s: s.update(controls_sha256="a" * 64),
        lambda s: s.update(result_sha256="a" * 64),
        lambda s: s.update(completed_at="2026-10-13T11:00:00+00:00"),
        lambda s: s.update(finalized_at="2026-10-13T10:00:01"),
        lambda s: s["receipts"].update(completed=receipt(1)),
    ],
)
def test_invalid_source_refused(packet, edit):
    text, digest = rebind_source(packet, edit)
    with pytest.raises(AssessmentDraftCodecError):
        parse_source_v2(text, digest)


@pytest.mark.parametrize(
    "change",
    [
        lambda r: r["findings"][0].update(control_id="FOREIGN"),
        lambda r: r["findings"][0].update(score=True),
        lambda r: r["questionnaire_provenance"]["controls"][0]["questions"][0].update(
            declaration=None
        ),
        lambda r: r["questionnaire_provenance"]["controls"][0].update(unknown_count=0),
        lambda r: r["questionnaire_provenance"].update(version=True),
        lambda r: r.update(estimated_exposure_inr=9007199254740992),
        lambda r: r.update(posture_score=None),
    ],
)
def test_actual_provenance_projection_refuses_rehashed_forgery(packet, change):
    def edit(source):
        result = json.loads(source["result_text"])
        change(result)
        source["result_text"] = json.dumps(result)
        source["result_sha256"] = sha256_hex(source["result_text"])

    text, digest = rebind_source(packet, edit)
    with pytest.raises(AssessmentDraftCodecError):
        project_source_v2(parse_source_v2(text, digest))


def test_recursive_duplicate_json_members_refused(packet):
    r = packet["readback"]
    text = r["source_text"].replace(
        '"schema_version": 2', '"schema_version": 2, "schema_\\u0076ersion": 2'
    )
    with pytest.raises(AssessmentDraftCodecError):
        parse_source_v2(text, sha256_hex(text))

    def edit(s):
        s["result_text"] = s["result_text"].replace(
            '"score": 1e-07', '"score": 1e-07, "score": 1e-07'
        )
        s["result_sha256"] = sha256_hex(s["result_text"])

    text, digest = rebind_source(packet, edit)
    with pytest.raises(AssessmentDraftCodecError):
        project_source_v2(parse_source_v2(text, digest))


def test_requested_and_claimed_readbacks(packet):
    assert parse_readback_v2(packet["readback"], packet["binding"]).state == "requested"
    r = claimed(packet)
    assert parse_readback_v2(r, packet["binding"]).state == "invocation_uncertain"
    first = parse_claim_v2(
        {"claimed": True, "expires_at": r["claim_expires_at"], "readback": r}, packet["binding"]
    )
    assert first.claimed is True
    replay = parse_claim_v2(
        {"claimed": False, "invocation_uncertain": True, "readback": r}, packet["binding"]
    )
    assert replay.claimed is False


@pytest.mark.parametrize(
    "edit",
    [
        lambda r: r.update(publication_allowed=True),
        lambda r: r.update(schema_version=True),
        lambda r: r.update(run_id=r["source_id"]),
        lambda r: r.update(actor_id=r["tenant_id"]),
        lambda r: r.update(request_sha256=r["source_sha256"]),
        lambda r: r.update(source_text=r["source_text"] + " "),
        lambda r: r.update(renderer_config_text=r["renderer_config_text"] + " "),
        lambda r: r.update(normalized_input_text="{}"),
        lambda r: r.update(state="requested"),
        lambda r: r.update(claimed_receipt=receipt(4)),
        lambda r: r.update(review={}),
    ],
)
def test_readback_refuses_changed_binding_domain_or_state(packet, edit):
    r = claimed(packet)
    edit(r)
    with pytest.raises(AssessmentDraftCodecError):
        parse_readback_v2(r, packet["binding"])


def test_claim_cannot_infer_invocation_from_missing_or_malformed_payload(packet):
    for raw in [
        {},
        {"missing": True},
        {"claimed": 1},
        {"claimed": False, "readback": claimed(packet)},
        {"claimed": True, "expires_at": "2026-10-13T11:00:00Z", "readback": claimed(packet)},
    ]:
        with pytest.raises(AssessmentDraftCodecError):
            parse_claim_v2(raw, packet["binding"])


def unpublished(packet):
    r = claimed(packet)
    i = json.loads(r["normalized_input_text"])
    # Synthetic structured output, not an actual runtime invocation transcript.
    output = {
        "title": i["title"],
        "kind": "board",
        "sections": [
            {
                "type": "executive_summary",
                "title": "Executive summary",
                "body": "Synthetic bounded draft summary.",
            },
            {
                "type": "findings_table",
                "title": "Findings for review (source order)",
                "items": [f | {"risk_points": None} for f in i["findings"]],
            },
            {
                "type": "library",
                "title": "Control library",
                "body": f"Referenced library version: {i['library_version']}. Draft input declares 2 controls; frozen source verification remains required.",
            },
            {
                "type": "attribution",
                "title": "Draft attribution and review status",
                "body": "Generated by Prativedan (v0.1.0). Pending recorded human review. Evidence references are unverified.",
            },
        ],
        "cited_evidence_ids": [],
        "generated_by_agent": "prativedan",
        "rendered_html": "<p>Synthetic draft</p>",
        "review_required": True,
        "citation_verification": "unverified_references",
    }
    runtime = canonical_json(output)
    response = json.dumps(output, ensure_ascii=False, indent=2)
    r.update(
        state="unpublished",
        draft_id="47520000-0000-4000-8000-000000000099",
        runtime_output_text=runtime,
        runtime_output_sha256=sha256_hex(runtime),
        response_output_text=response,
        response_output_sha256=sha256_hex(response),
        output=output,
        started_receipt=receipt(6),
        completed_receipt=receipt(7),
        settled_receipt=receipt(8),
    )
    return r


def test_unpublished_distinct_domains_and_review_never_authorize_publication(packet):
    r = unpublished(packet)
    assert r["runtime_output_sha256"] != r["response_output_sha256"]
    assert parse_readback_v2(r, packet["binding"]).publication_allowed is False
    assert (
        parse_claim_v2(
            {"claimed": False, "invocation_uncertain": True, "readback": r}, packet["binding"]
        ).claimed
        is False
    )
    r["review"] = {
        "actor_id": packet["binding"].actor_id,
        "review_key": "47520000-0000-4000-8000-000000000098",
        "decision": "accepted",
        "reason": "Recorded synthetic human review reason.",
        "response_output_sha256": r["response_output_sha256"],
        "receipt": receipt(9),
    }
    assert parse_readback_v2(r, packet["binding"]).review.decision == "accepted"
    assert parse_readback_v2(r, packet["binding"]).publication_allowed is False


@pytest.mark.parametrize(
    "edit",
    [
        lambda r: r.update(runtime_output_sha256=r["response_output_sha256"]),
        lambda r: r.update(response_output_text=r["response_output_text"] + " "),
        lambda r: r.update(completed_receipt=receipt(6)),
        lambda r: r.update(draft_id="00000000-0000-0000-0000-000000000000"),
        lambda r: r.update(review=None),
        lambda r: r.update(settled_receipt=None),
    ],
)
def test_unpublished_missing_forged_and_substituted_proofs_refused(packet, edit):
    r = unpublished(packet)
    edit(r)
    with pytest.raises(AssessmentDraftCodecError):
        parse_readback_v2(r, packet["binding"])


@pytest.mark.parametrize(
    "edit",
    [
        lambda o: o.update(review_required=1),
        lambda o: o.update(sections=[]),
        lambda o: o["sections"][0].update(body=None),
        lambda o: o["sections"][1]["items"][0].update(score=True),
        lambda o: o["sections"][3].update(body="Human verified and released."),
        lambda o: o.update(cited_evidence_ids=["47520000-0000-4000-8000-000000000001"]),
        lambda o: o.update(extra="Unsupported"),
    ],
)
def test_recomputed_output_hashes_do_not_authorize_changed_business_projection(packet, edit):
    r = unpublished(packet)
    edit(r["output"])
    r["runtime_output_text"] = canonical_json(r["output"])
    r["response_output_text"] = json.dumps(r["output"])
    r["runtime_output_sha256"] = sha256_hex(r["runtime_output_text"])
    r["response_output_sha256"] = sha256_hex(r["response_output_text"])
    with pytest.raises(AssessmentDraftCodecError):
        parse_readback_v2(r, packet["binding"])


def test_boolean_not_equal_numeric_even_with_valid_hashes(packet):
    packet = deepcopy(packet)
    result = json.loads(packet["source"]["result_text"])
    result["estimated_exposure_inr"] = 0
    packet["source"]["result_text"] = json.dumps(result)
    packet["source"]["result_sha256"] = sha256_hex(packet["source"]["result_text"])
    source_text = json.dumps(packet["source"])
    source_hash = sha256_hex(source_text)
    human = json.loads(packet["readback"]["request_text"])
    human["expectedSourceSha256"] = source_hash
    request_text = json.dumps(human)
    packet["readback"].update(
        source_text=source_text,
        source_sha256=source_hash,
        request_text=request_text,
        request_sha256=sha256_hex(request_text),
    )
    packet["binding"] = packet["binding"].model_copy(
        update={"request_text": request_text, "source_sha256": source_hash}
    )
    r = claimed(packet)
    raw = json.loads(r["normalized_input_text"])
    # 0 and False compare equal in ordinary Python JSON equality.
    raw["estimated_exposure_inr"] = False
    assert raw == json.loads(r["normalized_input_text"])
    r["normalized_input_text"] = json.dumps(raw)
    r["runtime_normalized_input_sha256"] = sha256_hex(r["normalized_input_text"])
    with pytest.raises(AssessmentDraftCodecError):
        parse_readback_v2(r, packet["binding"])


@pytest.mark.parametrize(
    "text", ["[" * 42 + "0" + "]" * 42, "NaN", "1e999", '"\\ud800"', '"\\u0000"', "{not-json}"]
)
def test_invalid_deep_nonfinite_and_unrepresentable_json_refused(text):
    with pytest.raises(AssessmentDraftCodecError):
        parse_source_v2(text, "a" * 64)


def test_utf8_byte_bounds_not_just_character_count(packet):
    text, digest = rebind_source(packet, lambda s: s.update(controls_text="अ" * 175000))
    with pytest.raises(AssessmentDraftCodecError):
        parse_source_v2(text, digest)


def test_normalized_request_duplicate_and_changed_actor_cannot_self_bind(packet):
    r = deepcopy(packet["readback"])
    r["request_text"] = r["request_text"].replace(
        '"sourceReviewed": true', '"sourceReviewed": true, "sourceReviewed": true'
    )
    r["request_sha256"] = sha256_hex(r["request_text"])
    binding = packet["binding"].model_copy(update={"request_text": r["request_text"]})
    with pytest.raises(AssessmentDraftCodecError):
        parse_readback_v2(r, binding)


def test_full_unicode_title_sql_permitted_bound(packet):
    text, digest = rebind_source(packet, lambda s: s.update(title="अ" * 300))
    assert project_source_v2(parse_source_v2(text, digest)).title == "अ" * 300


def result_lexeme_source(packet, old, new):
    def edit(source):
        assert old in source["result_text"]
        source["result_text"] = source["result_text"].replace(old, new, 1)
        source["result_sha256"] = sha256_hex(source["result_text"])

    text, digest = rebind_source(packet, edit)
    return text, digest


@pytest.mark.parametrize("token", ["9007199254740992", "-9007199254740992", "9007199254740992.0"])
def test_unsafe_integer_in_nested_control_metadata_refused_after_rehash(packet, token):
    def edit(source):
        controls = json.loads(source["controls_text"])
        controls[0]["scoring"] = {"nested": {"opaque_numeric": 0}}
        source["controls_text"] = json.dumps(controls).replace(
            '"opaque_numeric": 0', '"opaque_numeric": ' + token
        )
        source["controls_sha256"] = sha256_hex(source["controls_text"])
        result = json.loads(source["result_text"])
        result["questionnaire_provenance"]["source_library_digest"] = source["controls_sha256"]
        source["result_text"] = json.dumps(result)
        source["result_sha256"] = sha256_hex(source["result_text"])

    text, digest = rebind_source(packet, edit)
    with pytest.raises(AssessmentDraftCodecError):
        project_source_v2(parse_source_v2(text, digest))


@pytest.mark.parametrize(
    ("old", "new"),
    [
        ('"score": 1e-07', '"score": 1.0000000000000001'),
        ('"posture_score": 30.125', '"posture_score": 30.1250000000000001'),
        ('"known_boolean_question_count": 1', '"known_boolean_question_count": 1.0000000000000001'),
        ('"unknown_count": 1', '"unknown_count": 1.0000000000000001'),
        ('"version": 1', '"version": 1.0000000000000001'),
        (
            '"estimated_exposure_inr": 9007199254740991',
            '"estimated_exposure_inr": 9007199254740991.1',
        ),
        (
            '"estimated_exposure_inr": 9007199254740991',
            '"estimated_exposure_inr": 9007199254740993',
        ),
        ('"score": 1e-07', '"score": 1e-999'),
        ('"score": 1e-07', '"score": 1e99999999999999999999'),
    ],
)
def test_lossy_numeric_lexemes_cannot_be_accepted_after_rehash(packet, old, new):
    text, digest = result_lexeme_source(packet, old, new)
    with pytest.raises(AssessmentDraftCodecError):
        project_source_v2(parse_source_v2(text, digest))


@pytest.mark.parametrize(
    ("old", "new"),
    [
        ('"known_boolean_question_count": 1', '"known_boolean_question_count": 1.0'),
        ('"unknown_count": 1', '"unknown_count": 1.00'),
        (
            '"estimated_exposure_inr": 9007199254740991',
            '"estimated_exposure_inr": 9007199254740991.0',
        ),
        ('"estimated_exposure_inr": 9007199254740991', '"estimated_exposure_inr": 1.0'),
    ],
)
def test_exact_integral_decimal_tokens_match_jsonb_business_values(packet, old, new):
    text, digest = result_lexeme_source(packet, old, new)
    source = parse_source_v2(text, digest)
    projected = project_source_v2(source)
    assert source.result_text in text or json.loads(text)["result_text"] == source.result_text
    assert source.result_sha256 == sha256_hex(source.result_text)
    assert type(projected.estimated_exposure_inr) is int


@pytest.mark.parametrize(
    "stamp",
    [
        "2026-10-13 10:00:00+00:00",
        "20261013T100000+00:00",
        "2026-10-13T10:00:00,1+00:00",
        "2026-10-13T10:00:00.0000001+00:00",
        "2026-10-13T10:00:00+00:60",
    ],
)
def test_timestamp_shorthand_and_truncated_precision_refused(packet, stamp):
    text, digest = rebind_source(packet, lambda s: s.update(completed_at=stamp))
    with pytest.raises(AssessmentDraftCodecError):
        parse_source_v2(text, digest)


def test_first_claim_expiry_requires_identical_raw_stamp(packet):
    r = claimed(packet)
    # Equivalent instants must not conceal a changed retained expiry representation.
    with pytest.raises(AssessmentDraftCodecError):
        parse_claim_v2(
            {"claimed": True, "expires_at": "2026-10-13T10:05:00Z", "readback": r},
            packet["binding"],
        )
    r["claim_expires_at"] = "2026-10-13T10:05:00.0000001+00:00"
    with pytest.raises(AssessmentDraftCodecError):
        parse_claim_v2(
            {"claimed": True, "expires_at": "2026-10-13T10:05:00.0000002+00:00", "readback": r},
            packet["binding"],
        )


def test_review_reason_trims_only_sql_ascii_space(packet):
    r = unpublished(packet)
    r["review"] = {
        "actor_id": packet["binding"].actor_id,
        "review_key": "47520000-0000-4000-8000-000000000098",
        "decision": "accepted",
        "reason": "\tRecorded synthetic review reason.\t",
        "response_output_sha256": r["response_output_sha256"],
        "receipt": receipt(9),
    }
    assert parse_readback_v2(r, packet["binding"]).review is not None
    r["review"]["reason"] = " Recorded synthetic review reason. "
    with pytest.raises(AssessmentDraftCodecError):
        parse_readback_v2(r, packet["binding"])


def test_exact_pg_microseconds_and_timezone_offsets_preserved(packet):
    text, digest = rebind_source(
        packet,
        lambda s: s.update(
            completed_at="2026-10-13T15:30:00.123456+05:30",
            finalized_at="2026-10-13T10:00:01.123456Z",
        ),
    )
    source = parse_source_v2(text, digest)
    assert source.completed_at == "2026-10-13T15:30:00.123456+05:30"
    r = claimed(packet)
    r["claim_expires_at"] = "2026-10-13T15:35:00.123456+05:30"
    assert (
        parse_claim_v2(
            {"claimed": True, "expires_at": r["claim_expires_at"], "readback": r}, packet["binding"]
        ).claimed
        is True
    )
