#!/usr/bin/env python3
"""Deterministic Sudhaar output races, exclusively on an explicitly owned fixture.

Run after all migrations with --fixture-proof pointing at a private JSON record
of containerId/name/ownerWorktree/project/loopbackPort/database. No cleanup of
retained operator containers, no service-role enqueue and no timeout-as-proof.
"""

import argparse
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("--fixture-proof", type=Path, required=True)
parser.add_argument("--evidence", type=Path, required=True)
args = parser.parse_args()
proof = json.loads(args.fixture_proof.read_text())
args.evidence.mkdir(parents=True, exist_ok=True, mode=0o700)
container, database = proof["containerId"], proof["database"]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


require(re.fullmatch(r"[a-f0-9]{64}", container), "Immutable fixture ID required")
require(
    re.fullmatch(r"axiom_sudhaar_output_test[a-zA-Z0-9_]*", database)
    or database == "axiom_policy_test",
    "Dedicated Sudhaar output fixture database required",
)


def owned():
    actual = json.loads(subprocess.check_output(["docker", "inspect", container]))[0]
    require(
        actual["Id"] == container and actual["Name"] == "/" + proof["name"],
        "Fixture identity changed",
    )
    labels = actual["Config"]["Labels"]
    fixture_class = labels["com.axiom.fixture"]
    require(
        fixture_class in {"sudhaar-output-test", "database-policy-test"},
        "Fixture class changed",
    )
    require(
        fixture_class != "database-policy-test"
        or (
            re.fullmatch(r"axiom-db-test-[0-9]+", proof["name"])
            and proof["project"] == "axiom-db-tests"
        ),
        "Policy fixture ownership refused",
    )
    require(
        database != "axiom_policy_test" or fixture_class == "database-policy-test",
        "Policy database class refused",
    )
    require(
        labels["com.axiom.owner-worktree"] == proof["ownerWorktree"] == str(ROOT),
        "Fixture owner changed",
    )
    require(
        labels["com.axiom.fixture.project"] == proof["project"],
        "Fixture project changed",
    )
    require(
        actual["NetworkSettings"]["Ports"]["5432/tcp"]
        == (
            None
            if fixture_class == "database-policy-test"
            else [{"HostIp": "127.0.0.1", "HostPort": str(proof["loopbackPort"])}]
        ),
        "Fixture loopback binding changed",
    )


def sql(source):
    owned()
    return subprocess.check_output(
        [
            "docker",
            "exec",
            "-i",
            container,
            "psql",
            "-X",
            "-U",
            "postgres",
            "-d",
            database,
            "-v",
            "ON_ERROR_STOP=1",
            "-Atq",
        ],
        input=source.encode(),
    ).decode()


def race(name, first, second, expected):
    owned()
    paths = [
        args.evidence / (name + suffix)
        for suffix in ["-first.log", "-second.log", "-status"]
    ]
    subprocess.run(
        [
            "python3",
            str(ROOT / "tests/database/lib/concurrency-barrier.py"),
            container,
            "postgres",
            first,
            second,
            *map(str, paths),
            "blocked",
            "success",
            "",
            database,
        ],
        check=True,
    )
    require(expected in paths[1].read_text(), name + ": " + paths[1].read_text())
    for path in paths:
        path.chmod(0o600)
    print(name + ": observed actual blocked contender and expected committed outcome")


seed = (
    (ROOT / "tests/database/sudhaar-settled-outputs.test.sql")
    .read_text()
    .split("select pg_temp.ok(pg_temp.recover()->>")[0]
)
seed = (
    seed.replace("begin;", "", 1)
    .replace("temporary table", "table")
    .replace("pg_temp.", "sudhaar_race.")
    # Other suites persist their common synthetic b64 proof in the combined DB.
    # Keep this fixture's actual delegation/start/completion proof consistent
    # while giving it a namespace distinct from every preceding worker race.
    .replace(
        "repeat('b',64)",
        "encode(sha256(convert_to('sudhaar-output-race:99750000-0000-4000-8000-000000000041','UTF8')),'hex')",
    )
)
sql(
    "create schema sudhaar_race;grant usage on schema sudhaar_race to human_action_writer,agent_ledger_writer;"
    + seed
)
actor = "99750000-0000-4000-8000-000000000001"
tenant = "99750000-0000-4000-8000-000000000010"
member = (
    "update public.tenant_users set role='viewer' where user_id='"
    + actor
    + "' and tenant_id='"
    + tenant
    + "';select 'updated';"
)
restore_member = (
    "update public.tenant_users set role='admin' where user_id='"
    + actor
    + "' and tenant_id='"
    + tenant
    + "';"
)
race(
    "atomic_capture_duplicate",
    "select sudhaar_race.capture();",
    "select sudhaar_race.capture();",
    '"replayed": true',
)
race(
    "recover_after_committed_capture",
    "select sudhaar_race.capture();",
    "select sudhaar_race.recover();",
    '"output_text":',
)
race(
    "membership_before_recovery",
    member,
    "select sudhaar_race.recover();",
    "output_context_refused",
)
sql(restore_member)
race("capture_before_membership", "select sudhaar_race.capture();", member, "updated")
sql(restore_member)
race(
    "kill_before_recovery",
    "update public.kill_switch_state set engaged=true where scope_key='global';",
    "select sudhaar_race.recover();",
    "output_context_refused",
)
sql("update public.kill_switch_state set engaged=false where scope_key='global';")
race(
    "findings_before_recovery",
    "update public.findings set score=12 where engagement_id=(select engagement from output_fixture);",
    "select sudhaar_race.recover();",
    "output_context_refused",
)
sql(
    "update public.findings set score=85 where engagement_id=(select engagement from output_fixture);"
)
race(
    "recovery_before_capture",
    "select sudhaar_race.recover();",
    "select sudhaar_race.capture();",
    '"replayed": true',
)
require(
    sql("select count(*) from public.sudhaar_settled_outputs;").strip() == "1",
    "duplicate capture inserted multiple outputs",
)
require(
    sql(
        "select count(*) from public.audit_ledger where action_type='agent.invocation.settled' and target_ref=(select run::text from output_fixture);"
    ).strip()
    == "1",
    "duplicate capture settled twice",
)
print("Seven real blocked races and one immutable output/settlement verified")
