#!/usr/bin/env python3
"""Provision the reconciliation verifier's HMAC key using a DB-admin connection.

APPROVAL_SIGNING_KEY and SUPABASE_DB_URL are read from the environment and
never passed in argv or printed. The database role must own
axiom_secrets.reconciliation_keys; a
PostgREST service credential cannot use this operation. Repeated runs with the
same key are idempotent; a different key is refused to protect old proofs.
"""

import argparse
import os
import re
import subprocess  # nosec B404 - fixed psql argv, secret only in environment
import sys
from urllib.parse import parse_qs, unquote, urlparse


def dsn_environment(dsn: str) -> dict[str, str]:
    parsed = urlparse(dsn)
    if parsed.scheme not in ("postgres", "postgresql") or not parsed.hostname or not parsed.path.strip("/"):
        raise ValueError("a postgres:// URL with host and database is required")
    env = dict(os.environ)
    env["PGHOST"] = parsed.hostname
    env["PGPORT"] = str(parsed.port or 5432)
    env["PGDATABASE"] = unquote(parsed.path).lstrip("/")
    if parsed.username:
        env["PGUSER"] = unquote(parsed.username)
    if parsed.password:
        env["PGPASSWORD"] = unquote(parsed.password)
    env["PGSSLMODE"] = parse_qs(parsed.query).get("sslmode", ["require"])[0]
    return env


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-id", help="Tenant UUID; omit for the shared default key")
    args = parser.parse_args()
    key = os.environ.get("APPROVAL_SIGNING_KEY", "")
    if len(key.encode("utf-8")) < 32 or "\x00" in key:
        print("APPROVAL_SIGNING_KEY must contain at least 32 UTF-8 bytes.", file=sys.stderr)
        return 2
    if args.tenant_id and not re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", args.tenant_id):
        print("Invalid tenant UUID.", file=sys.stderr)
        return 2
    scope = f"tenant:{args.tenant_id.lower()}" if args.tenant_id else "global"
    try:
        env = dsn_environment(os.environ.get("SUPABASE_DB_URL", ""))
    except ValueError:
        print("SUPABASE_DB_URL must be a valid DB-admin PostgreSQL URL.", file=sys.stderr)
        return 2
    env.pop("APPROVAL_SIGNING_KEY", None)
    env.pop("SUPABASE_DB_URL", None)
    env["PGCONNECT_TIMEOUT"] = "10"
    # COPY sends the secret as data, not inside an SQL statement that a
    # statement logger could record. The temporary staging table disappears
    # at commit; the encrypted DB connection comes from libpq's PG* env.
    sql = r"""
\set ON_ERROR_STOP on
\set QUIET on
begin;
create temporary table reconciliation_key_stage(scope text,key_hex text) on commit drop;
\copy reconciliation_key_stage(scope,key_hex) from stdin
""" + f"{scope}\t{key.encode('utf-8').hex()}\n" + r"""\.
insert into axiom_secrets.reconciliation_keys(scope,key_bytes)
select scope,decode(key_hex,'hex') from reconciliation_key_stage
on conflict(scope) do nothing;
select 1 / case when (select k.key_bytes=decode(s.key_hex,'hex')
  from axiom_secrets.reconciliation_keys k join reconciliation_key_stage s using(scope))
  then 1 else 0 end;
commit;
"""
    try:
        result = subprocess.run(  # nosec B603 - fixed psql argv, no shell
            ["psql", "-X", "-q", "-w", "-v", "ON_ERROR_STOP=1"],
            input=sql, text=True, capture_output=True, env=env, timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        print("Reconciliation key provisioning could not reach PostgreSQL.", file=sys.stderr)
        return 1
    if result.returncode:
        print("Reconciliation key provisioning failed or conflicts with the existing key.", file=sys.stderr)
        return 1
    print(f"Reconciliation verifier key confirmed for {scope}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
