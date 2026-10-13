import json
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from pydantic import ValidationError

from axiom.agents.base import DispatchContext, RendererDispatchContext
from axiom.agents.prativedan import PrativedanAgent, PrativedanInput
from axiom.canonicalise import canonical_json, sha256_hex
from axiom.ledger_client import AppendOnlyLedgerClient
from axiom.prativedan_draft_dispatch import (
    MAX_OUTPUT_BYTES,
    PrativedanDraftInvokeRequest,
    PrativedanDraftRefusedError,
    PrativedanDraftUncertainError,
    invoke_prativedan_draft,
)
from axiom.prativedan_renderer_config import renderer_commitment, renderer_config

IDS = {
    key: f"47510000-0000-4000-8000-{index:012d}"
    for index, key in enumerate(
        ("tenant_id", "engagement_id", "source_id", "assessment_run_id", "run_id", "operation_key"),
        1,
    )
}
REQUEST = PrativedanDraftInvokeRequest(**IDS)


def reference(number):
    return {"id": str(number), "entry_hash": str(number % 10) * 64}


@pytest.fixture
def harness():
    controls = [
        {
            "id": "C1",
            "title": "Unknown disclosure",
            "severity": "high",
            "library_version": "1.0.0",
            "sdf_only": True,
            "children_only": False,
            "assessment_questions": [{"id": "Q1", "type": "boolean"}],
        }
    ]
    controls_text = canonical_json(controls)
    applicability = {
        key: {"value": None, "provenance": "unknown"}
        for key in ("sdf_self_attested", "processes_children", "processes_health")
    }
    result = {
        "library_version": "1.0.0",
        "posture_score": 30,
        "estimated_exposure_inr": 0,
        "findings": [
            {"control_id": "C1", "score": 30, "risk_points": 5, "rationale": "Answers are unknown."}
        ],
        "questionnaire_provenance": {
            "version": 1,
            "source_library_version": "1.0.0",
            "source_library_digest": sha256_hex(controls_text),
            "estimates": "provisional",
            "review_required": True,
            "controls": [
                {
                    "control_id": "C1",
                    "questions": [{"question_id": "Q1", "declaration": "unknown"}],
                    "known_boolean_question_count": 1,
                    "caller_affirmed_count": 0,
                    "caller_denied_count": 0,
                    "unknown_count": 1,
                    "answer_state": "unknown",
                    "applicability_state": "unknown",
                }
            ],
            "applicability": applicability,
        },
    }
    packet = {
        "schema_version": 1,
        "serialization": "postgres-jsonb-text-v1",
        "kind": "board_source",
        "request_id": IDS["source_id"],
        "tenant_id": IDS["tenant_id"],
        "engagement_id": IDS["engagement_id"],
        "assessment_run_id": IDS["assessment_run_id"],
        "library_version": "1.0.0",
        "controls_text": controls_text,
        "controls_sha256": sha256_hex(controls_text),
        "result_text": canonical_json(result),
        "result_sha256": sha256_hex(canonical_json(result)),
        "completed_at": "2026-10-13T00:00:00+00:00",
        "finalized_at": "2026-10-13T00:01:00+00:00",
        "receipts": {
            key: reference(index)
            for index, key in enumerate(("started", "completed", "finalized"), 1)
        },
        "limitations": ["Caller declarations unverified."],
    }
    witness = {
        key: packet[key]
        for key in (
            "tenant_id",
            "engagement_id",
            "assessment_run_id",
            "library_version",
            "controls_sha256",
            "result_sha256",
            "receipts",
        )
    }
    witness.update(
        source_id=IDS["source_id"],
        title="Unpublished draft",
        source_text=canonical_json(packet),
        source_sha256=sha256_hex(canonical_json(packet)),
    )
    human = {
        "operationKey": IDS["operation_key"],
        "engagementId": IDS["engagement_id"],
        "assessmentRunId": IDS["assessment_run_id"],
        "expectedSourceSha256": witness["source_sha256"],
        "sourceReviewed": True,
    }
    config_version, _, config_hash = renderer_commitment()
    dispatch = {
        **IDS,
        "renderer_config_version": config_version,
        "renderer_config_sha256": config_hash,
        "request_text": canonical_json(human),
        "request_sha256": sha256_hex(canonical_json(human)),
        "source_sha256": witness["source_sha256"],
        "requested_receipt": reference(100),
    }
    claimed = False

    async def claim(**bindings):
        nonlocal claimed
        answer = {**bindings, "claimed": not claimed, "expires_at_ms": 2000}
        claimed = True
        return answer

    appended = []

    async def append(entry):
        appended.append(entry)
        return SimpleNamespace(id=str(100 + len(appended)))

    async def receipts(**bindings):
        rows = []
        for index, entry in enumerate(appended, 101):
            rows.append(
                {
                    **reference(index),
                    **{
                        key: getattr(entry, key)
                        for key in (
                            "tenant_id",
                            "correlation_id",
                            "actor_type",
                            "actor_id",
                            "agent_version",
                            "action_type",
                            "target_ref",
                            "input_hash",
                            "output_hash",
                            "result",
                            "detail",
                        )
                    },
                }
            )
        return {"started": rows[0], "completed": rows[1]}

    store = SimpleNamespace(
        load_prativedan_dispatch=AsyncMock(return_value=dispatch),
        read_prativedan_source=AsyncMock(return_value=witness),
        claim_prativedan_dispatch=AsyncMock(side_effect=claim),
        read_prativedan_runtime_receipts=AsyncMock(side_effect=receipts),
    )
    agent = object.__new__(PrativedanAgent)
    agent.ledger = AppendOnlyLedgerClient.in_memory()
    agent.ledger.append = AsyncMock(side_effect=append)
    agent.log = Mock()
    return SimpleNamespace(
        store=store,
        agent=agent,
        dispatch=dispatch,
        witness=witness,
        packet=packet,
        controls=controls,
        result=result,
        human=human,
        appended=appended,
    )


def rebind(harness):
    packet = harness.packet
    packet["controls_text"] = canonical_json(harness.controls)
    packet["controls_sha256"] = sha256_hex(packet["controls_text"])
    packet["result_text"] = canonical_json(harness.result)
    packet["result_sha256"] = sha256_hex(packet["result_text"])
    for key in ("controls_sha256", "result_sha256", "receipts"):
        harness.witness[key] = packet[key]
    harness.witness["source_text"] = canonical_json(packet)
    harness.witness["source_sha256"] = sha256_hex(harness.witness["source_text"])
    harness.human["expectedSourceSha256"] = harness.witness["source_sha256"]
    harness.dispatch["source_sha256"] = harness.witness["source_sha256"]
    harness.dispatch["request_text"] = canonical_json(harness.human)
    harness.dispatch["request_sha256"] = sha256_hex(harness.dispatch["request_text"])


@pytest.mark.asyncio
async def test_real_base_invocation_proves_separate_actual_byte_domains_and_receipts(harness):
    envelope = await invoke_prativedan_draft(harness.store, REQUEST, harness.agent, now_ms=1000)
    assert envelope.runtime_normalized_input_sha256 == sha256_hex(envelope.normalized_input_text)
    assert '"posture_score":30.0' in envelope.normalized_input_text
    assert envelope.runtime_output_sha256 == sha256_hex(envelope.runtime_output_text)
    assert (
        len(
            {
                envelope.source_sha256,
                envelope.request_sha256,
                envelope.runtime_normalized_input_sha256,
                envelope.runtime_output_sha256,
            }
        )
        == 4
    )
    assert envelope.started_receipt.id == "101"
    assert envelope.completed_receipt.id == "102"
    assert len(harness.appended) == 2
    assert envelope.output["review_required"] is True
    assert envelope.output["citation_verification"] == "unverified_references"
    assert envelope.output["sections"][1]["items"][0]["risk_points"] is None
    assert envelope.output["cited_evidence_ids"] == []
    assert (
        "answer=unknown; applicability=unknown; evidence unverified" in envelope.runtime_output_text
    )
    assert harness.agent.ledger._read_client is None
    with pytest.raises(PermissionError):
        await harness.agent.ledger.load_public_source_dispatch()
    harness.store.claim_prativedan_dispatch.assert_awaited_once()
    with pytest.raises(PrativedanDraftUncertainError):
        await invoke_prativedan_draft(harness.store, REQUEST, harness.agent, now_ms=1000)
    assert len(harness.appended) == 2


@pytest.mark.parametrize(
    "value",
    [
        "ABCDEFAB-0000-4000-8000-000000000001",
        "0" * 32,
        True,
        0,
        "47510000-0000-1000-8000-000000000001",
    ],
)
def test_transport_ids_are_strict_canonical_v4(value):
    with pytest.raises(ValidationError):
        PrativedanDraftInvokeRequest(**{**IDS, "run_id": value})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation",
    [
        "tenant",
        "request_hash",
        "source_hash",
        "unknown_request",
        "numeric_review",
        "receipt_order",
        "legacy",
        "duplicate_control",
        "question_count",
        "question_id",
        "library_hash",
        "applicability",
        "boolean_score",
        "nan",
        "unsafe_exposure",
        "unknown_source",
        "duplicate_json",
        "credentials",
        "nul",
    ],
)
async def test_invalid_or_caller_fabricated_sources_never_claim_or_invoke(harness, mutation):
    if mutation == "tenant":
        harness.witness["tenant_id"] = IDS["run_id"]
    elif mutation == "request_hash":
        harness.dispatch["request_sha256"] = "f" * 64
    elif mutation == "source_hash":
        harness.witness["source_sha256"] = "f" * 64
    elif mutation == "unknown_request":
        harness.human["findings"] = []
        rebind(harness)
    elif mutation == "numeric_review":
        harness.human["sourceReviewed"] = 1
        rebind(harness)
    elif mutation == "receipt_order":
        harness.packet["receipts"]["completed"] = reference(1)
        rebind(harness)
    elif mutation == "legacy":
        del harness.result["questionnaire_provenance"]
        rebind(harness)
    elif mutation == "duplicate_control":
        harness.controls.append(deepcopy(harness.controls[0]))
        rebind(harness)
    elif mutation == "question_count":
        harness.result["questionnaire_provenance"]["controls"][0]["unknown_count"] = 0
        rebind(harness)
    elif mutation == "question_id":
        harness.result["questionnaire_provenance"]["controls"][0]["questions"][0]["question_id"] = (
            "FAKE"
        )
        rebind(harness)
    elif mutation == "library_hash":
        harness.result["questionnaire_provenance"]["source_library_digest"] = "f" * 64
        rebind(harness)
    elif mutation == "applicability":
        harness.result["questionnaire_provenance"]["controls"][0]["applicability_state"] = (
            "unconditional"
        )
        rebind(harness)
    elif mutation == "boolean_score":
        harness.result["findings"][0]["score"] = True
        rebind(harness)
    elif mutation == "nan":
        harness.witness["source_text"] = '{"schema_version":NaN}'
    elif mutation == "unsafe_exposure":
        harness.result["estimated_exposure_inr"] = 9007199254740992
        rebind(harness)
    elif mutation == "unknown_source":
        harness.packet["storage_credential"] = "private"
        rebind(harness)
    elif mutation == "duplicate_json":
        harness.witness["source_text"] = '{"schema_version":1,"schema_version":1}'
    elif mutation == "credentials":
        harness.witness["credential"] = "private"
    elif mutation == "nul":
        harness.witness["title"] = "bad\0title"
    with pytest.raises(
        PrativedanDraftRefusedError, match="Trusted draft source or dispatch was refused"
    ):
        await invoke_prativedan_draft(harness.store, REQUEST, harness.agent, now_ms=1000)
    harness.store.claim_prativedan_dispatch.assert_not_awaited()
    assert harness.appended == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "phase",
    [
        "claim_transport",
        "claim_false",
        "claim_hash",
        "claim_expired",
        "started_failed",
        "completed_failed",
        "receipt_unavailable",
        "receipt_hash",
        "receipt_phase",
        "receipt_run",
        "receipt_duplicate",
        "output_tamper",
        "oversized_output",
    ],
)
async def test_claimed_uncertainty_never_retries_or_backfills(harness, phase):
    if phase.startswith("claim"):
        if phase == "claim_transport":
            harness.store.claim_prativedan_dispatch.side_effect = RuntimeError("raw-source-private")
        else:

            async def claim(**bindings):
                answer = {
                    **bindings,
                    "claimed": phase != "claim_false",
                    "expires_at_ms": 999 if phase == "claim_expired" else 2000,
                }
                if phase == "claim_hash":
                    answer["runtime_normalized_input_sha256"] = "f" * 64
                return answer

            harness.store.claim_prativedan_dispatch.side_effect = claim
    elif phase == "started_failed":
        harness.agent.ledger.append.side_effect = RuntimeError("private")
    elif phase == "completed_failed":
        append = harness.agent.ledger.append.side_effect

        async def fail_completed(entry):
            if entry.detail["phase"] != "started":
                raise RuntimeError("private")
            return await append(entry)

        harness.agent.ledger.append.side_effect = fail_completed
    elif phase == "receipt_unavailable":
        harness.store.read_prativedan_runtime_receipts.side_effect = RuntimeError("private")
    elif phase in ("receipt_hash", "receipt_phase", "receipt_run", "receipt_duplicate"):
        load = harness.store.read_prativedan_runtime_receipts.side_effect

        async def corrupt(**bindings):
            rows = await load(**bindings)
            if phase == "receipt_hash":
                rows["completed"]["output_hash"] = "f" * 64
            elif phase == "receipt_phase":
                rows["completed"]["detail"]["phase"] = "started"
            elif phase == "receipt_run":
                rows["completed"]["detail"]["run_id"] = IDS["source_id"]
            else:
                rows["completed"]["id"] = rows["started"]["id"]
            return rows

        harness.store.read_prativedan_runtime_receipts.side_effect = corrupt
    else:
        invoke = harness.agent.invoke

        async def tamper(*args, **kwargs):
            result = await invoke(*args, **kwargs)
            result.output["rendered_html"] = (
                "x" * (MAX_OUTPUT_BYTES + 1) if phase == "oversized_output" else "forged"
            )
            return result

        harness.agent.invoke = tamper
    with pytest.raises(PrativedanDraftUncertainError, match="controller reconciliation"):
        await invoke_prativedan_draft(harness.store, REQUEST, harness.agent, now_ms=1000)
    harness.store.claim_prativedan_dispatch.assert_awaited_once()
    assert harness.agent.ledger.append.await_count <= 3


@pytest.mark.asyncio
async def test_source_without_risk_value_stays_unverified(harness):
    del harness.result["findings"][0]["risk_points"]
    rebind(harness)
    envelope = await invoke_prativedan_draft(harness.store, REQUEST, harness.agent, now_ms=1000)
    assert envelope.output["sections"][1]["items"][0]["risk_points"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize("risk", [True, -1, 100000, "5"])
async def test_invalid_source_risk_refused_before_claim(harness, risk):
    harness.result["findings"][0]["risk_points"] = risk
    rebind(harness)
    with pytest.raises(PrativedanDraftRefusedError):
        await invoke_prativedan_draft(harness.store, REQUEST, harness.agent, now_ms=1000)
    harness.store.claim_prativedan_dispatch.assert_not_awaited()


@pytest.mark.asyncio
async def test_requested_receipt_cannot_precede_finalized_source(harness):
    harness.dispatch["requested_receipt"] = reference(3)
    with pytest.raises(PrativedanDraftRefusedError):
        await invoke_prativedan_draft(harness.store, REQUEST, harness.agent, now_ms=1000)
    harness.store.claim_prativedan_dispatch.assert_not_awaited()


@pytest.mark.asyncio
async def test_agent_retained_reader_is_refused_before_claim(harness):
    harness.agent.ledger._read_client = object()
    with pytest.raises(PrativedanDraftRefusedError):
        await invoke_prativedan_draft(harness.store, REQUEST, harness.agent, now_ms=1000)
    harness.store.claim_prativedan_dispatch.assert_not_awaited()


@pytest.mark.asyncio
async def test_shared_contract_fixture_replays_actual_python_runtime():
    fixture_path = Path(__file__).resolve().parents[3] / "tests/contracts/prativedan-draft.v1.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    assert fixture["schema_version"] == 1
    assert fixture["synthetic"] is True
    assert fixture["live_workflow_acceptance"] is False
    assert fixture["python_version"].startswith("3.14.")
    for case in fixture["cases"]:
        # A new isolated memory harness per case, never a retained source or SQL ledger.
        current = globals()["harness"].__wrapped__()
        current.store.read_prativedan_source.return_value = case["source_witness"]
        current.store.load_prativedan_dispatch.return_value = case["dispatch"]
        request = PrativedanDraftInvokeRequest.model_validate(case["invoke_request"])
        actual = await invoke_prativedan_draft(current.store, request, current.agent, now_ms=1000)
        assert actual.model_dump(mode="json") == case["envelope"]
        assert len(current.appended) == 2
        assert (
            actual.renderer_config_version,
            actual.renderer_config_text,
            actual.renderer_config_sha256,
        ) == renderer_commitment()
        assert current.store.claim_prativedan_dispatch.await_args.kwargs == case["claim_arguments"]
        assert [entry.detail for entry in current.appended] == case[
            "actual_runtime_receipt_details"
        ]
        assert (
            current.appended[0].input_hash
            == case["receipt_witness"]["runtime_normalized_input_sha256"]
        )
        assert current.appended[1].output_hash == case["receipt_witness"]["runtime_output_sha256"]
        assert sha256_hex(case["source_witness"]["source_text"]) == actual.source_sha256
        assert sha256_hex(case["dispatch"]["request_text"]) == actual.request_sha256


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("renderer_config_sha256", "f" * 64),
        ("renderer_config_version", "prativedan-draft-v2"),
    ],
)
async def test_recorded_config_substitution_refused_before_claim(harness, field, value):
    harness.dispatch[field] = value
    with pytest.raises(PrativedanDraftRefusedError):
        await invoke_prativedan_draft(harness.store, REQUEST, harness.agent, now_ms=1000)
    harness.store.claim_prativedan_dispatch.assert_not_awaited()
    assert harness.appended == []


@pytest.mark.asyncio
@pytest.mark.parametrize("location", ["claim", "started", "completed"])
async def test_claimed_config_substitution_never_redispatches(harness, location):
    if location == "claim":
        claim = harness.store.claim_prativedan_dispatch.side_effect

        async def corrupt(**bindings):
            result = await claim(**bindings)
            result["renderer_config_sha256"] = "f" * 64
            return result

        harness.store.claim_prativedan_dispatch.side_effect = corrupt
    else:
        load = harness.store.read_prativedan_runtime_receipts.side_effect

        async def corrupt(**bindings):
            rows = await load(**bindings)
            rows[location]["detail"]["renderer_config_sha256"] = "f" * 64
            return rows

        harness.store.read_prativedan_runtime_receipts.side_effect = corrupt
    with pytest.raises(PrativedanDraftUncertainError):
        await invoke_prativedan_draft(harness.store, REQUEST, harness.agent, now_ms=1000)
    harness.store.claim_prativedan_dispatch.assert_awaited_once()
    assert len(harness.appended) <= 2


@pytest.mark.asyncio
async def test_base_agent_refuses_caller_config_before_any_receipt(harness):
    result = await harness.agent.invoke(
        PrativedanInput(),
        correlation_id=IDS["operation_key"],
        dispatch_context=RendererDispatchContext(
            run_id=IDS["run_id"],
            request_hash="a" * 64,
            renderer_config_version="prativedan-draft-v1",
            renderer_config_sha256="f" * 64,
        ),
    )
    assert result.status == "failed"
    assert result.error == "validation_failed"
    assert harness.appended == []


@pytest.mark.asyncio
async def test_generic_prativedan_receipt_context_shape_remains_unchanged(harness):
    result = await harness.agent.invoke(
        PrativedanInput(),
        correlation_id=IDS["operation_key"],
        dispatch_context=DispatchContext(run_id=IDS["run_id"], request_hash="a" * 64),
    )
    assert result.status == "succeeded"
    assert harness.appended[0].detail == {
        "phase": "started",
        "run_id": IDS["run_id"],
        "request_hash": "a" * 64,
    }
    assert harness.appended[1].detail == {
        "phase": "completed",
        "started_entry": "101",
        "run_id": IDS["run_id"],
        "request_hash": "a" * 64,
    }


def test_configuration_copy_cannot_mutate_actual_manifest():
    before = renderer_commitment()
    copied = renderer_config()
    copied["finding_limit"] = 999
    copied["posture_bands"][0][1] = "forged"
    assert renderer_commitment() == before
    assert sha256_hex(before[1]) == before[2]
