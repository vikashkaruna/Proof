#!/usr/bin/env python3
"""Checksummed, serialized, transactional migrations; never seeds users/passwords.

Uses psql's PG* environment, or --container for a provisioned Docker Supabase
instance. Supabase bootstrap requires its database administration role because
historical migration 0000 touches the Auth-owned schema. No credentials print.
"""
import argparse
import hashlib
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent


def unwrap_transaction(sql: str) -> str:
    # Preserve historical files on disk and their original checksums. Only a
    # whole-file BEGIN/COMMIT wrapper can be absorbed into the runner's txn.
    leading = re.match(r"(?:\s|--[^\n]*(?:\n|$)|/\*.*?\*/)*", sql, re.S).end()
    body = sql[leading:]
    if re.match(r"begin\s*;", body, re.I):
        begin = re.match(r"begin\s*;", body, re.I).end()
        end = re.search(r"\bcommit\s*;\s*$", body, re.I)
        if not end:
            raise ValueError("Whole-file BEGIN requires a final COMMIT")
        return sql[:leading] + body[begin:end.start()]
    return sql


def migration_program(directory: Path) -> str:
    program = [r"\set ON_ERROR_STOP on", "select pg_advisory_lock(756823010001);", """
create schema if not exists axiom_migrations;
revoke all on schema axiom_migrations from public,anon,authenticated;
create table if not exists axiom_migrations.applied (
  name text primary key, sha256 text not null, applied_at timestamptz not null default now()
);
revoke all on axiom_migrations.applied from public,anon,authenticated,service_role;
"""]
    files = sorted(directory.glob('*.sql'))
    if not files:
        raise ValueError('No migrations found')
    for path in files:
        if not re.fullmatch(r'[0-9]{4}_[a-z0-9_]+\.sql', path.name):
            raise ValueError(f'Invalid migration filename: {path.name}')
        raw = path.read_bytes()
        checksum = hashlib.sha256(raw).hexdigest()
        name = path.name
        program += [fr"""
do $migration_check$ begin
  if exists (select 1 from axiom_migrations.applied where name='{name}' and sha256<>'{checksum}') then
    raise exception 'Applied migration has changed: {name}';
  end if;
end $migration_check$;
select exists(select 1 from axiom_migrations.applied where name='{name}') as applied \gset
\if :applied
\echo Already applied: {name}
\else
\echo Applying: {name}
begin;
{unwrap_transaction(raw.decode())}
insert into axiom_migrations.applied(name,sha256) values('{name}','{checksum}');
commit;
\endif
"""]
    program.append('select pg_advisory_unlock(756823010001);')
    return '\n'.join(program)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container', help='Existing provisioned Supabase DB container')
    parser.add_argument('--user', default='supabase_admin', help='Database migration role')
    parser.add_argument('--database', default='postgres')
    parser.add_argument('--migrations', type=Path, default=ROOT / 'infra/supabase/migrations')
    args = parser.parse_args()
    cmd = ['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', args.user, '-d', args.database]
    if args.container:
        cmd = ['docker', 'exec', '-i', args.container] + cmd
    result = subprocess.run(cmd, input=migration_program(args.migrations), text=True, capture_output=True)
    # Only progress or SQL errors; no connection strings, environment or rows.
    for line in result.stdout.splitlines():
        if line.startswith(('Applying:', 'Already applied:')):
            print(line)
    if result.returncode:
        print(result.stderr, file=sys.stderr)
        return result.returncode
    print('Migrations complete; checksums recorded. No demo identities seeded.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
