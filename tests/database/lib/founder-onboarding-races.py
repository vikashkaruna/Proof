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
    text = (root / "tests/database/founder-onboarding-authority.test.sql").read_text()
    marker = "-- An ordinary customer remains owner"
    if text.count(marker) != 1 or text.count("\nbegin;\n") != 1:
        raise ValueError("Reviewed onboarding fixture boundary changed")
    text = text[: text.index(marker)]
    text = text.replace(
        "\nbegin;\n",
        "\nbegin;\ncreate schema onboarding176_race;\ngrant usage on schema onboarding176_race to human_action_writer;\n",
        1,
    )
    text = text.replace("pg_temp.", "onboarding176_race.")
    return text + "\ncommit;\n"


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
        "onboarding176_owned_fixture",
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
            "onboard": "set local role human_action_writer;select public.onboard_organization(onboarding176_race.u(1),gen_random_uuid()::text,'Synthetic race176','growth',false,false,false,null,null,'[]','onboarding-176',gen_random_uuid());reset role;",
            "revoke": "select public.revoke_platform_founder(onboarding176_race.u(1),'test','synthetic race revoke176');",
            "flag": "update public.users set is_axiom_internal=false where id=onboarding176_race.u(1);",
        }
        return (
            f"begin;set local lock_timeout='10s';set local statement_timeout='15s';set local application_name='{label}';"
            + mutations[kind]
        )

    results = []
    cases = [
        ("onboard", "onboard"),
        ("revoke", "onboard"),
        ("onboard", "revoke"),
        ("flag", "onboard"),
        ("onboard", "flag"),
    ]
    for index, (first, second) in enumerate(cases):
        database = "axiom_proof_local_onboard176_" + secrets.token_hex(6)
        created = False
        processes: list[subprocess.Popen[str]] = []
        try:
            command(["createdb", "-U", "postgres", "-T", args.database, database])
            created = True
            sql(database, fixture_program())
            labels = [f"onboard176-first-{index}", f"onboard176-second-{index}"]
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
                statement(first, labels[0]) + "select 'ONBOARD176_FIRST_LOCKED';\n"
            )
            a.stdin.flush()
            deadline = time.monotonic() + 15
            while True:
                locked = sql(
                    database,
                    f"select exists(select 1 from pg_stat_activity where datname=current_database()and application_name='{labels[0]}'and state='idle in transaction'and query like '%ONBOARD176_FIRST_LOCKED%');",
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
            observed = json.loads(
                sql(
                    database,
                    "select jsonb_build_object('tenants',(select count(*)from public.tenant_onboarding_intakes where submitted_by=onboarding176_race.u(1)),'authority',(select creation_authority from public.tenant_onboarding_intakes where submitted_by=onboarding176_race.u(1)),'actorMembership',(select coalesce(array_agg(role::text),array[]::text[])from public.tenant_users where user_id=onboarding176_race.u(1)),'receipts',(select count(*)from public.audit_ledger where action_type='tenant.created'and actor_id=onboarding176_race.u(1)::text));",
                )
            )
            expected_authority = (
                "owner" if first in ("revoke", "flag") else "platform_founder"
            )
            expected_roles = (
                ["founder"]
                if first == second == "onboard"
                else ["owner"]
                if first in ("revoke", "flag")
                else []
            )
            if observed != {
                "tenants": 1,
                "authority": expected_authority,
                "actorMembership": expected_roles,
                "receipts": 1,
            }:
                raise RuntimeError(
                    "Onboarding lock-order outcome mismatched retained semantics"
                )
            if first == second == "onboard" and "tenant_quota_exceeded" not in out_b:
                raise RuntimeError("Concurrent last quota slot was not refused")
            results.append(
                {
                    "first": first,
                    "second": second,
                    "actualBlockingPidObserved": True,
                    "outcome": observed,
                }
            )
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=10)
            if created:
                command(["dropdb", "-U", "postgres", "--force", database])
    print(
        json.dumps(
            {
                "scope": "owned synthetic SQL lock ordering only",
                "cases": results,
                "ownedChildDatabasesRemoved": True,
            }
        )
    )


if __name__ == "__main__":
    main()
