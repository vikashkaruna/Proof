#!/usr/bin/env python3
"""Checksummed, serialized, transactional migrations; never seeds users/passwords.

Uses psql's PG* environment, --container for a provisioned Docker Supabase
instance, or --dsn for a deployed database reached over the network. Supabase
bootstrap requires its database administration role because historical
migration 0000 touches the Auth-owned schema. No credentials print.
"""
import argparse
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import parse_qs, unquote, urlparse

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


def dsn_environment(dsn: str) -> dict:
    """Split a postgres:// URL into libpq PG* variables.

    Deliberately not passed to psql as a URI. An argument is visible in `ps` to
    every user on the host, and on a deploy runner that is how a database
    password leaks into a process listing. libpq reads these from the
    environment instead, so the password never appears in argv.
    """
    parsed = urlparse(dsn)
    if parsed.scheme not in ('postgres', 'postgresql'):
        raise ValueError('--dsn must be a postgres:// or postgresql:// URL')
    if not parsed.hostname:
        raise ValueError('--dsn must name a host')
    database = unquote(parsed.path).lstrip('/')
    if not database:
        raise ValueError('--dsn must name a database')

    env = dict(os.environ)
    env['PGHOST'] = parsed.hostname
    env['PGPORT'] = str(parsed.port or 5432)
    env['PGDATABASE'] = database
    if parsed.username:
        env['PGUSER'] = unquote(parsed.username)
    if parsed.password:
        env['PGPASSWORD'] = unquote(parsed.password)
    # A deployed database is reached over a network the runner does not own.
    # Absent an explicit choice, require TLS rather than inheriting libpq's
    # `prefer`, which silently falls back to plaintext.
    sslmode = parse_qs(parsed.query).get('sslmode', [None])[0]
    env['PGSSLMODE'] = sslmode or 'require'
    return env


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container', help='Existing provisioned Supabase DB container')
    parser.add_argument('--dsn', help='postgres:// URL for a deployed database')
    parser.add_argument('--user', default='supabase_admin', help='Database migration role')
    parser.add_argument('--database', default='postgres')
    parser.add_argument('--migrations', type=Path, default=ROOT / 'infra/supabase/migrations')
    args = parser.parse_args()
    if args.dsn and args.container:
        print('--dsn and --container name different databases; pass one.', file=sys.stderr)
        return 2

    env = None
    if args.dsn:
        try:
            env = dsn_environment(args.dsn)
        except ValueError as exc:
            # The message names the defect, never the value.
            print(f'Invalid --dsn: {exc}', file=sys.stderr)
            return 2
        # Connection comes from PG* in the environment, so no -U/-d here.
        cmd = ['psql', '-X', '-q', '-w', '-v', 'ON_ERROR_STOP=1']
    else:
        cmd = ['psql', '-X', '-q', '-w', '-v', 'ON_ERROR_STOP=1', '-U', args.user, '-d', args.database]
        if args.container:
            cmd = ['docker', 'exec', '-i', args.container] + cmd
    result = subprocess.run(
        cmd, input=migration_program(args.migrations), text=True, capture_output=True, env=env
    )
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
