"""Owned disposable175 poll/claim races and real nested lock-wait proof.

Only explicit synthetic SQL fixtures are committed inside cloned disposable DBs.
Never accepts a DSN, retained container, credential, provider or target write.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TENANT = "99143000-0000-4000-8000-000000000011"
OWNER = "99143000-0000-4000-8000-000000000001"


class Refused(RuntimeError):
    """Sanitized fixture failure; diagnostic SQL stays protected."""


def fixture_program(root: Path = ROOT) -> str:
    paths = [
        (
            "tests/database/postgresql-sandbox-discovery.test.sql",
            "select pg_temp.ok(pg_temp.resolve()->>'targetBinding'",
        ),
        (
            "tests/database/scheduled-postgresql-reads.test.sql",
            "-- Real wall clock, short-lived second scope:",
        ),
        (
            "tests/database/scheduled-coverage-reassessment.test.sql",
            "-- Every current authority pin",
        ),
    ]
    parts = []
    for filename, marker in paths:
        text = (root / filename).read_text()
        if text.count(marker) != 1:
            raise Refused("Reviewed175 fixture boundary changed")
        parts.append(text[: text.index(marker)])
    capture = (root / "tests/database/public-control-review-set.test.sql").read_bytes()
    if (
        hashlib.sha256(capture).hexdigest()
        != "a221a1fb1c39e3ace5ea36b5347d02de025d1535b895b0288548b76970b3194a"
    ):
        raise Refused("Reviewed catalogue capture changed")
    text = capture.decode("utf8")
    start = text.index("insert into public.control_libraries")
    end = text.index("\n", text.index("insert into public.controls", start))
    seed = text[start:end]
    return (
        parts[0]
        + "\nreset role;\n"
        + (root / "tests/database/lib/owned-deployment-fixture.sql").read_text()
        + seed
        + "\n"
        + parts[1]
        + parts[2]
        + "\nset constraints all immediate;\ncommit;\n"
    )


def validate_fixture_inputs(container: str, image: str) -> None:
    if not re.fullmatch("[a-f0-9]{64}", container) or not re.fullmatch(
        "sha256:[a-f0-9]{64}", image
    ):
        raise Refused("Immutable owned fixture ID and image required")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--container", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument(
        "--database", choices=["axiom_policy_test", "axiom_proof_local"], required=True
    )
    args = parser.parse_args()
    docker = shutil.which("docker")
    validate_fixture_inputs(args.container, args.image)
    if not docker or Path.cwd().resolve() != ROOT:
        raise Refused("Immutable owned fixture context required")
    spec = importlib.util.spec_from_file_location(
        "coverage175_guard",
        ROOT / "tests/database/lib/preprovision-local-custody-verifier.py",
    )
    if spec is None or spec.loader is None:
        raise Refused("Owned fixture guard unavailable")
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    guard.inspect(docker, args.container, ROOT, args.image)
    os.umask(0o077)
    evidence = Path(tempfile.mkdtemp(prefix="axiom-coverage175-races-"))
    database = "axiom_proof_local175_" + uuid.uuid4().hex[:12]
    clients: list[subprocess.Popen[str]] = []
    created = False
    print(str(evidence), flush=True)

    def command(argv: list[str], name: str, sql: str | None = None) -> str:
        result = subprocess.run(
            [docker, *argv],
            input=sql,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )  # nosec B603 -- immutable guarded Docker fixture, fixed list argv
        (evidence / (name + ".log")).write_text(result.stdout + result.stderr)
        if result.returncode:
            raise Refused(name + " failed; protected fixture proof retained")
        return result.stdout.strip()

    def query(sql: str, name: str) -> str:
        return command(
            [
                "exec",
                "-i",
                args.container,
                "psql",
                "-X",
                "-U",
                "supabase_admin",
                "-d",
                database,
                "-v",
                "ON_ERROR_STOP=1",
                "-Atq",
            ],
            name,
            sql,
        )

    def spawn(sql: str) -> subprocess.Popen[str]:
        child = subprocess.Popen(
            [
                docker,
                "exec",
                "-i",
                args.container,
                "psql",
                "-X",
                "-U",
                "supabase_admin",
                "-d",
                database,
                "-v",
                "ON_ERROR_STOP=1",
                "-Atq",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )  # nosec B603 -- guarded owned fixture only
        clients.append(child)
        assert child.stdin is not None
        child.stdin.write("set statement_timeout='10s';" + sql + "\n")
        child.stdin.flush()
        return child

    def ready(child: subprocess.Popen[str]) -> str:
        # Every prior statement is also bounded by the native statement timeout.
        assert child.stdout is not None
        lines = []
        for _ in range(4):
            line = child.stdout.readline().strip()
            if line == "READY175":
                return "\n".join(lines)
            lines.append(line)
        raise Refused("Native175 barrier unavailable")

    def finish(child: subprocess.Popen[str], name: str, prior: str = "") -> str:
        stdout, stderr = child.communicate(timeout=15)
        (evidence / (name + ".log")).write_text(prior + "\n" + stdout + stderr)
        if child.returncode:
            raise Refused("Actual175 raced statement refused")
        return (prior + "\n" + stdout).strip()

    try:
        command(
            [
                "exec",
                args.container,
                "createdb",
                "-U",
                "supabase_admin",
                "--template",
                args.database,
                database,
            ],
            "create-child",
        )
        created = True
        query(fixture_program(), "committed-synthetic-foundation")
        # These fabricated stale scopes intentionally lack immutable decision
        # pins; no API/agent can create them or ever obtain authority from them.
        query(
            """do $$declare original controller_security.coverage175_scopes;sc uuid;ch uuid;schedule uuid;n integer;begin
select *into strict original from controller_security.coverage175_scopes where tenant_id='"""
            + TENANT
            + """';
for n in 1..33 loop sc:=gen_random_uuid();ch:=gen_random_uuid();schedule:=gen_random_uuid();
insert into public.monitoring_schedules(id,tenant_id,estate_id,name,kind,cadence,created_by,next_run_at,status)values(schedule,original.tenant_id,(original.source->>'estateId')::uuid,'Explicit stale SQL-only scope','rediscovery',original.source->>'cadence',original.actor_id,clock_timestamp(),'paused');
insert into public.mfa_challenges(id,user_id,tenant_id,factor_id,purpose,created_at,expires_at)values(ch,original.actor_id,original.tenant_id,'99143000-0000-4000-8000-000000000041','scheduled_coverage',clock_timestamp(),clock_timestamp()+interval '5 minutes');
insert into controller_security.coverage175_scopes(id,tenant_id,schedule_id,actor_id,session_id,request_text,request_sha256,source,challenge_id,receipt_id,previous_scope_id,max_fires,created_at,expires_at)values(sc,original.tenant_id,schedule,original.actor_id,original.session_id,original.request_text,original.request_sha256,original.source,ch,original.receipt_id,null,1,original.created_at-make_interval(secs=>n),original.expires_at);
insert into controller_security.coverage175_heads values(schedule,original.tenant_id,sc);end loop;end$$;""",
            "stale-admin-standins",
        )
        holder = spawn(
            "begin;select id from public.users where id='"
            + OWNER
            + "'for update;\n\\echo READY175"
        )
        ready(holder)
        start = time.monotonic()
        first = query(
            "set role agent_ledger_writer;select public.reserve_scheduled_coverage_fire('"
            + TENANT
            + "');",
            "actual32-blocked-locks",
        )
        elapsed = time.monotonic() - start
        attempts = int(
            query(
                "select count(*)from controller_security.coverage175_scopes scope join controller_security.coverage175_cursor cursor on cursor.tenant_id=scope.tenant_id where scope.tenant_id='"
                + TENANT
                + "'and(scope.created_at,scope.id)<=(cursor.last_created_at,cursor.last_scope_id);",
                "visited-blocked-candidates",
            )
        )
        if (
            json.loads(first) != {"fires": []}
            or elapsed >= 3
            or not 8 <= attempts <= 32
        ):
            raise Refused("Actual bounded repeated-candidate lock proof refused")
        assert holder.stdin is not None
        holder.stdin.write("rollback;\n\\q\n")
        holder.stdin.flush()
        finish(holder, "release-lock")
        # Concurrent polls must retain one identical original assignment after
        # the durable cursor progresses beyond all33 stale candidates.
        poll = (
            "set application_name='axiom175_poll_a';begin;set local role agent_ledger_writer;select public.reserve_scheduled_coverage_fire('"
            + TENANT
            + "');\n\\echo READY175"
        )
        holder = spawn(poll)
        original = json.loads(ready(holder))
        if len(original.get("fires", [])) != 1:
            raise Refused("Later eligible scope did not progress")
        contender = spawn(
            "set application_name='axiom175_poll_b';begin;set local role agent_ledger_writer;select public.reserve_scheduled_coverage_fire('"
            + TENANT
            + "');commit;\n\\q"
        )
        blocked = False
        for _ in range(100):
            if (
                query(
                    "select exists(select 1 from pg_stat_activity where application_name='axiom175_poll_b'and wait_event_type='Lock');",
                    "poll-blocked",
                )
                == "t"
            ):
                blocked = True
                break
            time.sleep(0.02)
        if not blocked:
            raise Refused("Actual concurrent poll barrier missing")
        assert holder.stdin is not None
        holder.stdin.write("commit;\n\\q\n")
        holder.stdin.flush()
        finish(holder, "poll-holder")
        if json.loads(finish(contender, "poll-contender")) != original:
            raise Refused("Concurrent polls changed original fire")
        fire = original["fires"][0]["fireId"]
        holder = spawn(
            "begin;set local role agent_ledger_writer;select public.claim_scheduled_coverage_fire('"
            + TENANT
            + "','"
            + fire
            + "');\n\\echo READY175"
        )
        claim = json.loads(ready(holder))
        contender = spawn(
            "set application_name='axiom175_claim_b';begin;set local role agent_ledger_writer;select public.claim_scheduled_coverage_fire('"
            + TENANT
            + "','"
            + fire
            + "');commit;\n\\q"
        )
        blocked = False
        for _ in range(100):
            if (
                query(
                    "select exists(select 1 from pg_stat_activity where application_name='axiom175_claim_b'and wait_event_type='Lock');",
                    "claim-blocked",
                )
                == "t"
            ):
                blocked = True
                break
            time.sleep(0.02)
        if not blocked:
            raise Refused("Actual concurrent claim barrier missing")
        assert holder.stdin is not None
        holder.stdin.write("commit;\n\\q\n")
        holder.stdin.flush()
        finish(holder, "claim-holder")
        second = json.loads(finish(contender, "claim-contender"))
        if (
            claim.get("state") != "runnable"
            or second.get("state") != "handed_off"
            or second.get("fireId") != fire
        ):
            raise Refused("One-shot claim proof refused")
        final = json.loads(
            query(
                "select jsonb_build_object('fires',(select count(*)from controller_security.coverage175_fires),'jobs',(select count(*)from public.assessment_dispatch_jobs),'ownerReceipts',(select count(*)from public.audit_ledger where actor_type='human'and detail->>'phase'='scheduled_coverage_authorize'));",
                "final-state",
            )
        )
        if final != {"fires": 1, "jobs": 0, "ownerReceipts": 1}:
            raise Refused("Concurrent claims created extra effects")
        (evidence / "qualification.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "scope": "owned_SQL_only_no_runtime_acceptance",
                    "staleCandidates": 33,
                    "boundedPageLimit": 32,
                    "blockedCandidateAttempts": attempts,
                    "actualLockSeconds": round(elapsed, 4),
                    "concurrentPollsSameOriginal": True,
                    "actualConcurrentClaimBlocking": True,
                    "claims": ["runnable", "handed_off"],
                    "final": final,
                },
                indent=2,
            )
        )
        print("175 native fair cursor, actual lock bound and one-shot races passed.")
        print(str(evidence))
    finally:
        for child in clients:
            if child.poll() is None:
                if child.stdin is not None:
                    child.stdin.close()
                    child.stdin = None
                try:
                    child.communicate(timeout=12)
                except subprocess.TimeoutExpired:
                    child.terminate()
                    child.communicate(timeout=3)
        if created:
            guard.inspect(docker, args.container, ROOT, args.image)
            command(
                [
                    "exec",
                    args.container,
                    "dropdb",
                    "-U",
                    "supabase_admin",
                    "--force",
                    database,
                ],
                "drop-child",
            )


if __name__ == "__main__":
    main()
