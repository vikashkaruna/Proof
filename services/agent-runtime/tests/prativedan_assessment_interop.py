"""CI-only pure rendering of a scoped disposable PostgreSQL assessment fixture.

No BaseAgent invocation/constructor, ledger client, model gateway, store or
network transport runs here. The artifact explicitly lacks runtime completion
and settlement evidence; real source/request/claim rows remain separate.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import stat
import sys
from pathlib import Path
from typing import Any

from axiom.agents.prativedan import PrativedanAgent
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


def protected(path: Path, *, directory: bool) -> None:
    if not path.is_absolute() or path.resolve() != path or path.is_symlink():
        raise ValueError("Protected path must be absolute without symlinks")
    info = path.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != (0o700 if directory else 0o600):
        raise ValueError("Protected path ownership/mode refused")
    if directory != path.is_dir() or (not directory and not path.is_file()):
        raise ValueError("Protected path kind refused")


def read_fixture(path: Path) -> dict[str, Any]:
    protected(path, directory=False)
    if path.stat().st_size > 8_388_608:
        raise ValueError("Fixture byte bound exceeded")

    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate fixture JSON member")
            result[key] = value
        return result

    def invalid(_: str) -> None:
        raise ValueError("Nonfinite fixture JSON")

    raw = json.loads(
        path.read_text(encoding="utf-8"), object_pairs_hook=unique, parse_constant=invalid
    )
    if not isinstance(raw, dict):
        raise ValueError("Fixture object required")
    return raw


def verify_actual_rows(fixture: dict[str, Any]) -> None:
    """Check captured rows against actual PG references; no runtime rows fabricated."""
    first = fixture["claim_first"]["readback"]
    source = json.loads(first["source_text"])
    rows = fixture["actual_ledger_rows"]
    if not isinstance(rows, list) or not 1 <= len(rows) <= 20:
        raise ValueError("Captured actual ledger rows refused")
    by_id = {row["id"]: row for row in rows}
    if len(by_id) != len(rows) or any(row["tenant_id"] != first["tenant_id"] for row in rows):
        raise ValueError("Captured ledger scope refused")
    refs = [
        *source["receipts"].values(),
        first["requested_receipt"],
        first["claimed_receipt"],
    ]
    for reference in refs:
        row = by_id.get(reference["id"])
        if row is None or row["entry_hash"] != reference["entry_hash"]:
            raise ValueError("Captured receipt reference mismatch")
    requested = by_id[first["requested_receipt"]["id"]]
    claimed = by_id[first["claimed_receipt"]["id"]]
    if (
        requested["action_type"] != "prativedan.draft.requested"
        or requested["actor_type"] != "human"
        or requested["actor_id"] != first["actor_id"]
        or requested["input_hash"] != first["request_sha256"]
        or requested["output_hash"] != first["source_sha256"]
        or requested["correlation_id"] != first["operation_key"]
        or requested["target_ref"] != first["run_id"]
        or claimed["action_type"] != "prativedan.draft.claimed"
        or claimed["actor_type"] != "system"
        or claimed["actor_id"] != "prativedan-draft-controller"
        or claimed["input_hash"] != first["runtime_normalized_input_sha256"]
        or claimed["correlation_id"] != first["operation_key"]
        or claimed["target_ref"] != first["run_id"]
        or any(
            row["action_type"]
            in ("report.generated", "prativedan.draft.settled", "prativedan.draft.reviewed")
            for row in rows
        )
    ):
        raise ValueError("Actual request/claim declaration mismatch or fabricated runtime evidence")


async def build_artifact(fixture: dict[str, Any]) -> dict[str, Any]:
    base_keys = {
        "schema_version",
        "fixture_kind",
        "requested_readback",
        "sql_input_projection",
        "expected_binding",
    }
    claim_keys = {"claim_first", "claim_replay", "actual_ledger_rows"}
    if (
        set(fixture) not in (base_keys, base_keys | claim_keys)
        or type(fixture.get("schema_version")) is not int
        or fixture["schema_version"] != 1
        or fixture["fixture_kind"] != "disposable_postgres_assessment_v2"
    ):
        raise ValueError("Dedicated PostgreSQL fixture shape refused")
    binding = AssessmentDraftBinding.model_validate(fixture["expected_binding"])
    journal = parse_readback_v2(fixture["requested_readback"], binding)
    if journal.state != "requested":
        raise ValueError("Fixture must start from genuine unclaimed request")
    source = parse_source_v2(journal.source_text, journal.source_sha256)
    input_model = project_source_v2(source)
    input_value = input_model.model_dump(mode="json")
    # Business-value comparison only: PG/Python numeric byte canonicalization
    # is explicitly different, and bool is never a numeric declaration.
    if not same_business_value(fixture["sql_input_projection"], input_value):
        raise ValueError("Python projection differs from actual SQL projection")
    normalized_text = canonical_json(input_value)
    if claim_keys <= set(fixture):
        first = parse_claim_v2(fixture["claim_first"], binding)
        replay = parse_claim_v2(fixture["claim_replay"], binding)
        if (
            first.claimed is not True
            or replay.claimed is not False
            or first.readback.normalized_input_text != normalized_text
            or replay.readback.model_dump() != first.readback.model_dump()
        ):
            raise ValueError("Actual PG claim/replay did not retain exact Python bytes")
        verify_actual_rows(fixture)
    # Deliberately bypass BaseAgent.__init__: _run uses only immutable renderer
    # config and pure helpers, constructing no clients or service dependencies.
    renderer = object.__new__(PrativedanAgent)
    rendered = await renderer._run(correlation_id=journal.operation_key, input=input_model)
    output = rendered.model_dump(mode="json")
    runtime_text = canonical_json(output)
    # This is a representation artifact for a future TS serializer comparison,
    # not a claim that Python emitted the actual TypeScript byte domain.
    response_text = json.dumps(output, ensure_ascii=False, separators=(",", ":"))
    version, config_text, config_hash = renderer_commitment()
    return {
        "schema_version": 1,
        "evidence_kind": "pure_renderer_from_disposable_pg_source",
        "prepared_readback": (
            fixture["claim_first"]["readback"]
            if claim_keys <= set(fixture)
            else fixture["requested_readback"]
        ),
        "expected_binding": fixture["expected_binding"],
        "normalized_input_text": normalized_text,
        "runtime_normalized_input_sha256": sha256_hex(normalized_text),
        "renderer_config_version": version,
        "renderer_config_text": config_text,
        "renderer_config_sha256": config_hash,
        "runtime_output_text": runtime_text,
        "runtime_output_sha256": sha256_hex(runtime_text),
        "python_output_representation_text": response_text,
        "python_output_representation_sha256": sha256_hex(response_text),
        "output": output,
        "runtime_receipts_proven": False,
        "settlement_proven": False,
        "publication_allowed": False,
    }


def same_business_value(left: object, right: object) -> bool:
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(
            same_business_value(left[k], right[k]) for k in left
        )
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(
            same_business_value(a, b) for a, b in zip(left, right, strict=True)
        )
    if type(left) in (int, float) and type(right) in (int, float):
        return left == right
    return type(left) is type(right) and left == right


def write_text(path: Path, text: str) -> None:
    with path.open("x", encoding="utf-8") as stream:
        stream.write(text)
    path.chmod(0o600)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    if sys.version_info < (3, 14):  # noqa: UP036 - Explicit CI interpreter fence.
        parser.error("Python3.14+ required")
    try:
        protected(args.output_dir, directory=True)
        if any(args.output_dir.iterdir()):
            raise ValueError("Output must be empty; existing evidence is never overwritten")
        artifact = asyncio.run(build_artifact(read_fixture(args.fixture)))
        write_text(args.output_dir / "normalized-input.txt", artifact["normalized_input_text"])
        write_text(
            args.output_dir / "renderer.json", json.dumps(artifact, ensure_ascii=False, indent=2)
        )
        print(
            "Actual source byte/projection contract validated; pure renderer emitted without runtime ledger invocation."
        )
        return 0
    except ValueError, TypeError, KeyError, OSError, RecursionError, AssessmentDraftCodecError:
        print("Prativedan assessment interoperability refused", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
