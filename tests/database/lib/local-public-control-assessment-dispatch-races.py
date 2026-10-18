"""Observed147 races, source-only until root explicitly executes the harness.

Reuses the reviewed full-CID/image/owner guard and maintained bounded PostgreSQL
barrier. Each case clones one committed synthetic template, never deletes or
rewrites ledger/history. No global roles, containers or networks are created.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
TENANT = "99134700-0000-4000-8000-000000000031"


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / name)
    if spec is None or spec.loader is None:
        raise ValueError("fixture_dependency_missing")
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


BASE = load("local-custody-issuance-races.py")
FIXTURE = load("local-public-control-assessment-dispatch-fixture.py")
BARRIER = BASE.BARRIER


def scenarios():
    lock = f"select pg_advisory_xact_lock(hashtextextended('{TENANT}',47));"
    enqueue = "select local147_fixture.enqueue(302)"
    claim = "select local147_fixture.claim(301)"
    policy = "select local147_fixture.revoke_policy()"
    retire = f"update public.tenant_users set role='viewer' where tenant_id='{TENANT}' and user_id=local147_fixture.id(3);"
    withdraw = "select local147_fixture.asset_write(jsonb_build_object('version',1,'kind','withdraw','operationKey',local147_fixture.id(318),'confirmed',true,'subjectType','association','subjectId',(value->>'snapshotText')::jsonb->>'id','expectedSubjectSha256',value->>'snapshotSha256','reason','Synthetic mistaken association')) from local147_fixture.asset_operations where kind='association';"
    cases = []

    def add(
        name,
        holder,
        contender,
        *,
        operation="none",
        mode="blocked",
        error=None,
        phase="tenant",
        refusal=None,
    ):
        cases.append(
            {
                "name": name,
                "holder": holder,
                "contender": contender,
                "operation": operation,
                "mode": mode,
                "error": error,
                "contract": (
                    ("custody145:tenant:" + TENANT)
                    if phase == "tenant"
                    else ("custody147:engagement:" + TENANT)
                    if phase == "engagement"
                    else "custody147:row:"
                    + phase
                    + ":"
                    + TENANT
                    + ":99134700-0000-4000-8000-000000000003"
                ),
                "refusal": refusal,
            }
        )

    add("duplicate-enqueue", lock + enqueue, enqueue, operation="enqueue")
    add("lost-enqueue-response", lock + enqueue, enqueue, operation="enqueue")
    add(
        "policy-revoke-before-new",
        lock + policy,
        enqueue,
        operation="policy",
        refusal="local_policy_stale",
    )
    add("new-before-policy-revoke", lock + enqueue, policy, operation="enqueue_policy")
    add(
        "policy-revoke-before-accepted-claim",
        lock + policy,
        claim,
        operation="policy_claim",
    )
    add(
        "credential-revoke-before-claim",
        lock
        + "update controller_security.credentials set revoked_at=clock_timestamp() where id=local147_fixture.id(181);",
        claim,
        error="42501",
    )
    add("actor-offboard-before-new", lock + retire, enqueue, refusal="forbidden")
    add(
        "new-before-actor-offboard",
        lock + enqueue,
        retire,
        operation="enqueue",
        phase="membership",
    )
    add(
        "source-withdraw-before-new",
        lock + withdraw,
        enqueue,
        operation="withdraw",
        error="22023",
    )
    add(
        "new-before-source-withdraw",
        lock + enqueue,
        withdraw,
        operation="enqueue_withdraw",
        phase="user",
    )
    add(
        "stop-before-new",
        lock
        + "update public.kill_switch_state set engaged=true where scope_key='global';",
        enqueue,
        refusal="error",
    )
    add(
        "stop-before-accepted-claim",
        lock
        + "update public.kill_switch_state set engaged=true where scope_key='global';",
        claim,
        refusal="error",
    )
    add(
        "duplicate-claim",
        lock + claim,
        claim,
        operation="claim",
        refusal="dispatch_reconciliation_required",
    )
    engagement = f"select 1 from public.engagements where tenant_id='{TENANT}' and id=local147_fixture.id(41) for update;"
    # Actual pg_locks transactionid + blocking PID proof at the engagement row,
    # AFTER the initial controller guard. Original deadline is observed by the
    # existing expires barrier, not renewed or guessed by a sleep.
    task_deadline = "select 'RACE_DEADLINE='||expires_at::text from public.workload_task_delegations where run_id=(select run_id from public.assessment_dispatch_jobs where id=local147_fixture.id(301));"
    add(
        "task-original-expiry-after-wait",
        engagement,
        task_deadline + claim,
        mode="expires",
        error="42501",
        phase="engagement",
    )
    controller_deadline = "select 'RACE_DEADLINE='||expires_at::text from controller_security.credentials where id=local147_fixture.id(182);"
    expired_claim = "select local147_fixture.claim(301,jsonb_build_object('credentialId',local147_fixture.id(182),'exp',floor(extract(epoch from expires_at))::bigint)) from controller_security.credentials where id=local147_fixture.id(182)"
    add(
        "controller-original-expiry-after-wait",
        engagement,
        controller_deadline + expired_claim,
        mode="expires",
        error="42501",
        phase="engagement",
    )
    return cases


SNAPSHOT = """select jsonb_build_object(
'jobs',(select count(*) from public.assessment_dispatch_jobs where tenant_id=local147_fixture.id(31)),
'tasks',(select count(*) from public.workload_task_delegations where tenant_id=local147_fixture.id(31)),
'runs',(select count(*) from public.agent_runs where tenant_id=local147_fixture.id(31)),
'sources',(select count(*) from public.public_control_assessment_sources where tenant_id=local147_fixture.id(31)),
'grants',(select count(*) from public.assessment_local_custody_authorizations where tenant_id=local147_fixture.id(31)),
'ledger',(select count(*) from public.audit_ledger),
'claimed',(select count(*) from public.assessment_dispatch_jobs where tenant_id=local147_fixture.id(31) and claimed_at is not null),
'history',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) order by name),'[]'::jsonb)::text,'UTF8')),'hex') from axiom_migrations.applied t),
'violations',(select count(*) from public.tenants t cross join lateral public.verify_ledger(t.id)),
'orphans',(select count(*) from public.assessment_dispatch_jobs j left join public.assessment_local_custody_authorizations g on g.job_id=j.id left join public.public_control_assessment_sources s on s.job_id=j.id where j.tenant_id=local147_fixture.id(31) and (g.job_id is null or s.job_id is null)))"""


def validate(before, after, case):
    if (
        before["history"] != after["history"]
        or after["violations"] != 0
        or after["orphans"] != 0
    ):
        raise ValueError("history_or_reciprocal_binding_changed")
    additions = {
        "none": (0, 0, 0),
        "enqueue": (1, 2, 0),
        "policy": (0, 1, 0),
        "enqueue_policy": (1, 3, 0),
        "policy_claim": (0, 1, 1),
        "withdraw": (0, 1, 0),
        "enqueue_withdraw": (1, 3, 0),
        "claim": (0, 0, 1),
    }
    jobs, ledger, claimed = additions[case["operation"]]
    for field in ("jobs", "tasks", "runs", "sources", "grants"):
        if after[field] != before[field] + jobs:
            raise ValueError("duplicate_or_partial_dispatch")
    if (
        after["ledger"] != before["ledger"] + ledger
        or after["claimed"] != before["claimed"] + claimed
    ):
        raise ValueError("unexpected_receipt_or_delivery_count")


class Runner(BASE.Runner):
    def create(self, suffix, template):
        name = "axiom_proof_local_147_" + self.nonce + "_" + suffix
        if not re.fullmatch(r"axiom_proof_local_147_[a-f0-9]{12}_[a-z0-9]+", name):
            raise ValueError("owned147_database_required")
        if (
            self.sql(
                "postgres",
                "select count(*) from pg_database where datname='" + name + "'",
            )
            != "0"
        ):
            raise ValueError("preexisting_database_refused")
        self.databases.append(name)
        self.run(
            ["exec", self.cid, "createdb", "-U", "supabase_admin", "-T", template, name]
        )
        return name

    def cleanup(self):
        failures = []
        for database in reversed(self.databases.copy()):
            try:
                self.run(
                    [
                        "exec",
                        self.cid,
                        "dropdb",
                        "-U",
                        "supabase_admin",
                        "--if-exists",
                        database,
                    ]
                )
                self.databases.remove(database)
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
                failures.append(database)
        if failures:
            raise RuntimeError("owned147_database_cleanup_incomplete")

    def statement_clock(self, database):
        """A token predates SQL even when query execution crosses an epoch second.

        This bounded sleep tests timestamp provenance only. It does not stand in
        for a lock witness: every concurrency scenario still requires pg_locks
        and pg_blocking_pids proof through the unchanged maintained barrier.
        """
        before = json.loads(self.sql(database, SNAPSHOT))
        immutable = "select jsonb_build_object('ledger',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb)::text,'UTF8')),'hex') from public.audit_ledger t),'grants',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(g) order by job_id),'[]'::jsonb)::text,'UTF8')),'hex') from public.assessment_local_custody_authorizations g))"
        original = self.sql(database, immutable)
        reply = json.loads(
            self.sql(database, "select local147_fixture.claim(301) from pg_sleep(1.1)")
        )
        if reply.get("job_id") != "99134700-0000-4000-8000-000000000301" or reply.get(
            "error"
        ):
            raise ValueError("statement_clock_claim_unconfirmed")
        after = json.loads(self.sql(database, SNAPSHOT))
        validate(before, after, {"operation": "claim"})
        if self.sql(database, immutable) != original:
            raise ValueError("statement_clock_historical_bytes_changed")
        print(
            json.dumps(
                {
                    "localDispatch147StatementClockProof": {
                        "claimed": True,
                        "historicalLedgerAndGrantsUnchanged": True,
                        "historyUnchanged": before["history"] == after["history"],
                    }
                }
            ),
            flush=True,
        )

    def race(self, database, case, index):
        folder = self.directory / f"{index:02d}-{case['name']}"
        folder.mkdir(mode=0o700)
        if case["name"] == "task-original-expiry-after-wait":
            # A NEW accepted short-lived job, not an UPDATE of an immutable
            # accepted grant or original task expiry.
            self.sql(
                database,
                "update local147_fixture.clock set deadline=clock_timestamp()+interval '8 seconds';select local147_fixture.enqueue(302);",
            )
            case = {
                **case,
                "contender": case["contender"]
                .replace("id(301)", "id(302)")
                .replace("claim(301)", "claim(302)"),
            }
        elif case["name"] == "controller-original-expiry-after-wait":
            self.sql(
                database,
                "insert into controller_security.credentials(id,tenant_id,expires_at) values(local147_fixture.id(182),local147_fixture.id(31),clock_timestamp()+interval '8 seconds');",
            )
        before = json.loads(self.sql(database, SNAPSHOT))
        boundary = self.sql(
            database, "select coalesce(max(id),0) from public.audit_ledger"
        )
        if not boundary.isdecimal():
            raise ValueError("ledger_boundary_refused")
        old_ledger = (
            "select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb)::text,'UTF8')),'hex') from public.audit_ledger t where id<="
            + boundary
        )
        old_hash = self.sql(database, old_ledger)
        original_grant = self.sql(
            database,
            "select encode(sha256(convert_to(to_jsonb(g)::text,'UTF8')),'hex') from public.assessment_local_custody_authorizations g where job_id=local147_fixture.id(301)",
        )
        grant_hash = self.sql(
            database,
            "select encode(sha256(convert_to(jsonb_agg(to_jsonb(g) order by job_id)::text,'UTF8')),'hex') from public.assessment_local_custody_authorizations g",
        )
        self.owned()
        argv = [
            "barrier",
            self.cid,
            "supabase_admin",
            case["holder"],
            "\\set VERBOSITY verbose\nbegin;" + case["contender"] + ";commit",
            str(folder / "holder.log"),
            str(folder / "contender.log"),
            str(folder / "status"),
            case["mode"],
            "error" if case["error"] else "success",
            case["contract"],
            database,
        ]
        prior = sys.argv
        try:
            sys.argv = argv
            if BARRIER.main() != 0:
                raise RuntimeError("observed147_race_failed:" + case["name"])
        finally:
            sys.argv = prior
        output = (folder / "contender.log").read_text()
        if case["error"] and not re.search(
            r"ERROR:\s+" + case["error"] + r"\b", output
        ):
            raise ValueError("expected_sqlstate_missing")
        if case["refusal"]:
            rows = [
                json.loads(line) for line in output.splitlines() if line.startswith("{")
            ]
            if (
                not rows
                or not rows[-1].get("error")
                or (case["refusal"] != "error" and rows[-1]["error"] != case["refusal"])
            ):
                raise ValueError("required_refusal_not_observed")
        after = json.loads(self.sql(database, SNAPSHOT))
        validate(before, after, case)
        if self.sql(database, old_ledger) != old_hash or original_grant != self.sql(
            database,
            "select encode(sha256(convert_to(to_jsonb(g)::text,'UTF8')),'hex') from public.assessment_local_custody_authorizations g where job_id=local147_fixture.id(301)",
        ):
            raise ValueError("historical_bytes_changed")
        # Compare every pre-existing accepted grant when this race creates no new one.
        if after["grants"] == before["grants"] and grant_hash != self.sql(
            database,
            "select encode(sha256(convert_to(jsonb_agg(to_jsonb(g) order by job_id)::text,'UTF8')),'hex') from public.assessment_local_custody_authorizations g",
        ):
            raise ValueError("accepted_grant_changed")
        if case["name"] in {"duplicate-enqueue", "lost-enqueue-response"}:
            first = [
                json.loads(line)
                for line in (folder / "holder.log").read_text().splitlines()
                if line.startswith("{")
            ]
            second = [
                json.loads(line) for line in output.splitlines() if line.startswith("{")
            ]
            if first != second or len(first) != 1:
                raise ValueError("exact_replay_receipt_changed")
            if (
                json.loads(self.sql(database, "select local147_fixture.enqueue(302)"))
                != second[0]
                or json.loads(self.sql(database, SNAPSHOT)) != after
            ):
                raise ValueError("lost_response_reconciliation_changed_authority")
        witness = json.loads((folder / "holder.log.lock-proof.json").read_text())
        print(
            json.dumps(
                {
                    "localDispatch147RaceProof": {
                        "name": case["name"],
                        "observed": True,
                        "before": before,
                        "after": after,
                        "historicalLedgerUnchanged": True,
                        "originalGrantUnchanged": True,
                        "lockWitness": witness,
                    }
                },
                sort_keys=True,
            ),
            flush=True,
        )


def main():
    if len(sys.argv) != 3:
        raise ValueError("owned_fixture_name_and_image_required")
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="axiom-local147-races-") as raw:
        runner = Runner(sys.argv[1], sys.argv[2], Path(raw))
        try:
            template = runner.create("template", "axiom_policy_test")
            runner.sql(template, FIXTURE.setup(committed=True))
            runner.sql(
                template,
                "select local147_fixture.enqueue(301);set constraints all immediate;",
            )
            clock_database = runner.create("clock", template)
            runner.statement_clock(clock_database)
            runner.run(
                ["exec", runner.cid, "dropdb", "-U", "supabase_admin", clock_database]
            )
            runner.databases.remove(clock_database)
            for index, case in enumerate(scenarios()):
                database = runner.create(str(index), template)
                runner.race(database, case, index)
                runner.run(
                    ["exec", runner.cid, "dropdb", "-U", "supabase_admin", database]
                )
                runner.databases.remove(database)
        except BaseException:
            # Only owned synthetic fixture logs; canonical caller captures them
            # before the temporary proof directory is removed during cleanup.
            for log in sorted(
                [*Path(raw).rglob("*.log"), *Path(raw).rglob("*.lock-proof.json")]
            ):
                print(
                    str(log.relative_to(raw)) + ": " + log.read_text(errors="replace"),
                    file=sys.stderr,
                )
            raise
        finally:
            runner.cleanup()
    print(
        "Local147:statement-clock regression and 15 observed races; owned databases removed; no retained state."
    )


if __name__ == "__main__":
    main()
