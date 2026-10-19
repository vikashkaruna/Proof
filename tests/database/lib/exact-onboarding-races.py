#!/usr/bin/env python3
"""Real onboarding quota/designation/profile lock ordering in owned SQL only.

Synthetic administrative identities, not GoTrue/MFA or customer consent proof.
Does not create containers; caller supplies the exact owned canonical fixture.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import secrets
import shutil
import subprocess  # nosec B404 -- fixed owned fixture executables/list argv
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def fixture_program(root: Path = ROOT) -> str:
    text = (root / "tests/database/exact-onboarding-operations.test.sql").read_text()
    marker = "do $$declare r jsonb;readback jsonb;"
    if text.count(marker) != 1 or text.count("\nbegin;\n") != 1:
        raise ValueError("Reviewed exact onboarding fixture boundary changed")
    text = text[:text.index(marker)].replace("\nbegin;\n", "\nbegin;\ncreate schema onboarding178_race;\ngrant usage on schema onboarding178_race to human_action_writer;\n", 1)
    return text.replace("pg_temp.", "onboarding178_race.") + "\ncommit;\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--container", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--database", choices=["axiom_policy_test"], required=True)
    args = parser.parse_args()
    if Path.cwd().resolve() != ROOT:
        raise ValueError("Owned source root required")
    docker = shutil.which("docker")
    if (
        not docker
        or not re.fullmatch(r"[a-f0-9]{64}", args.container)
        or not re.fullmatch(r"sha256:[a-f0-9]{64}", args.image)
    ):
        raise ValueError("Exact owned CID and immutable image required")
    spec = importlib.util.spec_from_file_location(
        "onboarding178_owned_fixture",
        ROOT / "tests/database/lib/preprovision-local-custody-verifier.py",
    )
    if spec is None or spec.loader is None:
        raise ValueError("Owned fixture guard unavailable")
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)

    def owned():
        return guard.inspect(docker, args.container, ROOT, args.image)

    def command(argv: list[str], data: str | None = None, *, timeout: int = 30) -> str:
        owned()
        result = subprocess.run(
            [docker, "exec", "-i", args.container, *argv],
            input=data,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )  # nosec B603 -- owned fixed executables/argv
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)
        return result.stdout.strip()

    def sql(database: str, text: str) -> str:
        return command(
            [
                "psql",
                "-X",
                "-U",
                "supabase_admin",
                "-d",
                database,
                "-Atq",
                "-v",
                "ON_ERROR_STOP=1",
            ],
            text,
        )

    def statement(kind: str, label: str) -> str:
        mutations = {
            "create": "select onboarding178_race.create178(1,501);",
            "second_create": "select onboarding178_race.create178(1,502);",
            "founder_create": "select onboarding178_race.create178(2,501);",
            "read": "select public.read_onboarding_operation(onboarding178_race.u178(1),onboarding178_race.u178(101),onboarding178_race.u178(501),onboarding178_race.hash178());",
            "fence": "select public.fence_onboarding_operation(onboarding178_race.u178(1),onboarding178_race.u178(101),onboarding178_race.u178(501),onboarding178_race.hash178());",
            "revoke": "select public.revoke_platform_founder(onboarding178_race.u178(2),'synthetic','Synthetic178 concurrent revoke');",
        }
        return f"begin;set local lock_timeout='10s';set local statement_timeout='15s';set local application_name='{label}';" + mutations[kind]

    results = []
    cases = [("create", "read"), ("read", "create"), ("create", "fence"), ("fence", "create"), ("revoke", "founder_create"), ("founder_create", "revoke"), ("create", "second_create")]
    for index, (first, second) in enumerate(cases):
        database = "axiom_proof_local_onboard178_" + secrets.token_hex(6)
        created = False
        processes: list[subprocess.Popen[str]] = []
        try:
            command(["createdb", "-U", "postgres", "-T", args.database, database])
            created = True
            sql(database, fixture_program())
            if second == "second_create":
                sql(database, "update public.onboarding_entitlements set max_owned_tenants=1 where user_id=onboarding178_race.u178(1);")
            labels = [f"onboard178-first-{index}", f"onboard178-second-{index}"]
            argv = [
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
                "-Atq",
                "-v",
                "ON_ERROR_STOP=1",
            ]
            owned()
            a = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )  # nosec B603 -- owned fixed fixture
            processes.append(a)
            assert a.stdin is not None
            a.stdin.write(
                statement(first, labels[0]) + "select 'ONBOARD178_FIRST_LOCKED';\n"
            )
            a.stdin.flush()
            deadline = time.monotonic() + 15
            while True:
                locked = sql(
                    database,
                    f"select exists(select 1 from pg_stat_activity where datname=current_database()and application_name='{labels[0]}'and state='idle in transaction'and query like '%ONBOARD178_FIRST_LOCKED%');",
                )
                if locked == "t":
                    break
                if time.monotonic() >= deadline or a.poll() is not None:
                    raise RuntimeError(
                        "First onboarding transaction did not establish actual retained locks"
                    )
                time.sleep(0.02)
            b = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )  # nosec B603 -- owned fixed fixture
            processes.append(b)
            assert b.stdin is not None
            b.stdin.write(statement(second, labels[1]) + "commit;\n")
            b.stdin.close()
            b.stdin = None
            deadline = time.monotonic() + 8
            while True:
                blocked = sql(
                    database,
                    f"select exists(select 1 from pg_stat_activity a join pg_stat_activity b on a.pid=any(pg_blocking_pids(b.pid))where a.datname=current_database()and a.application_name='{labels[0]}'and b.application_name='{labels[1]}');",
                )
                if blocked == "t":
                    break
                if time.monotonic() >= deadline or b.poll() is not None:
                    raise RuntimeError(
                        "Expected actual onboarding lock dependency absent"
                    )
                time.sleep(0.02)
            a.stdin.write("commit;\n")
            a.stdin.close()
            a.stdin = None
            out_a, err_a = a.communicate(timeout=20)
            out_b, err_b = b.communicate(timeout=20)
            if a.returncode or b.returncode:
                raise RuntimeError(out_a + err_a + out_b + err_b)
            creator = 2 if "founder_create" in (first, second) else 1
            observed = json.loads(sql(database, f"select jsonb_build_object('tenants',(select count(*)from public.tenant_onboarding_intakes where submitted_by=onboarding178_race.u178({creator})),'recorded',(select count(*)from controller_security.onboarding178_operations where actor_id=onboarding178_race.u178({creator})and state='recorded'),'fenced',(select count(*)from controller_security.onboarding178_operations where actor_id=onboarding178_race.u178({creator})and state='fenced'),'ledger',(select count(*)from public.audit_ledger where action_type='tenant.created'and actor_id=onboarding178_race.u178({creator})::text));"))
            count = 0 if first == "fence" else 1
            if observed != {"tenants":count,"recorded":count,"fenced":int(first=="fence"),"ledger":count}:
                raise RuntimeError("Exact onboarding race lost atomic receipt or fence semantics")
            if second == "second_create" and "tenant_quota_exceeded" not in out_b:
                raise RuntimeError("Last quota slot race was not refused")
            if creator == 2:
                authority = sql(database,"select creation_authority from public.tenant_onboarding_intakes where submitted_by=onboarding178_race.u178(2);")
                if authority != ("owner" if first=="revoke" else "platform_founder"):
                    raise RuntimeError("Founder authority race drifted from176 semantics")
            results.append({"first":first,"second":second,"actualBlockingPidObserved":True,"outcome":observed})
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=10)
            if created:
                command(["dropdb", "-U", "postgres", "--force", database])
    print(json.dumps({"syntheticSqlOnly":True,"races":results,"ownedChildDatabasesRemoved":True}))


if __name__ == "__main__":
    main()
