"""Synthetic harness regressions only; no PostgreSQL or runtime receipts proved."""

import asyncio
import json
import subprocess
from copy import deepcopy
from pathlib import Path

import pytest
from prativedan_assessment_interop import build_artifact
from test_prativedan_assessment_draft_codec import claimed
from test_prativedan_assessment_draft_codec import packet as packet_fixture

from axiom.prativedan_assessment_draft_codec import parse_source_v2, project_source_v2

NODE_AVAILABLE = (Path(__file__).resolve().parents[3] / "node_modules/.bin/tsx").is_file()


@pytest.fixture
def synthetic_fixture():
    packet = packet_fixture.__wrapped__()
    readback = claimed(packet)
    fixture = {
        "schema_version": 1,
        "fixture_kind": "disposable_postgres_assessment_v2",
        "requested_readback": packet["readback"],
        "sql_input_projection": project_source_v2(
            parse_source_v2(packet["readback"]["source_text"], packet["readback"]["source_sha256"])
        ).model_dump(mode="json"),
        "expected_binding": packet["binding"].model_dump(),
        "claim_first": {
            "claimed": True,
            "expires_at": readback["claim_expires_at"],
            "readback": readback,
        },
        "claim_replay": {
            "claimed": False,
            "invocation_uncertain": True,
            "readback": deepcopy(readback),
        },
    }
    rows = [
        {
            "id": ref["id"],
            "entry_hash": ref["entry_hash"],
            "tenant_id": readback["tenant_id"],
            "action_type": "synthetic.assessment",
        }
        for ref in packet["source"]["receipts"].values()
    ]
    common = {
        "tenant_id": readback["tenant_id"],
        "correlation_id": readback["operation_key"],
        "target_ref": readback["run_id"],
    }
    rows.extend(
        [
            {
                **common,
                **readback["requested_receipt"],
                "action_type": "prativedan.draft.requested",
                "actor_type": "human",
                "actor_id": readback["actor_id"],
                "input_hash": readback["request_sha256"],
                "output_hash": readback["source_sha256"],
            },
            {
                **common,
                **readback["claimed_receipt"],
                "action_type": "prativedan.draft.claimed",
                "actor_type": "system",
                "actor_id": "prativedan-draft-controller",
                "input_hash": readback["runtime_normalized_input_sha256"],
            },
        ]
    )
    fixture["actual_ledger_rows"] = rows  # Synthetic matching rows, never real custody evidence.
    return fixture


def write_private(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    path.chmod(0o600)


def artifacts(tmp_path, fixture):
    tmp_path.chmod(0o700)
    initial_fixture = {
        k: v
        for k, v in fixture.items()
        if k not in {"claim_first", "claim_replay", "actual_ledger_rows"}
    }
    for phase, data in [("initial", initial_fixture), ("final", fixture)]:
        directory = tmp_path / phase
        directory.mkdir(mode=0o700)
        write_private(directory / "renderer.json", asyncio.run(build_artifact(data)))
    write_private(tmp_path / "pg-fixture.json", fixture)


def node_check(directory):
    return subprocess.run(
        [
            "pnpm",
            "exec",
            "tsx",
            "scripts/check-prativedan-assessment-interoperability.ts",
            str(directory),
        ],
        cwd=Path(__file__).resolve().parents[3],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


def test_synthetic_initial_and_final_phase_mapping(tmp_path, synthetic_fixture):
    artifacts(tmp_path, synthetic_fixture)
    initial = json.loads((tmp_path / "initial/renderer.json").read_text())
    final = json.loads((tmp_path / "final/renderer.json").read_text())
    assert initial["prepared_readback"]["state"] == "requested"
    assert final["prepared_readback"] == synthetic_fixture["claim_first"]["readback"]
    assert not final["runtime_receipts_proven"]
    assert not final["settlement_proven"]


@pytest.mark.skipif(
    not NODE_AVAILABLE, reason="Node checker requires installed locked JS workspace"
)
def test_synthetic_node_accepts_mapped_phases(tmp_path, synthetic_fixture):
    artifacts(tmp_path, synthetic_fixture)
    result = node_check(tmp_path)
    assert result.returncode == 0, result.stderr
    verification = json.loads((tmp_path / "ts-verification.json").read_text())
    assert not verification["runtimeReceiptsProven"]
    assert not verification["publicationAllowed"]


@pytest.mark.parametrize("change", ["stale_final", "public_file", "symlink_phase"])
@pytest.mark.skipif(
    not NODE_AVAILABLE, reason="Node checker requires installed locked JS workspace"
)
def test_synthetic_node_refuses_mapping_and_protection_changes(tmp_path, synthetic_fixture, change):
    artifacts(tmp_path, synthetic_fixture)
    final_path = tmp_path / "final/renderer.json"
    if change == "stale_final":
        final = json.loads(final_path.read_text())
        final["prepared_readback"] = synthetic_fixture["requested_readback"]
        write_private(final_path, final)
    elif change == "public_file":
        final_path.chmod(0o644)
    else:
        (tmp_path / "final").rename(tmp_path / "redirected")
        (tmp_path / "final").symlink_to(tmp_path / "redirected", target_is_directory=True)
    result = node_check(tmp_path)
    assert result.returncode == 1
    assert result.stderr.strip() == "Dedicated assessment synthetic interoperability refused."
    assert not (tmp_path / "ts-verification.json").exists()
    assert not (tmp_path / "final/ts-response-output.json").exists()
