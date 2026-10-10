#!/usr/bin/env python3
"""Prepare a reviewed private Cloud Run Job; run only its fixed bootstrap phases.

The prepare command never invokes gcloud. Runtime secrets enter via Secret
Manager environment bindings, never JSON values, process arguments or logs.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import importlib.util
import ipaddress
import json
import os
import re
import secrets
import subprocess  # nosec B404 - fixed psql/Python commands, no shell
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
PHASES = ("roles", "series", "inspect", "adopt")
COMPONENT = re.compile(r"axiom-proof-preprod-[a-z0-9-]+\Z")
SECRET_BINDINGS = {
    "SUPABASE_DB_URL": "ADMIN_DB_URL",
    "GOTRUE_DB_PASSWORD": "GOTRUE_DB_PASSWORD",
    "REST_DB_PASSWORD": "REST_DB_PASSWORD",
}


def required(source: dict[str, str], key: str) -> str:
    value = source.get(key, "")
    if not value:
        raise ValueError(f"Missing required configuration: {key}")
    return value


def private_ip(value: str) -> str:
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError:
        raise ValueError("Private SQL IPv4 address required") from None
    if not any(
        address in ipaddress.IPv4Network(cidr)
        for cidr in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
    ):
        raise ValueError("SQL bootstrap refuses public or loopback addresses")
    return value


def read_env(path: Path) -> dict[str, str]:
    if path.stat().st_mode & 0o077:
        raise ValueError("Environment source must have owner-only permissions")
    spec = importlib.util.spec_from_file_location(
        "marketing_literal_env", ROOT / "scripts/lib/ops-env-parse.py"
    )
    if spec is None or spec.loader is None:
        raise ValueError("Strict literal environment parser unavailable")
    parser = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(parser)
    return parser.parse(path)


def protected_json_write(path: Path, data: dict) -> None:
    """Refuse symlink destinations and protect existing bytes before writing."""
    import stat

    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError("Private artifact destination must be a regular file")
        os.fchmod(descriptor, 0o600)
        os.ftruncate(descriptor, 0)
        with os.fdopen(descriptor, "w") as output:
            descriptor = -1
            json.dump(data, output, indent=2)
            output.write("\n")
    finally:
        if descriptor != -1:
            os.close(descriptor)


def job_payload(source: dict[str, str], phase: str) -> dict:
    if phase not in PHASES:
        raise ValueError("Unsupported bootstrap phase")
    project = required(source, "GCP_PROJECT_ID")
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project):
        raise ValueError("Invalid explicitly selected project")
    if (
        source.get("ENVIRONMENT") != "preprod"
        or source.get("GCP_REGION") != "asia-south1"
    ):
        raise ValueError("Migration job is Mumbai preprod only")
    names = {
        key: required(source, key)
        for key in (
            "MARKETING_MIGRATION_JOB_NAME",
            "MARKETING_NETWORK_NAME",
            "MARKETING_SUBNETWORK_NAME",
            "CLOUD_SQL_INSTANCE_NAME",
        )
    }
    if not all(COMPONENT.fullmatch(value) for value in names.values()):
        raise ValueError(
            "Job/database/network names must follow the preprod convention"
        )
    account = required(source, "MARKETING_MIGRATION_SERVICE_ACCOUNT")
    if not re.fullmatch(
        r"axiom-proof-preprod-[a-z0-9-]+@"
        + re.escape(project)
        + r"\.iam\.gserviceaccount\.com",
        account,
    ):
        raise ValueError(
            "A dedicated same-project preprod migration account is required"
        )
    image = required(source, "MARKETING_MIGRATION_IMAGE")
    if not re.fullmatch(
        r"asia-south1-docker\.pkg\.dev/"
        + re.escape(project)
        + r"/[^/]+/[^@]+@sha256:[a-f0-9]{64}",
        image,
    ):
        raise ValueError("Reviewed same-project immutable migration image required")
    cpu = required(source, "MARKETING_MIGRATION_CPU")
    memory = required(source, "MARKETING_MIGRATION_MEMORY")
    timeout = required(source, "MARKETING_MIGRATION_TIMEOUT_SECONDS")
    if (
        cpu != "1"
        or not re.fullmatch(r"[1-9][0-9]*(Mi|Gi)", memory)
        or not timeout.isdecimal()
        or not 60 <= int(timeout) <= 1800
    ):
        raise ValueError(
            "Explicit bounded migration CPU/memory/timeout configuration required"
        )
    database = required(source, "CLOUD_SQL_DATABASE_NAME")
    if not re.fullmatch(r"axiom_proof_[a-z0-9_]+", database):
        raise ValueError("Invalid allowlisted application database")
    host = private_ip(required(source, "CLOUD_SQL_PRIVATE_IP"))
    env = [
        {"name": key, "value": value}
        for key, value in {
            "ENVIRONMENT": "preprod",
            "GCP_REGION": "asia-south1",
            "CLOUD_SQL_PRIVATE_IP": host,
            "CLOUD_SQL_DATABASE_NAME": database,
            "CLOUD_SQL_INSTANCE_NAME": names["CLOUD_SQL_INSTANCE_NAME"],
            "CLOUD_SQL_ADMIN_USER": required(source, "CLOUD_SQL_ADMIN_USER"),
        }.items()
    ]
    if phase == "adopt":
        for key in (
            "GCP_PROJECT_ID", "AXIOM_RELEASE_SHA", "MARKETING_MIGRATION_SERVICE_ACCOUNT",
            "MARKETING_MIGRATION_JOB_NAME", "MARKETING_AUTH_SERVICE_NAME",
            "MARKETING_LIFECYCLE_SCHEDULER_NAME", "AXIOM_IDLE_STATE_BUCKET",
            "MARKETING_ADOPTION_BINDING",
        ):
            env.append({"name": key, "value": required(source, key)})
        spec = importlib.util.spec_from_file_location(
            "marketing_adoption_payload", ROOT / "scripts/marketing-state-adoption.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.admission_binding(source, json.loads(source["MARKETING_ADOPTION_BINDING"]))
    for name, prefix in SECRET_BINDINGS.items():
        if phase != "roles" and name != "SUPABASE_DB_URL":
            continue
        secret = required(source, f"MARKETING_{prefix}_SECRET_ID")
        version = required(source, f"MARKETING_{prefix}_SECRET_VERSION")
        if not COMPONENT.fullmatch(secret) or not re.fullmatch(r"[1-9][0-9]*", version):
            raise ValueError(
                "Explicit preprod secret IDs and materialized numeric versions required"
            )
        env.append(
            {
                "name": name,
                "valueSource": {
                    "secretKeyRef": {
                        "secret": f"projects/{project}/secrets/{secret}",
                        "version": version,
                    }
                },
            }
        )
    return {
        "name": f"projects/{project}/locations/asia-south1/jobs/{names['MARKETING_MIGRATION_JOB_NAME']}",
        "template": {
            "taskCount": 1,
            "parallelism": 1,
            "template": {
                "serviceAccount": account,
                "maxRetries": 0,
                "timeout": f"{timeout}s",
                "containers": [
                    {
                        "image": image,
                        "command": ["python3"],
                        "args": [
                            "/app/scripts/marketing-db-job.py",
                            "run-phase",
                            "--phase",
                            phase,
                        ],
                        "env": env,
                        "resources": {"limits": {"cpu": cpu, "memory": memory}},
                    }
                ],
                "vpcAccess": {
                    "networkInterfaces": [
                        {
                            "network": f"projects/{project}/global/networks/{names['MARKETING_NETWORK_NAME']}",
                            "subnetwork": f"projects/{project}/regions/asia-south1/subnetworks/{names['MARKETING_SUBNETWORK_NAME']}",
                        }
                    ],
                    "egress": "PRIVATE_RANGES_ONLY",
                },
            },
        },
    }


def scram_verifier(password: str) -> str:
    # Printable ASCII has identical SASLprep semantics in PostgreSQL and libpq.
    if len(password) < 32 or any(ord(c) < 33 or ord(c) > 126 for c in password):
        raise ValueError(
            "Role password must contain at least32 printable ASCII characters"
        )
    salt = secrets.token_bytes(16)
    salted = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 4096)
    client = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored = hashlib.sha256(client).digest()
    server = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    enc = lambda value: base64.b64encode(value).decode()
    return f"SCRAM-SHA-256$4096:{enc(salt)}${enc(stored)}:{enc(server)}"


def migration_module():
    spec = importlib.util.spec_from_file_location(
        "marketing_checked_migrations", ROOT / "scripts/migrate-database.py"
    )
    if spec is None or spec.loader is None:
        raise ValueError("Checksummed migration runner unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def runtime_environment(source: dict[str, str]) -> dict[str, str]:
    if (
        source.get("ENVIRONMENT") != "preprod"
        or source.get("GCP_REGION") != "asia-south1"
    ):
        raise ValueError("Runtime bootstrap is Mumbai preprod only")
    host = private_ip(required(source, "CLOUD_SQL_PRIVATE_IP"))
    dsn = required(source, "SUPABASE_DB_URL")
    parsed = urlparse(dsn)
    if parsed.hostname != host or unquote(parsed.path).lstrip("/") != required(
        source, "CLOUD_SQL_DATABASE_NAME"
    ):
        raise ValueError(
            "Admin connection does not match exact private database allowlist"
        )
    env = migration_module().dsn_environment(dsn)
    if env.get("PGSSLMODE") not in ("require", "verify-ca", "verify-full"):
        raise ValueError(
            "Private bootstrap still requires encrypted database transport"
        )
    if (
        env.get("PGUSER") != required(source, "CLOUD_SQL_ADMIN_USER")
        or env.get("PGPORT") != "5432"
    ):
        raise ValueError("Exact bootstrap admin role and PostgreSQL port5432 required")
    # Do not inherit libpq PGHOSTADDR/PGSERVICE overrides or unrelated app secrets.
    permitted = ("PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSSLMODE")
    return {
        **{key: env[key] for key in permitted if key in env},
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
    }


def run_sql(sql: str, env: dict[str, str]) -> None:
    result = subprocess.run(  # nosec B603 B607 - fixed psql argv; SQL via stdin, secrets absent from argv
        ["psql", "-X", "-q", "-w", "-v", "ON_ERROR_STOP=1"],
        input=sql,
        text=True,
        capture_output=True,
        env=env,
        timeout=1500,
        check=False,
    )
    if result.returncode:
        # Database errors may include SQL literals/hashes; never forward them to logs.
        raise ValueError("Private bootstrap SQL refused; no subsequent phase was run")


def roles_program(source: dict[str, str]) -> str:
    auth = scram_verifier(required(source, "GOTRUE_DB_PASSWORD"))
    rest = scram_verifier(required(source, "REST_DB_PASSWORD"))
    bootstrap = migration_module().unwrap_transaction(
        (ROOT / "infra/supabase/bootstrap-selfhosted.sql").read_text()
    )
    return (
        """begin;
select pg_advisory_xact_lock(756823010001);
-- Cloud SQL managed extension allowlist supplies pgvector; local limited-admin
-- rehearsal must install this extension using its privileged fixture owner.
create extension if not exists vector;
do $$begin
 if exists(select 1 from information_schema.tables where table_schema='auth') then
  raise exception 'roles phase requires empty auth before GoTrue';end if;
end $$;
"""
        + bootstrap
        + f"""
do $$begin
 if not exists(select 1 from pg_roles where rolname='supabase_auth_admin') then
  create role supabase_auth_admin login noinherit;end if;
end $$;
alter role supabase_auth_admin login connection limit 2 password '{auth}';
alter role supabase_auth_admin set search_path=auth;
alter role authenticator login noinherit connection limit 3 password '{rest}';
alter role authenticator set statement_timeout='20s';
do $$begin execute format('alter role %I connection limit 3',current_user);end $$;
do $$begin execute format('grant supabase_auth_admin to %I',current_user);end $$;
alter schema auth owner to supabase_auth_admin;
grant usage,create on schema auth to supabase_auth_admin;
grant usage on schema public to supabase_auth_admin;
commit;
"""
    )


MANAGED_ROLE_ADAPTERS = {
    "0089_pramaan_source_bound.sql": {
        "sha256": "a0daf4cb95a3bd0915de08b3548b120af530b91bbc5d0223c06b7cd05e71bd75",
        "roles": ["statutory_proof_writer"],
    },
    "0090_approval_proof_archive.sql": {
        "sha256": "73017e8e5827727877bb7be1e882fa4f05969865c990bf51800a0afa4fbc7e74",
        "roles": ["approval_archive_writer"],
    },
    "0098_human_provider_proof_writers.sql": {
        "sha256": "9ee22a1f0d60c3f227c97f983a3525ee6abed9b170662080ddbffbc1ea490ef6",
        "roles": ["human_action_writer", "evidence_ingestion_writer"],
    },
    "0099_ledger_source_and_execution_gate.sql": {
        "sha256": "b28494737d305b224f3af11c4496e85d66fcab0cd4075a1591333674ee0e6785",
        "roles": ["agent_ledger_writer"],
    },
}


def role_posture_sql(role: str) -> str:
    if role not in {
        r for entry in MANAGED_ROLE_ADAPTERS.values() for r in entry["roles"]
    }:
        raise ValueError("Unregistered managed-role adapter refused")
    return f"""do $managed_role_posture$ begin
 if not exists(select 1 from pg_roles where rolname='{role}')
 or exists(select 1 from pg_roles where rolname='{role}' and (rolsuper or rolbypassrls)) then
  raise exception 'managed role requires existing NOSUPERUSER NOBYPASSRLS posture' using errcode='42501';end if;
end $managed_role_posture$;
"""


def managed_adapter_manifest() -> dict:
    entries = []
    runner = migration_module()
    for name, reviewed in MANAGED_ROLE_ADAPTERS.items():
        raw = (ROOT / "infra/supabase/migrations" / name).read_bytes()
        if hashlib.sha256(raw).hexdigest() != reviewed["sha256"]:
            raise ValueError(
                "Frozen managed-role migration does not match approved adapter source hash"
            )
        original_body = runner.unwrap_transaction(raw.decode())
        effective = original_body
        changes = []
        for role in reviewed["roles"]:
            old = f"alter role {role} nologin noinherit nobypassrls;"
            if effective.count(old) != 1:
                raise ValueError("Exact managed-role adapter clause unavailable")
            guard = role_posture_sql(role)
            new = guard + f"alter role {role} nologin noinherit;\n" + guard
            effective = effective.replace(old, new)
            changes.append(
                {"role": role, "original_clause": old, "effective_clause": new}
            )
        entries.append(
            {
                "migration_name": name,
                "original_sha256": reviewed["sha256"],
                "original_unwrapped_sha256": hashlib.sha256(
                    original_body.encode()
                ).hexdigest(),
                "effective_body_sha256": hashlib.sha256(effective.encode()).hexdigest(),
                "changes": changes,
            }
        )
    manifest = {
        "adapter_version": "marketing-managed-role-posture-v1",
        "migrations": entries,
        "hash_scope": "Original exact file bytes vs effective unwrapped migration body; transaction/checksum/adapter receipt envelope is separately program-hashed",
    }
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"))
    return {
        **manifest,
        "manifest_sha256": hashlib.sha256(canonical.encode()).hexdigest(),
    }


def managed_migration_program() -> str:
    runner = migration_module()
    manifest = managed_adapter_manifest()
    program = runner.migration_program(ROOT / "infra/supabase/migrations")
    anchor = "revoke all on axiom_migrations.applied from public,anon,authenticated,service_role;"
    if program.count(anchor) != 1:
        raise ValueError("Reviewed checksum runner envelope changed")
    receipts = """
create table if not exists axiom_migrations.deployment_adapters (
 migration_name text primary key references axiom_migrations.applied(name) deferrable initially deferred,
 original_sha256 text not null check(original_sha256 ~ '^[a-f0-9]{64}$'),
 effective_body_sha256 text not null check(effective_body_sha256 ~ '^[a-f0-9]{64}$'),
 manifest_sha256 text not null check(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 changes jsonb not null, recorded_at timestamptz not null default clock_timestamp()
);
revoke all on axiom_migrations.deployment_adapters from public,anon,authenticated,service_role;
create or replace function axiom_migrations.adapter_receipt_immutable() returns trigger language plpgsql set search_path='' as $$begin
 raise exception 'deployment adapter receipt is append-only' using errcode='42501';
end $$;
drop trigger if exists adapter_receipt_immutable on axiom_migrations.deployment_adapters;
create trigger adapter_receipt_immutable before update or delete on axiom_migrations.deployment_adapters for each row execute function axiom_migrations.adapter_receipt_immutable();
drop trigger if exists adapter_receipt_no_truncate on axiom_migrations.deployment_adapters;
create trigger adapter_receipt_no_truncate before truncate on axiom_migrations.deployment_adapters for each statement execute function axiom_migrations.adapter_receipt_immutable();
"""
    program = program.replace(anchor, anchor + receipts)
    for entry in manifest["migrations"]:
        name = entry["migration_name"]
        original = runner.unwrap_transaction(
            (ROOT / "infra/supabase/migrations" / name).read_text()
        )
        effective = original
        for change in entry["changes"]:
            effective = effective.replace(
                change["original_clause"], change["effective_clause"]
            )
        if program.count(original) != 1:
            raise ValueError("Exact reviewed migration body unavailable in runner")
        # No secrets: all interpolated identifiers/hashes/clauses are frozen constants.
        changes = json.dumps(entry["changes"], sort_keys=True).replace("'", "''")
        receipt = f"""
insert into axiom_migrations.deployment_adapters(migration_name,original_sha256,effective_body_sha256,manifest_sha256,changes)
 values('{name}','{entry["original_sha256"]}','{entry["effective_body_sha256"]}','{manifest["manifest_sha256"]}','{changes}'::jsonb);
"""
        program = program.replace(original, effective + receipt)
        existing_check = f"""do $adapter_check$ begin
 if exists(select 1 from axiom_migrations.applied where name='{name}')
 and not exists(select 1 from axiom_migrations.deployment_adapters where migration_name='{name}'
 and original_sha256='{entry["original_sha256"]}' and effective_body_sha256='{entry["effective_body_sha256"]}'
 and manifest_sha256='{manifest["manifest_sha256"]}' and changes='{changes}'::jsonb) then
  raise exception 'recorded managed migration adapter provenance absent or changed';end if;
end $adapter_check$;
"""
        start = (
            "do $migration_check$ begin\n"
            + f"  if exists (select 1 from axiom_migrations.applied where name='{name}'"
        )
        if start not in program:
            raise ValueError("Reviewed migration checkpoint unavailable")
        program = program.replace(start, existing_check + start)
    return program


def series_program() -> str:
    # Fail before migration0000 can create a hand-rolled auth.users.
    before = (
        "do $$begin\n"
        + "\n".join(
            f"if exists(select 1 from pg_roles where rolname='{role}' and (rolsuper or rolbypassrls)) then raise exception 'managed role unsafe before series';end if;"
            for entry in MANAGED_ROLE_ADAPTERS.values()
            for role in entry["roles"]
        )
        + "\nend $$;\n"
        + """do $$begin
 if to_regclass('auth.schema_migrations') is null or to_regclass('auth.users') is null then
  raise exception 'GoTrue own migrations must complete before application series';end if;
 if not exists(select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='auth' and t.typname='factor_type') then
  raise exception 'GoTrue auth search_path/migrations unconfirmed';end if;
end $$;
"""
    )
    after = (
        "do $$begin\n"
        + "\n".join(
            f"if not exists(select 1 from pg_roles where rolname='{role}' and not rolsuper and not rolbypassrls and not rolcanlogin and not rolinherit) then raise exception 'managed role unsafe after series';end if;"
            for entry in MANAGED_ROLE_ADAPTERS.values()
            for role in entry["roles"]
        )
        + "\nend $$;\n"
        + """
begin;
-- Narrow marketing-only grants. Never regrant product tables or BYPASSRLS.
grant usage on schema public to service_role;
grant select,insert,update on public.contact_inquiries,public.gap_scan_responses to service_role;
drop policy if exists marketing_bootstrap_gap_scan_read on public.gap_scan_responses;
drop policy if exists marketing_bootstrap_gap_scan_insert on public.gap_scan_responses;
drop policy if exists marketing_bootstrap_gap_scan_update on public.gap_scan_responses;
create policy marketing_bootstrap_gap_scan_read on public.gap_scan_responses for select to service_role using(true);
create policy marketing_bootstrap_gap_scan_insert on public.gap_scan_responses for insert to service_role with check(true);
create policy marketing_bootstrap_gap_scan_update on public.gap_scan_responses for update to service_role using(true) with check(true);
do $$begin
 if exists(select 1 from (values('contact_inquiries'),('gap_scan_responses')) tables(name)
 cross join (values('SELECT'),('INSERT'),('UPDATE')) privileges(name)
 where not has_table_privilege('service_role','public.'||tables.name,privileges.name))
 or not has_function_privilege('service_role','public.take_rate_limit(text,text,integer,integer)','EXECUTE') then
  raise exception 'marketing service role permissions unconfirmed';end if;
 if exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls) then
  raise exception 'marketing bootstrap must not rely on BYPASSRLS';end if;
end $$;
commit;
"""
    )
    return before + managed_migration_program() + after


def library_seed_program(path: Path, release: str) -> str:
    if not re.fullmatch(r"[a-f0-9]{40}", release):
        raise ValueError("Exact library release SHA required")
    artifact = json.loads(path.read_text())
    seed = artifact["seed"]
    compact = json.dumps(seed, separators=(",", ":"), ensure_ascii=False)
    digest = hashlib.sha256(compact.encode()).hexdigest()
    if (
        artifact.get("schemaVersion") != 1
        or artifact.get("releaseSha") != release
        or artifact.get("seedSha256") != digest
        or artifact.get("controlCount") != len(seed["controls"])
        or not seed["controls"]
        or len({control["id"] for control in seed["controls"]}) != len(seed["controls"])
        or any(
            control["library_version"] != seed["version"]
            for control in seed["controls"]
        )
        or not artifact.get("sourceHashes")
        or any(
            not re.fullmatch(r"[a-f0-9]{64}", value)
            for value in artifact["sourceHashes"].values()
        )
    ):
        raise ValueError("Exact validated library artifact refused")
    body = compact.replace("'", "''")
    artifact_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    return f"""
begin;
select pg_advisory_xact_lock(hashtextextended('axiom-marketing-library-seed',0));
lock table public.control_libraries,public.controls in share row exclusive mode;
do $library$ declare
 s jsonb := '{body}'::jsonb; v text := s->>'version'; expected public.controls; actual public.controls;
 n integer := jsonb_array_length(s->'controls'); c jsonb;
begin
 if exists(select 1 from public.control_libraries where is_current and version<>v) then
  raise exception 'Different current library; implicit replacement refused';end if;
 if exists(select 1 from public.control_libraries where version=v) then
  if not exists(select 1 from public.control_libraries where version=v
   and published_at=(s->>'publishedAt')::timestamptz and published_by=s->>'publishedBy'
   and change_log=s->>'changeLog' and control_count=n) then
   raise exception 'Existing published library metadata mismatch';end if;
  if (select count(*) from public.controls where library_version=v)<>n then
   raise exception 'Existing library control set mismatch';end if;
 else
  insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
   values(v,(s->>'publishedAt')::timestamptz,s->>'publishedBy',s->>'changeLog',n);
  insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,tags,sdf_only,children_only,introduced_in_version,revised_in_version,notes)
   select id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,tags,sdf_only,children_only,introduced_in_version,revised_in_version,notes
   from jsonb_populate_recordset(null::public.controls,s->'controls');
 end if;
 for c in select value from jsonb_array_elements(s->'controls') loop
  expected := jsonb_populate_record(null::public.controls,c);
  select * into actual from public.controls where id=expected.id and library_version=v;
  if not found or (to_jsonb(actual)-'created_at') is distinct from (to_jsonb(expected)-'created_at') then
   raise exception 'Exact published control content mismatch';end if;
 end loop;
 update public.control_libraries set is_current=true where version=v and not is_current;
end $library$;
create table if not exists axiom_migrations.marketing_library_builds (
 release_sha text primary key check(release_sha ~ '^[a-f0-9]{{40}}$'),
 artifact_sha256 text not null, seed_sha256 text not null, recorded_at timestamptz not null default now());
revoke all on axiom_migrations.marketing_library_builds from public,anon,authenticated,service_role;
drop trigger if exists marketing_library_build_immutable on axiom_migrations.marketing_library_builds;
create trigger marketing_library_build_immutable before update or delete on axiom_migrations.marketing_library_builds for each row execute function axiom_migrations.adapter_receipt_immutable();
drop trigger if exists marketing_library_build_no_truncate on axiom_migrations.marketing_library_builds;
create trigger marketing_library_build_no_truncate before truncate on axiom_migrations.marketing_library_builds for each statement execute function axiom_migrations.adapter_receipt_immutable();
do $$begin
 if exists(select 1 from axiom_migrations.marketing_library_builds where release_sha='{release}'
 and (artifact_sha256<>'{artifact_hash}' or seed_sha256<>'{digest}')) then
  raise exception 'Recorded release library artifact mismatch';end if;
end $$;
insert into axiom_migrations.marketing_library_builds(release_sha,artifact_sha256,seed_sha256)
 values('{release}','{artifact_hash}','{digest}') on conflict do nothing;
commit;
"""


def run_phase(source: dict[str, str], phase: str) -> None:
    if phase not in PHASES:
        raise ValueError("Unsupported bootstrap phase")
    env = runtime_environment(source)
    if phase == "adopt":
        spec = importlib.util.spec_from_file_location(
            "marketing_fenced_adoption", ROOT / "scripts/marketing-state-adoption.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.run_adoption_job(source, env)
        return
    if phase == "inspect":
        inspect_clients(source, env)
        return
    program = (
        roles_program(source)
        if phase == "roles"
        else series_program()
        + library_seed_program(
            ROOT / "infra/supabase/marketing-library.json",
            required(source, "AXIOM_RELEASE_SHA"),
        )
    )
    run_sql(program, env)
    print(f"Marketing private database {phase} phase completed; no demo users seeded.")
    if phase == "series":
        print(
            "Managed adapter manifest SHA256: "
            + managed_adapter_manifest()["manifest_sha256"]
        )
        print(
            "Effective executed series envelope SHA256: "
            + hashlib.sha256(program.encode()).hexdigest()
        )


def inspection_program() -> str:
    """Metadata only. Unknown/invisible sessions cannot establish safe adoption."""
    return """begin read only;
set local statement_timeout='10s';
select json_build_object(
 'database',current_database(),'server_version_num',current_setting('server_version_num'),
 'encrypted_transport',(select ssl from pg_stat_ssl where pid=pg_backend_pid()),
 'observer_role',current_user,
 'observer_superuser',(select rolsuper from pg_roles where rolname=current_user),
 'observer_bypassrls',(select rolbypassrls from pg_roles where rolname=current_user),
 'observer_can_read_all_stats',pg_has_role(current_user,'pg_read_all_stats','member'),
 'login_roles',(select json_agg(json_build_object(
    'name',rolname,'connection_limit',rolconnlimit,'superuser',rolsuper,
    'bypassrls',rolbypassrls) order by rolname) from pg_roles where rolcanlogin),
 'auth_migrations',(select count(*) from auth.schema_migrations),
 'application_migrations',(select count(*) from axiom_migrations.applied),
 'clients',coalesce((select json_agg(json_build_object(
    'role',usename,'state',state,'open_transaction',xact_start is not null,
    'backend_type',backend_type)) from pg_stat_activity
    where datname=current_database() and pid<>pg_backend_pid()),'[]'::json));
commit;
"""



def admission_programs(database: str) -> dict[str, str]:
    """Fixed PG15 maintenance SQL; only the exact new target admission flag changes."""
    if not re.fullmatch(r"axiom_proof_preprod(?:_[a-z0-9_]+)?", database):
        raise ValueError("Exact preprod database identifier required")
    name = '"' + database + '"'
    value = "'" + database + "'"
    identity = """select json_build_object(
 'pid',pg_backend_pid(),'maintenance_database',current_database(),'role',current_user,
 'server_version_num',current_setting('server_version_num'),
 'encrypted_transport',(select ssl from pg_stat_ssl where pid=pg_backend_pid()),
 'stats_visible',(select rolsuper from pg_roles where rolname=current_user) or pg_has_role('pg_read_all_stats','usage'),
 'database_oid',oid::bigint,'database_name',datname,'allow_connections',datallowconn,
 'owner_capable',(select rolsuper from pg_roles where rolname=current_user) or pg_has_role(datdba,'usage'),
 'shared_preloads',current_setting('shared_preload_libraries'))
 from pg_database where datname=""" + value + ";"
    return {
        'identity': identity,
        'close': "begin;set local lock_timeout='5s';set local statement_timeout='10s';alter database " + name + " allow_connections false;commit;" + identity,
        'startup_locks': "select pg_stat_clear_snapshot();select json_build_object('pid',pg_backend_pid(),'startup_locks',(select count(*) from pg_locks where locktype='object' and classid='pg_database'::regclass and objid=(select oid from pg_database where datname=" + value + ") and objsubid=0 and mode='RowExclusiveLock'));",
        'clients': "select pg_stat_clear_snapshot();select json_build_object('pid',pg_backend_pid(),'clients',coalesce((select json_agg(json_build_object('pid',pid,'role',usename,'backend_type',backend_type,'state',state)) from pg_stat_activity where datname=" + value + " and backend_type='client backend'),'[]'::json),'unknown_workers',coalesce((select json_agg(json_build_object('pid',pid,'backend_type',backend_type)) from pg_stat_activity where datname=" + value + " and backend_type not in ('client backend','autovacuum worker')),'[]'::json),'maintenance_clients',(select count(*) from pg_stat_activity where backend_type='client backend' and usename=current_user and pid<>pg_backend_pid()),'prepared_transactions',(select count(*) from pg_prepared_xacts where database=" + value + "));",
        'open': "begin;set local lock_timeout='5s';set local statement_timeout='10s';alter database " + name + " allow_connections true;commit;" + identity,
    }

def inspect_clients(source: dict[str, str], env: dict[str, str]) -> None:
    result = subprocess.run(  # nosec B603 B607 - fixed read-only psql, TLS env, no query text or credentials in output
        ["psql", "-X", "-q", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1"],
        input=inspection_program(),
        text=True,
        capture_output=True,
        env=env,
        timeout=15,
        check=False,
    )
    if result.returncode:
        raise ValueError("Read-only client inspection failed")
    value = json.loads(result.stdout)
    if (
        not isinstance(value, dict)
        or value.get("database") != source.get("CLOUD_SQL_DATABASE_NAME")
        or value.get("encrypted_transport") is not True
    ):
        raise ValueError("Read-only client inspection target or TLS mismatch")
    # Caller validates and binds these facts to independently fetched cloud IAM,
    # network and job receipts. A snapshot is never itself an exclusive gate.
    print(
        json.dumps(
            {
                "kind": "marketing-database-client-inspection",
                "release_sha": required(source, "AXIOM_RELEASE_SHA"),
                "facts": value,
            },
            sort_keys=True,
        )
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="mode", required=True)
    prepare = sub.add_parser("prepare")
    prepare.add_argument("--env-file", type=Path, required=True)
    prepare.add_argument("--phase", choices=PHASES, required=True)
    prepare.add_argument("--output", type=Path, required=True)
    run = sub.add_parser("run-phase")
    run.add_argument("--phase", choices=PHASES, required=True)
    args = parser.parse_args()
    try:
        if args.mode == "prepare":
            data = job_payload(read_env(args.env_file), args.phase)
            args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            protected_json_write(args.output, data)
            artifact = args.output.with_suffix(".adapters.json")
            protected_json_write(artifact, managed_adapter_manifest())
            print(
                "Private migration Job JSON prepared only; no cloud change performed."
            )
        else:
            run_phase(dict(os.environ), args.phase)
    except (ValueError, OSError, subprocess.TimeoutExpired):
        print(
            "Marketing database job configuration or phase refused; secrets withheld.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
