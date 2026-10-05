#!/usr/bin/env python3
"""Regression probes in a disposable database; every replacement rolls back."""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess  # nosec B404
from pathlib import Path


def function(source: str, name: str) -> str:
    start = source.index(f"create function public.{name}(")
    end = source.index("end $$;", start) + len("end $$;")
    return source[start:end].replace("create function", "create or replace function", 1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("container", help="An explicitly selected disposable test container")
    args = parser.parse_args()
    if re.fullmatch(r"axiom-db-test-[0-9]+|axiom-w2-review-db", args.container) is None:
        raise RuntimeError("Only a disposable operator-workflow test container is allowed")
    docker = shutil.which("docker")
    if docker is None:
        raise RuntimeError("Docker executable unavailable")
    root = Path(__file__).resolve().parents[2]
    migration = (root / "infra/supabase/migrations/0111_operator_workflows.sql").read_text()
    tests = (root / "tests/database/operator-workflows.test.sql").read_text()
    probes = [
        ("actor_conflict", "record_operator_workflow", "prior.created_by<>p_actor_id", "false"),
        (
            "payload_conflict",
            "record_operator_workflow",
            "prior.payload is distinct from p_payload",
            "false",
        ),
        (
            "membership_before_replay",
            "operator_workflow_context",
            "r not in ('founder','owner','admin')",
            "false",
        ),
        ("closed_engagement", "operator_workflow_source", " and status<>'cancelled'", ""),
        (
            "source_ropa",
            "operator_workflow_source",
            "if not found then return jsonb_build_object('error','source_refused');end if;",
            "if false then return jsonb_build_object('error','source_refused');end if;",
        ),
        (
            "review_founder",
            "review_policy_draft",
            "if not public.report_founder_allowed(p_tenant_id, p_actor_id) then",
            "if false then",
        ),
        (
            "review_digest",
            "review_policy_draft",
            "if v_draft.content_sha256 is distinct from p_expected_hash then",
            "if false then",
        ),
        ("delivery_integer", "operator_workflow_valid", "p->>key !~ '^[0-9]+$'", "false"),
        ("required_unknowns", "operator_workflow_valid", "not p ?& required", "false"),
        (
            "reader_tenant",
            "read_operator_workflow",
            "tenant_id=p_tenant_id and id=p_record_id",
            "id=p_record_id",
        ),
        (
            "cancel_tombstone",
            "record_operator_workflow",
            "select * into cancelled from public.operator_workflow_cancellations where tenant_id=p_tenant_id and operation_key=p_operation_key;\n if found then",
            "select * into cancelled from public.operator_workflow_cancellations where tenant_id=p_tenant_id and operation_key=p_operation_key;\n if false then",
        ),
        (
            "cancel_actor_conflict",
            "cancel_operator_workflow",
            "cancelled.created_by<>p_actor_id",
            "false",
        ),
        (
            "review_history_identity",
            "read_operator_policy_review",
            "d.reviewed_by is distinct from review_record.created_by",
            "false",
        ),
    ]
    for label, name, old, new in probes:
        definition = function(migration, name)
        if name == "review_policy_draft":
            # The wrapper founder gate also protects review. Deliberately call
            # the reason-bound overload directly to exercise its own gate.
            tests_for_probe = tests.replace(
                "select pg_temp.ok(pg_temp.record('policy_review',(select r from workflow_fixture where k='review_payload'),141)->>'error'='founder_authority_required','owner cannot review');",
                "select pg_temp.ok(public.review_policy_draft(pg_temp.id(11),pg_temp.id(1),(select (r->'data'->>'id')::uuid from workflow_fixture where k='policy'),'approved',(select r->'data'->>'content_sha256' from workflow_fixture where k='policy'),gen_random_uuid(),'Human reason')->>'error'='founder_authority_required','owner cannot directly review');",
            )
        else:
            tests_for_probe = tests
        if old not in definition:
            raise RuntimeError(f"Mutation target absent: {label}")
        # For source_ropa, remove only the source-RoPA lookup refusal, retaining
        # observation checks and all other source validation.
        replacement = definition.replace(old, new, 1)
        if label == "source_ropa":
            replacement = definition[: definition.rindex(old)] + definition[
                definition.rindex(old) :
            ].replace(old, new, 1)
        sql = "begin;\n" + replacement + "\n" + tests_for_probe
        # Trusted Docker executable and fixed database; no shell evaluation or
        # external credentials. All SQL data and schema writes are rolled back.
        result = subprocess.run(  # nosec B603
            [
                str(Path(docker).resolve()),
                "exec",
                "-i",
                args.container,
                "psql",
                "-X",
                "-U",
                "postgres",
                "-d",
                "axiom_policy_test",
                "-v",
                "ON_ERROR_STOP=1",
            ],
            input=sql,
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode == 0 or "ASSERTION" not in result.stderr:
            raise RuntimeError(f"Mutation not caught by an assertion: {label}\n{result.stderr}")
        print(f"{label}: caught")


if __name__ == "__main__":
    main()
