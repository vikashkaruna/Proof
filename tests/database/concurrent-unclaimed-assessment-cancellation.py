#!/usr/bin/env python3
"""Deterministic cancellation races, exclusively on an explicitly owned fixture.

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
assert re.fullmatch(r"[a-f0-9]{64}", container)
assert re.fullmatch(r"axiom_assessment_cancel_test[a-zA-Z0-9_]*", database)


def owned():
    actual = json.loads(subprocess.check_output(["docker", "inspect", container]))[0]
    assert actual["Id"] == container and actual["Name"] == "/" + proof["name"]
    labels = actual["Config"]["Labels"]
    assert labels["com.axiom.fixture"] == "assessment-cancel-test"
    assert labels["com.axiom.owner-worktree"] == proof["ownerWorktree"] == str(ROOT)
    assert labels["com.axiom.fixture.project"] == proof["project"]
    assert actual["NetworkSettings"]["Ports"]["5432/tcp"] == [
        {"HostIp": "127.0.0.1", "HostPort": str(proof["loopbackPort"])}
    ]


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
    assert expected in paths[1].read_text(), (name, paths[1].read_text())
    for path in paths:
        path.chmod(0o600)
    print(name + ": observed actual blocked contender and expected committed outcome")


schema = "cancel_race"
seed = (
    (ROOT / "tests/database/unclaimed-assessment-cancellation.test.sql")
    .read_text()
    .split("do $$declare r text;")[0]
)
seed = (
    seed.replace("begin;", "", 1)
    .replace("temporary table", "table")
    .replace("pg_temp", schema)
)
seed = re.sub(r"create table ([a-z_]+)", r"create table cancel_race.\1", seed)
seed = (
    seed.replace(
        "insert into cancel_assertions", "insert into cancel_race.cancel_assertions"
    )
    .replace("on cancel_assertions", "on cancel_race.cancel_assertions")
    .replace("update cancel_assertions", "update cancel_race.cancel_assertions")
    .replace("on cancel_policy", "on cancel_race.cancel_policy")
    .replace("from cancel_policy", "from cancel_race.cancel_policy")
)
# A fresh fixture/schema is required. Re-running cannot silently replace prior evidence.
sql(
    "begin; create schema cancel_race; grant usage on schema cancel_race to human_action_writer,axiom_assessment_controller;\n"
    + seed
    + "; commit;"
)
sql(
    "set role human_action_writer; insert into cancel_race.cancel_policy select public.publish_assessment_dispatch_key_policy(cancel_race.id(11),cancel_race.id(1),cancel_race.id(51),0,'aws','arn:aws:kms:ap-south-1:123456789012:key/'||cancel_race.id(61)::text,array['arn:aws:kms:ap-south-1:123456789012:key/'||cancel_race.id(61)::text]); select cancel_race.enqueue(71); select cancel_race.enqueue(72); select cancel_race.enqueue(73); select cancel_race.enqueue(74); select cancel_race.enqueue(75); select cancel_race.enqueue(76);"
)
sql(
    "grant select on cancel_race.cancel_policy to axiom_assessment_controller; create function cancel_race.claim(n int) returns jsonb language sql as $$select public.claim_assessment_dispatch(cancel_race.id(11),cancel_race.id(n),1,(select value->>'fingerprint' from cancel_race.cancel_policy))$$; grant execute on all functions in schema cancel_race to human_action_writer,axiom_assessment_controller;"
)
sql(
    "insert into controller_security.credentials(id,tenant_id,expires_at) values(cancel_race.id(91),cancel_race.id(11),clock_timestamp()+interval '1 hour')"
)
controller = "select set_config('request.jwt.claims',jsonb_build_object('role','axiom_assessment_controller','sub',cancel_race.id(91),'tenant_id',cancel_race.id(11),'iat',floor(extract(epoch from now())),'exp',floor(extract(epoch from now()))+1800)::text,false); "
race(
    "cancel-before-claim",
    "set local role human_action_writer; select cancel_race.cancel(71)",
    controller + "set role axiom_assessment_controller; select cancel_race.claim(71)",
    "dispatch_unavailable",
)
race(
    "claim-before-cancel",
    controller
    + "set local role axiom_assessment_controller; select cancel_race.claim(72)",
    "set role human_action_writer; select cancel_race.cancel(72)",
    "assessment_not_unclaimed",
)
race(
    "duplicate-cancel",
    "set local role human_action_writer; select cancel_race.cancel(73)",
    "set role human_action_writer; select cancel_race.cancel(73)",
    "cancellation_receipt",
)
race(
    "membership-revoked-before-cancel",
    "update public.tenant_users set role='viewer' where tenant_id=cancel_race.id(11) and user_id=cancel_race.id(1)",
    "set role human_action_writer; select cancel_race.cancel(74)",
    "forbidden",
)
sql(
    "update public.tenant_users set role='owner' where tenant_id=cancel_race.id(11) and user_id=cancel_race.id(1)"
)
race(
    "kill-switch-before-cancel",
    "update public.kill_switch_state set engaged=true where scope_key='global'",
    "set role human_action_writer; select cancel_race.cancel(75)",
    "kill_switch_engaged",
)
sql(
    "update public.kill_switch_state set engaged=false where scope_key='global'; grant usage on schema cancel_race to service_role; create function cancel_race.start(n int) returns jsonb language sql as $$select public.start_workload_assessment(tenant_id,run_id,workload_identity_id,proof_hash,input_hash,expires_at) from public.workload_task_delegations where run_id=(select run_id from public.assessment_dispatch_jobs where id=cancel_race.id(n))$$; grant execute on function cancel_race.start(int) to service_role;"
)
race(
    "worker-start-before-cancel",
    "set local role service_role; select cancel_race.start(76)",
    "set role human_action_writer; select cancel_race.cancel(76)",
    "assessment_already_started",
)
assert (
    sql(
        "select claimed_at is null from public.assessment_dispatch_jobs where id=cancel_race.id(71)"
    ).strip()
    == "t"
)
assert (
    sql(
        "select claimed_at is not null from public.assessment_dispatch_jobs where id=cancel_race.id(72)"
    ).strip()
    == "t"
)
assert (
    sql(
        "select count(*) from public.assessment_request_resolutions where job_id=cancel_race.id(72)"
    ).strip()
    == "0"
)
assert (
    sql(
        "select count(*) from public.audit_ledger where tenant_id=cancel_race.id(11) and action_type='assessment.request_cancelled'"
    ).strip()
    == "2"
)
assert (
    sql(
        "select count(*) from public.workload_assessment_packets where tenant_id=cancel_race.id(11)"
    ).strip()
    == "1"
)
first = json.loads(
    (args.evidence / "duplicate-cancel-first.log").read_text().splitlines()[0]
)
second = json.loads(
    (args.evidence / "duplicate-cancel-second.log").read_text().splitlines()[0]
)
assert first == second
print(
    "Cancellation races: no claimed request cancelled, one immutable receipt per cancelled job, one real worker-start packet retained and no invented cleanup."
)
