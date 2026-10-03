#!/usr/bin/env python3
"""Record migrations that already ran under an older mechanism, without running them.

Situation this fixes: a local database was built before the checksummed runner
existed (for example by `supabase db push`), so its schema is current through
some migration but `axiom_migrations.applied` knows only 0000. The runner then
tries 0001, which fails with `type "user_role" already exists`.

This tool never drops or changes schema. It looks at which tables each
unrecorded migration creates and finds the longest unbroken prefix whose tables
all exist. It stops at the first migration whose tables are absent or only
partly there (a half-applied migration needs a human). By default it only
reports; `--apply` inserts the bookkeeping rows (name and sha256) and nothing
else. Undo: `delete from axiom_migrations.applied where name in (...)`.

Scope: a LOCAL Docker database reached with --container. It refuses anything
that is not a container name, so it cannot be pointed at a deployed database.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import subprocess  # nosec B404 - docker exec with a validated list argv, no shell
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CREATE_TABLE = re.compile(r"create\s+table\s+(?:if\s+not\s+exists\s+)?([\w.\"]+)", re.I)


def created_tables(sql: str) -> list[str]:
    names = [m.group(1).replace('"', "") for m in CREATE_TABLE.finditer(sql)]
    return sorted({n if "." in n else f"public.{n}" for n in names})


def plan(files: list[tuple[str, str]], existing: set[str], recorded: set[str]) -> tuple[list[str], str | None]:
    """Return (migration names to adopt, reason it stopped or None when it reached the end)."""
    adopt: list[str] = []
    for name, sql in files:
        if name in recorded:
            continue
        tables = created_tables(sql)
        present = [t for t in tables if t in existing]
        if tables and len(present) != len(tables):
            kind = "none of its tables exist" if not present else "only some of its tables exist (half-applied?)"
            return adopt, f"{name}: {kind}"
        adopt.append(name)
    return adopt, None


def psql(container: str, sql: str) -> str:
    r = subprocess.run(  # nosec B603 B607 - fixed docker/psql argv, container name validated by the caller
        ["docker", "exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-Atq"],
        input=sql,
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        raise SystemExit(f"psql failed: {r.stderr.strip()}")
    return r.stdout


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--container", required=True, help="local Docker Supabase DB container name")
    p.add_argument("--migrations", type=Path, default=ROOT / "infra/supabase/migrations")
    p.add_argument("--apply", action="store_true", help="insert the bookkeeping rows (default: report only)")
    args = p.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", args.container):
        raise SystemExit("--container must be a Docker container name")

    paths = sorted(args.migrations.glob("*.sql"))
    files = [(path.name, path.read_text()) for path in paths]
    has_ledger = psql(args.container, "select to_regclass('axiom_migrations.applied') is not null;").strip() == "t"
    recorded = set(psql(args.container, "select name from axiom_migrations.applied;").split()) if has_ledger else set()
    existing = set(psql(args.container, "select schemaname||'.'||tablename from pg_tables where schemaname not in ('pg_catalog','information_schema');").split())
    adopt, stopped = plan(files, existing, recorded)

    print(f"Already recorded: {len(recorded)}. Would adopt without running: {len(adopt)}.")
    if adopt:
        print(f"  first {adopt[0]}\n  last  {adopt[-1]}")
    if stopped:
        print(f"Stopped at {stopped}.\nThe normal runner will apply that migration and everything after it.")
    if not adopt:
        return 0
    if not args.apply:
        print("Report only. Re-run with --apply to record these rows.")
        return 0
    digests = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}
    values = ",".join(f"('{name}','{digests[name]}')" for name in adopt)  # nosec B608 - validated filenames and computed hex digests
    psql(
        args.container,
        "create schema if not exists axiom_migrations;"
        "create table if not exists axiom_migrations.applied (name text primary key, sha256 text not null, applied_at timestamptz not null default now());"
        f"insert into axiom_migrations.applied(name,sha256) values {values} on conflict(name) do nothing;",
    )
    print(f"Recorded {len(adopt)} migrations. Now re-run ./scripts/dev-docker.sh to apply the rest.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
