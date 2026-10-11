#!/usr/bin/env python3
"""Deterministic Reviewed workflow races, exclusively on an explicitly owned fixture.

Run after all migrations with --fixture-proof pointing at a private JSON record
of containerId/name/ownerWorktree/project/loopbackPort/database. No cleanup of
retained operator containers, no service-role enqueue and no timeout-as-proof.
"""

import os
import shutil
import tempfile
import atexit
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
real_docker = shutil.which("docker")
if real_docker is None:
    raise RuntimeError("Docker required")
guard_dir = tempfile.TemporaryDirectory(prefix="axiom-reviewed-drafts-guard-")
atexit.register(guard_dir.cleanup)
shim = Path(guard_dir.name) / "docker"
shim.write_text(
    "#!/usr/bin/env python3\nimport runpy\nrunpy.run_path("
    + repr(str(ROOT / "tests/database/lib/owned-reviewed-drafts-docker.py"))
    + ', run_name="__main__")\n'
)
shim.chmod(0o700)
proof = json.loads(args.fixture_proof.read_text())
args.evidence.mkdir(parents=True, exist_ok=True, mode=0o700)
container, database = proof["containerId"], proof["database"]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


require(re.fullmatch(r"[a-f0-9]{64}", container), "Immutable fixture ID required")
require(
    re.fullmatch(r"axiom_reviewed_drafts_test[a-zA-Z0-9_]*", database)
    or database == "axiom_policy_test",
    "Dedicated Reviewed workflow fixture database required",
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
        fixture_class in {"reviewed-drafts-test", "database-policy-test"},
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
        env={
            **os.environ,
            "AXIOM_REVIEWED_DRAFTS_PROOF": str(args.fixture_proof.resolve()),
            "AXIOM_FIXTURE_REAL_DOCKER": real_docker,
            "PATH": guard_dir.name + os.pathsep + os.environ["PATH"],
        },
    )
    require(expected in paths[1].read_text(), name + ": " + paths[1].read_text())
    for path in paths:
        path.chmod(0o600)
    print(name + ": observed actual blocked contender and expected committed outcome")


sql((ROOT / "tests/database/reviewed-workflow-race-seed.sql").read_text())

claim = "set role agent_ledger_writer;select reviewed_draft_races.claim();"
capture = "set role human_action_writer;select reviewed_draft_races.settle();"
recover = "set role human_action_writer;select public.recover_reviewed_workflow_output(reviewed_draft_races.id(11),reviewed_draft_races.id(1),reviewed_draft_races.id(31),reviewed_draft_races.id(301),reviewed_draft_races.input());"
ack = "set role human_action_writer;select reviewed_draft_races.ack(420);"
member = "update public.tenant_users set role='viewer' where tenant_id=reviewed_draft_races.id(11) and user_id=reviewed_draft_races.id(1);select 'updated';"
restore = "update public.tenant_users set role='owner' where tenant_id=reviewed_draft_races.id(11) and user_id=reviewed_draft_races.id(1);"
race("claim_duplicate", claim, claim, '"claimed": false')
race("capture_duplicate", capture, capture, '"replayed": true')
race("capture_before_read", capture, recover, '"output_text"')
race("ack_duplicate", ack, ack, '"replayed": true')
race(
    "ack_changed_body",
    ack,
    "set role human_action_writer;select reviewed_draft_races.ack(420,0);",
    "acknowledgement_conflict",
)
race(
    "member_before_ack",
    member,
    "set role human_action_writer;select reviewed_draft_races.ack(421);",
    "output_proof_refused",
)
sql(restore)
race(
    "ack_before_member",
    "set role human_action_writer;select reviewed_draft_races.ack(422);",
    member,
    "updated",
)
require(
    "output_proof_refused"
    in sql("set role human_action_writer;select reviewed_draft_races.ack(422);"),
    "current revocation must refuse exact existing acknowledgement",
)
sql(restore)
kill = "update public.kill_switch_state set engaged=true where scope_key='global';select 'updated';"
race("kill_before_capture", kill, capture, "output_context_refused")
sql("update public.kill_switch_state set engaged=false where scope_key='global';")
race("capture_before_kill", capture, kill, "updated")
require(
    "output_context_refused" in sql(capture),
    "current kill must refuse repeated capture",
)
sql("update public.kill_switch_state set engaged=false where scope_key='global';")
require(
    sql(
        "select count(*) from public.verify_ledger(reviewed_draft_races.id(11),1);"
    ).strip()
    == "0",
    "all actual receipts preserve intact ledger chain",
)
require(
    sql(
        "select count(*) from public.operator_workflow_records where tenant_id=reviewed_draft_races.id(11);"
    ).strip()
    == "3",
    "no duplicate original RoPA/task or policy",
)
read_ack = "set role human_action_writer;select public.recover_reviewed_workflow_acknowledgement(reviewed_draft_races.id(11),reviewed_draft_races.id(1),reviewed_draft_races.id(31),reviewed_draft_races.id(301),reviewed_draft_races.input(),reviewed_draft_races.id(420),reviewed_draft_races.body());"
race("read_ack_before_revocation", read_ack, member, "updated")
require(
    "output_proof_refused" in sql(read_ack),
    "read-only acknowledgement must refuse current role revocation",
)
sql(restore)
race("revocation_before_read_ack", member, read_ack, "output_proof_refused")
sql(restore)
print(
    "Eleven real blocked races, immutable output and no duplicate original facts verified"
)
