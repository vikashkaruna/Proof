#!/usr/bin/env python3
"""Deterministic human review adoption races, exclusively on an explicitly owned fixture.

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



sql("create schema adoption_race;grant usage on schema adoption_race to human_action_writer;"+"-- Appended to the real finalized-source/runtime-output fixture by the runner.\ncreate table review_fixture as select gen_random_uuid() adoption,\n 'Review the declared unknown answers with supporting evidence.'::text reason;\ngrant select on output_fixture,review_fixture to human_action_writer;\ncreate function adoption_race.adopt(overrides jsonb default '{}'::jsonb) returns jsonb language plpgsql as $$\ndeclare f output_fixture; v review_fixture; d jsonb; prior text:=current_user; a uuid; reason text; body jsonb; h text;\nbegin\n select * into f from output_fixture; select * into v from review_fixture;\n a:=coalesce((overrides->>'adoption')::uuid,v.adoption);reason:=coalesce(overrides->>'reason',v.reason);\n body:=jsonb_build_object('tenantId',f.tenant,'actorId',f.actor,'proposalOperationKey',f.operation,'adoptionKey',a,'acknowledgeReviewOnly',true,'reason',reason);\n h:=sudhaar_race.hash(controller_security.canonical_questionnaire_json(body));\n set local role human_action_writer;\n d:=public.adopt_sudhaar_review(f.tenant,coalesce((overrides->>'actor')::uuid,f.actor),f.operation,a,reason,\n  coalesce((overrides->>'ack')::boolean,true),h,\n  coalesce(overrides->>'inputHash',sudhaar_race.hash(f.input)),coalesce(overrides->>'outputHash',sudhaar_race.hash(f.output)));\n execute format('set local role %I',prior);return d;\nend $$;\n-- Canonical encoder is private: compute exact body before changing SQL role.\n")
actor="99750000-0000-4000-8000-000000000001"
tenant="99750000-0000-4000-8000-000000000010"
member="update public.tenant_users set role='viewer' where user_id='"+actor+"' and tenant_id='"+tenant+"';select 'updated';"
restore_member="update public.tenant_users set role='admin' where user_id='"+actor+"' and tenant_id='"+tenant+"';"
race("adoption_duplicate", "select adoption_race.adopt();", "select adoption_race.adopt();", '"planId":')
race("adoption_changed_reason", "select adoption_race.adopt();", "select adoption_race.adopt('{\"reason\":\"Different reasoning with supporting evidence.\"}'::jsonb);", "review_adoption_conflict")
race("membership_before_adoption_replay",member,"select adoption_race.adopt();","review_source_unavailable")
sql(restore_member)
race("adoption_replay_before_membership","select adoption_race.adopt();",member,"updated")
sql(restore_member)
race("source_before_adoption_replay","update public.findings set score=12 where engagement_id=(select engagement from output_fixture);select 'changed';","select adoption_race.adopt();","review_source_unavailable")
sql("update public.findings set score=85 where engagement_id=(select engagement from output_fixture);")
race("adoption_replay_before_source","select adoption_race.adopt();","update public.findings set score=12 where engagement_id=(select engagement from output_fixture);select 'changed';","changed")
sql("update public.findings set score=85 where engagement_id=(select engagement from output_fixture);")
race("kill_before_adoption_replay","update public.kill_switch_state set engaged=true where scope_key='global';","select adoption_race.adopt();","review_source_unavailable")
sql("update public.kill_switch_state set engaged=false where scope_key='global';")
require(sql("select count(*) from public.plan_source_review_adoptions;").strip()=="1","duplicate adopted plan")
require(sql("select count(*) from public.plan_source_review_tasks;").strip()=="1","duplicate adopted task")
require(sql("select count(*) from public.remediation_actions where plan_id in(select plan_id from public.plan_source_review_adoptions);").strip()=="0","review acquired action")
require(sql("select count(*) from public.audit_ledger where action_type='plan.review_adopted';").strip()=="1","duplicate human receipt")
print("Seven observed adoption races: one review plan/task/human receipt, zero actions")
