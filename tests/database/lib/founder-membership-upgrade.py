#!/usr/bin/env python3
"""Genuine dirty 175→176 founder projection upgrade in one owned child DB.

Pre-176 races use independent SQL connections and actual membership triggers.
No retained database, GoTrue/MFA, client consent or report generation claim.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import secrets
import shutil
import subprocess  # nosec B404 -- owned fixture, fixed list argv/no shell
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MIGRATION = "0176_founder_onboarding_authority.sql"


def migration_inputs(root: Path = ROOT) -> tuple[list[Path], Path]:
    files = sorted((root / "infra/supabase/migrations").glob("*.sql"))
    prefix = [p for p in files if p.name[:4].isdigit() and int(p.name[:4]) < 176]
    if [int(p.name[:4]) for p in prefix] != [v for v in range(176) if v != 132]:
        raise ValueError("Actual contiguous historical0–175 migrations required")
    target = root / "infra/supabase/migrations" / MIGRATION
    if (
        not target.is_file()
        or target.read_text().count(
            "select public.sync_platform_founder_memberships(null,null);"
        )
        != 1
    ):
        raise ValueError("Actual176 full projection reconciliation required")
    return prefix, target


def fixture_program() -> str:
    return """begin;
create schema founder176_upgrade;
grant usage on schema founder176_upgrade to human_action_writer,authenticated;
create function founder176_upgrade.u(n integer)returns uuid language sql immutable as $$
 select ('00000000-0000-0000-1769-'||lpad(n::text,12,'0'))::uuid;
$$;
insert into auth.users(id,email)select founder176_upgrade.u(n),'upgrade176-'||n||'@test.invalid'from generate_series(1,8)n;
insert into public.users(id,email,is_axiom_internal)
 select founder176_upgrade.u(n),'upgrade176-'||n||'@test.invalid',n in(1,2,4,6,8)from generate_series(1,8)n;
insert into public.control_libraries(version,published_at,published_by,change_log,control_count,is_current)
 values('upgrade-founder176',now(),'test','SQL publication fixture, not catalogue approval',1,true);
insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version)
 values('UPGRADE176','upgrade-founder176','Test','Test','GOV','low','[]','[]','[]','{}','{}','upgrade-founder176');
insert into public.onboarding_entitlements(user_id,max_owned_tenants,allowed_tiers,granted_by,grant_reason,valid_until)
 values(founder176_upgrade.u(3),4,array['growth']::public.tenant_tier[],founder176_upgrade.u(1),'Synthetic upgrade176 entitlement',now()+interval '1 day');
insert into public.tenants(id,slug,name)values(founder176_upgrade.u(101),'upgrade176-existing','Existing synthetic tenant');
insert into public.tenant_users(tenant_id,user_id,role,accepted_at)values
 (founder176_upgrade.u(101),founder176_upgrade.u(8),'owner','2026-01-01T00:00:00Z'),
 (founder176_upgrade.u(101),founder176_upgrade.u(7),'reviewer','2026-01-02T00:00:00Z');
select public.designate_platform_founder(founder176_upgrade.u(1),'test','valid derived history176');
select public.designate_platform_founder(founder176_upgrade.u(2),'test','revoke race history176');
select public.designate_platform_founder(founder176_upgrade.u(4),'test','flag race history176');
select public.designate_platform_founder(founder176_upgrade.u(8),'test','explicit owner precedence176');
commit;
"""


def snapshot_sql(*, upgraded: bool) -> str:
    intake = "to_jsonb(i)-'creation_authority'" if upgraded else "to_jsonb(i)"
    return (
        """select jsonb_build_object(
 'explicit',(select coalesce(jsonb_agg(to_jsonb(m)order by tenant_id,user_id),'[]')from public.tenant_users m where membership_source='explicit'),
 'validDerived',(select coalesce(jsonb_agg(to_jsonb(m)order by tenant_id,user_id),'[]')from public.tenant_users m where membership_source='platform_founder'and public.is_live_platform_founder(user_id)),
 'allDerived',(select coalesce(jsonb_agg(to_jsonb(m)order by tenant_id,user_id),'[]')from public.tenant_users m where membership_source='platform_founder'),
 'ledger',(select coalesce(jsonb_agg(to_jsonb(l)order by tenant_id,sequence_no),'[]')from public.audit_ledger l),
 'designations',(select coalesce(jsonb_agg(to_jsonb(f)order by user_id),'[]')from public.platform_founders f),
 'users',(select coalesce(jsonb_agg(to_jsonb(u)order by id),'[]')from public.users u),
 'tenants',(select coalesce(jsonb_agg(to_jsonb(t)order by id),'[]')from public.tenants t),
 'engagements',(select coalesce(jsonb_agg(to_jsonb(e)order by id),'[]')from public.engagements e),
 'entitlements',(select coalesce(jsonb_agg(to_jsonb(e)order by user_id),'[]')from public.onboarding_entitlements e),
 'intakes',(select coalesce(jsonb_agg("""
        + intake
        + """ order by tenant_id),'[]')from public.tenant_onboarding_intakes i));"""
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--container", required=True)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    if (
        Path.cwd().resolve() != ROOT
        or not re.fullmatch("[a-f0-9]{64}", args.container)
        or not re.fullmatch("sha256:[a-f0-9]{64}", args.image)
    ):
        raise ValueError("Exact owned fixture source/CID/image required")
    docker = shutil.which("docker")
    if docker is None:
        raise ValueError("Owned Docker fixture unavailable")
    spec = importlib.util.spec_from_file_location(
        "founder176_guard",
        ROOT / "tests/database/lib/preprovision-local-custody-verifier.py",
    )
    if spec is None or spec.loader is None:
        raise ValueError("Owned fixture guard unavailable")
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)

    def owned():
        return guard.inspect(docker, args.container, ROOT, args.image)

    def command(argv: list[str], data: str | None = None, timeout: int = 30) -> str:
        owned()
        result = subprocess.run(
            [docker, "exec", "-i", args.container, *argv],
            input=data,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )  # nosec B603 -- owned fixture fixed argv
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)
        return result.stdout.strip()

    database = "axiom_proof_local_founder176_" + secrets.token_hex(6)
    created = False
    process = None
    prefix, target = migration_inputs()
    input_hashes = {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in [*prefix, target]
    }

    def sql(text: str) -> str:
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

    def migration(directory: Path):
        owned()
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/migrate-database.py"),
                "--container",
                args.container,
                "--user",
                "postgres",
                "--database",
                database,
                "--migrations",
                str(directory),
            ],
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )  # nosec B603 -- fixed migrator and owned child database
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)

    def access(user: int, tenant: str):
        if not re.fullmatch("[a-f0-9-]{36}", tenant):
            raise ValueError("Synthetic tenant identity refused")
        query = f"select set_config('request.jwt.claims',json_build_object('sub',founder176_upgrade.u({user}),'role','authenticated')::text,false);set role authenticated;select jsonb_build_object('tenantVisible',exists(select 1 from public.tenants where id='{tenant}'::uuid),'founderRole',public.has_tenant_role('{tenant}'::uuid,array['founder']::public.user_role[]),'publishedReport',public.report_visible('{tenant}'::uuid,founder176_upgrade.u(3),'published'),'draftReport',public.report_visible('{tenant}'::uuid,founder176_upgrade.u(3),'draft'));"
        return json.loads(sql(query).splitlines()[-1])

    cases = []
    result = None
    try:
        command(["createdb", "-U", "postgres", database])
        created = True
        command(
            [
                "psql",
                "-X",
                "-U",
                "postgres",
                "-d",
                database,
                "-v",
                "ON_ERROR_STOP=1",
                "-q",
            ],
            (ROOT / "tests/database/bootstrap.sql").read_text(),
        )
        with tempfile.TemporaryDirectory(
            prefix="axiom-proof-local-founder-upgrade-"
        ) as temporary:
            staging = Path(temporary)
            staging.chmod(0o700)
            for p in prefix:
                (staging / p.name).write_bytes(p.read_bytes())
                (staging / p.name).chmod(0o600)
            migration(staging)
            sql(fixture_program())
            for kind, user in (("revoke", 2), ("flag", 4), ("designate", 6)):
                label = "founder176-upgrade-" + kind
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
                process = subprocess.Popen(
                    argv,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )  # nosec B603 -- fixed owned fixture
                assert process.stdin is not None
                process.stdin.write(
                    f"begin;set local application_name='{label}';set local role human_action_writer;select public.onboard_organization(founder176_upgrade.u(3),gen_random_uuid()::text,'Synthetic dirty upgrade176','growth',false,false,false,null,null,'[]','upgrade-founder176',gen_random_uuid());reset role;select 'FOUNDER176_UPGRADE_HELD';\n"
                )
                process.stdin.flush()
                deadline = time.monotonic() + 15
                while (
                    sql(
                        f"select exists(select 1 from pg_stat_activity where datname=current_database()and application_name='{label}'and state='idle in transaction'and query like '%FOUNDER176_UPGRADE_HELD%');"
                    )
                    != "t"
                ):
                    if time.monotonic() >= deadline or process.poll() is not None:
                        raise RuntimeError("Actual pre176 held-tenant barrier absent")
                    time.sleep(0.02)
                change = {
                    "revoke": "select public.revoke_platform_founder(founder176_upgrade.u(2),'test','genuine dirty upgrade revoke176');",
                    "flag": "update public.users set is_axiom_internal=false where id=founder176_upgrade.u(4);",
                    "designate": "select public.designate_platform_founder(founder176_upgrade.u(6),'test','genuine dirty upgrade designation176');",
                }[kind]
                sql(change)  # Must COMMIT while the tenant is still uncommitted.
                process.stdin.write("commit;\n")
                process.stdin.close()
                process.stdin = None
                output, error = process.communicate(timeout=15)
                if process.returncode:
                    raise RuntimeError(output + error)
                record = next(
                    json.loads(row)
                    for row in output.splitlines()
                    if row.startswith("{")
                )
                tenant = record["tenant"]["id"]
                before_access = access(user, tenant)
                expected = {
                    "tenantVisible": kind != "designate",
                    "founderRole": kind != "designate",
                    "publishedReport": kind != "designate",
                    "draftReport": kind == "revoke",
                }
                if before_access != expected:
                    raise RuntimeError(
                        "Genuine dirty pre176 RLS/report state not reproduced"
                    )
                cases.append(
                    {
                        "kind": kind,
                        "user": user,
                        "tenant": tenant,
                        "beforeAccess": before_access,
                        "mutationCommittedBeforeTenant": True,
                    }
                )
            before = json.loads(sql(snapshot_sql(upgraded=False)))
            for p in staging.glob("*.sql"):
                p.unlink()
            (staging / target.name).write_bytes(target.read_bytes())
            (staging / target.name).chmod(0o600)
            migration(staging)
            after = json.loads(sql(snapshot_sql(upgraded=True)))
            for key in (
                "explicit",
                "ledger",
                "designations",
                "users",
                "tenants",
                "engagements",
                "entitlements",
                "intakes",
            ):
                if before[key] != after[key]:
                    raise RuntimeError("Upgrade rewrote retained " + key + " history")
            by_key = lambda rows: {(r["tenant_id"], r["user_id"]): r for r in rows}
            old_valid, new_valid = (
                by_key(before["validDerived"]),
                by_key(after["validDerived"]),
            )
            if any(new_valid.get(key) != value for key, value in old_valid.items()):
                raise RuntimeError("Upgrade rewrote valid derived accepted history")
            old_all, new_all = by_key(before["allDerived"]), by_key(after["allDerived"])
            removed = set(old_all) - set(new_all)
            added = set(new_all) - set(old_all)
            expected_removed = {
                (c["tenant"], f"00000000-0000-0000-1769-{c['user']:012d}")
                for c in cases
                if c["kind"] != "designate"
            }
            expected_added = {
                (c["tenant"], f"00000000-0000-0000-1769-{c['user']:012d}")
                for c in cases
                if c["kind"] == "designate"
            }
            if removed != expected_removed or added != expected_added:
                raise RuntimeError(
                    "Upgrade changed more than the stale/missing current projection"
                )
            if (
                sql(
                    "select bool_and(creation_authority='owner')from public.tenant_onboarding_intakes;"
                )
                != "t"
            ):
                raise RuntimeError("Historical customer-owner intake marker changed")
            for case in cases:
                active = case["kind"] == "designate"
                actual = access(case["user"], case["tenant"])
                if actual != {
                    k: active
                    for k in (
                        "tenantVisible",
                        "founderRole",
                        "publishedReport",
                        "draftReport",
                    )
                }:
                    raise RuntimeError(
                        "Upgrade failed current founder RLS/report projection"
                    )
                case["afterAccess"] = actual
            stable = sql(
                "select not exists(select 1 from public.tenant_users where membership_source='platform_founder'and not public.is_live_platform_founder(user_id))and not exists(select 1 from public.platform_founders f join public.users u on u.id=f.user_id cross join public.tenants t where f.revoked_at is null and u.is_axiom_internal and not exists(select 1 from public.tenant_users m where m.tenant_id=t.id and m.user_id=f.user_id));"
            )
            if stable != "t":
                raise RuntimeError("Derived projection is incomplete after upgrade")
            unchanged = {
                key: hashlib.sha256(
                    json.dumps(
                        before[key], sort_keys=True, separators=(",", ":")
                    ).encode()
                ).hexdigest()
                for key in (
                    "explicit",
                    "ledger",
                    "designations",
                    "users",
                    "tenants",
                    "engagements",
                    "entitlements",
                    "intakes",
                )
            }
            result = {
                "scope": "Genuine owned pre176 races then actual176 upgrade; SQL authority only",
                "migrationHashes": input_hashes,
                "cases": cases,
                "removedStaleDerived": len(removed),
                "addedMissingDerived": len(added),
                "unchangedHistoryHashes": unchanged,
                "validDerivedHistoryUnchanged": True,
                "historicalIntakeDefaultOwner": True,
            }
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=10)
        if created:
            command(["dropdb", "-U", "postgres", "--force", database])
            absent = command(
                [
                    "psql",
                    "-X",
                    "-U",
                    "supabase_admin",
                    "-d",
                    "postgres",
                    "-Atq",
                    "-v",
                    "ON_ERROR_STOP=1",
                ],
                "select not exists(select 1 from pg_catalog.pg_database where datname='"
                + database
                + "');",
            )
            if absent != "t":
                raise RuntimeError("Owned upgrade child database removal unconfirmed")
    if result is not None:
        result["ownedChildDatabaseRemoved"] = True
        print(json.dumps(result))


if __name__ == "__main__":
    main()
