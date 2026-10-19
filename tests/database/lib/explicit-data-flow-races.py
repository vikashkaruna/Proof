#!/usr/bin/env python3
"""Real declaration/fence/source/head lock orders in owned disposable SQL.

Only synthetic fixture users, session attestations and SQL factor counters.
No retained database, GoTrue/TOTP, target write, signing key or provider claim.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
from pathlib import Path
import re
import secrets
import shutil
import subprocess  # nosec B404 -- fixed executable/list argv, validated owned fixture
import time

ROOT = Path(__file__).resolve().parents[3]


def fixture_program(root: Path = ROOT) -> str:
    text = (root / 'tests/database/explicit-data-flow-declarations.test.sql').read_text()
    marker = '-- Newer approved then withdrawn revision never revives older approval.'
    if text.count(marker) != 1 or text.count('\nbegin;\n') != 1:
        raise ValueError('Reviewed declaration fixture boundary changed')
    text = text[:text.index(marker)]
    text = text.replace('\nbegin;\n', '\nbegin;\ncreate schema flow174_race;\ngrant usage on schema flow174_race to service_role,human_action_writer;\n', 1)
    text = text.replace('pg_temp.', 'flow174_race.').replace('create temporary table ', 'create table ')
    return text + "\ninsert into flow174_saved values('race',jsonb_build_object('text',flow174_race.declare174(203,flow174_race.id(201))));\nupdate flow174_saved set v=v||jsonb_build_object('challenge',flow174_race.mfa174(v->>'text',1))where k='race';\ncommit;\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--container', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--database', choices=['axiom_policy_test'], required=True)
    args = parser.parse_args()
    if Path.cwd().resolve() != ROOT:
        raise ValueError('Owned source root required')
    docker = shutil.which('docker')
    if not docker or not re.fullmatch(r'[a-f0-9]{64}', args.container) or not re.fullmatch(r'sha256:[a-f0-9]{64}', args.image):
        raise ValueError('Exact owned CID and immutable image required')
    spec = importlib.util.spec_from_file_location('flow174_owned_fixture', ROOT / 'tests/database/lib/preprovision-local-custody-verifier.py')
    if spec is None or spec.loader is None:
        raise ValueError('Owned fixture guard unavailable')
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)

    def owned():
        return guard.inspect(docker, args.container, ROOT, args.image)

    def command(argv: list[str], data: str | None = None, *, timeout: int = 30) -> str:
        owned()
        result = subprocess.run([docker, 'exec', '-i', args.container, *argv], input=data, text=True, capture_output=True, timeout=timeout)  # nosec B603 -- owned fixed executables/argv
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)
        return result.stdout.strip()

    def sql(database: str, text: str) -> str:
        return command(['psql', '-X', '-U', 'supabase_admin', '-d', database, '-Atq', '-v', 'ON_ERROR_STOP=1'], text)

    def statement(kind: str, label: str) -> str:
        record = "select public.record_data_flow_declaration(flow174_race.id(11),flow174_race.id(1),flow174_race.id(101),(select v->>'text'from flow174_saved where k='race'),(select(v->>'challenge')::uuid from flow174_saved where k='race'));"
        fence = "select public.fence_data_flow_declaration(flow174_race.id(11),flow174_race.id(1),flow174_race.id(101),(select v->>'text'from flow174_saved where k='race'));"
        source = "update public.estate_systems set version=version+1 where id=flow174_race.id(31);"
        other = "select public.record_data_flow_declaration(flow174_race.id(11),flow174_race.id(1),flow174_race.id(101),(select v->>'text'from flow174_saved where k='other'),(select(v->>'challenge')::uuid from flow174_saved where k='other'));"
        mutation = {'record': record, 'fence': fence, 'source': source, 'other': other}[kind]
        role = '' if kind == 'source' else 'set local role human_action_writer;'
        return f"begin;set local application_name='{label}';{role}{mutation}"

    results = []
    cases = [('fence', 'record', False), ('record', 'fence', True), ('source', 'record', False), ('record', 'source', True), ('record', 'other', True)]
    for index, (first, second, recorded) in enumerate(cases):
        database = 'axiom_proof_local_flow174_' + secrets.token_hex(6)
        created = False
        processes: list[subprocess.Popen[str]] = []
        try:
            command(['createdb', '-U', 'postgres', '-T', args.database, database])
            created = True
            sql(database, fixture_program())
            if second == 'other':
                sql(database, "begin;insert into flow174_saved values('other',jsonb_build_object('text',flow174_race.declare174(204,flow174_race.id(201))));update flow174_saved set v=v||jsonb_build_object('challenge',flow174_race.mfa174(v->>'text',1))where k='other';commit;")
            labels = [f'flow174-first-{index}', f'flow174-second-{index}']
            argv = [docker, 'exec', '-i', args.container, 'psql', '-X', '-U', 'supabase_admin', '-d', database, '-Atq', '-v', 'ON_ERROR_STOP=1']
            owned()
            a = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)  # nosec B603 -- exact owned container and synthetic child DB
            processes.append(a)
            assert a.stdin is not None and a.stdout is not None
            a.stdin.write(statement(first, labels[0]) + "select 'FLOW174_FIRST_LOCKED';\n")
            a.stdin.flush()
            # Read actual PostgreSQL idle-in-transaction acknowledgement; pipe
            # buffering is not evidence that the first SQL acquired locks.
            deadline = time.monotonic() + 15
            acknowledged = False
            while time.monotonic() < deadline:
                state = sql(database, f"select exists(select 1 from pg_stat_activity where datname=current_database()and application_name='{labels[0]}'and state='idle in transaction'and query like '%FLOW174_FIRST_LOCKED%');")
                if state == 't':
                    acknowledged = True
                    break
                if a.poll() is not None:
                    break
                time.sleep(.02)
            if not acknowledged:
                raise RuntimeError('First declaration transaction did not establish locks')
            b = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)  # nosec B603 -- exact owned container and synthetic child DB
            processes.append(b)
            assert b.stdin is not None
            b.stdin.write(statement(second, labels[1]) + 'commit;\n')
            b.stdin.close()
            b.stdin = None
            blocked = False
            for _ in range(100):
                found = sql(database, f"select exists(select 1 from pg_stat_activity a join pg_stat_activity b on a.pid=any(pg_blocking_pids(b.pid))where a.datname=current_database()and a.application_name='{labels[0]}'and b.application_name='{labels[1]}');")
                if found == 't':
                    blocked = True
                    break
                if b.poll() is not None:
                    break
                time.sleep(.02)
            if not blocked:
                raise RuntimeError('Expected actual declaration lock dependency was absent')
            a.stdin.write('commit;\n')
            a.stdin.close()
            a.stdin = None
            output_a, error_a = a.communicate(timeout=10)
            output_b, error_b = b.communicate(timeout=10)
            if a.returncode:
                raise RuntimeError(output_a + error_a)
            should_refuse = (first, second) in [('fence', 'record'), ('source', 'record'), ('record', 'other')]
            if bool(b.returncode) != should_refuse:
                raise RuntimeError('Second outcome contradicted recorded lock order: ' + output_b + error_b)
            facts = json.loads(sql(database, "select jsonb_build_object('recorded',exists(select 1 from controller_security.flow174_revisions where id=flow174_race.id(203)),'fenced',exists(select 1 from controller_security.flow174_fences where operation_key=flow174_race.id(203)),'otherRecorded',exists(select 1 from controller_security.flow174_revisions where id=flow174_race.id(204)),'declarationCount',(select count(*)from public.audit_ledger where correlation_id=flow174_race.id(203)and action_type='data_flow.declared'),'state',case when exists(select 1 from controller_security.flow174_revisions where id=flow174_race.id(203))then controller_security.flow174_state(flow174_race.id(11),flow174_race.id(203))else null end);") )
            if facts['recorded'] != recorded or facts['otherRecorded'] or facts['declarationCount'] != int(recorded) or facts['fenced'] != (first == 'fence'):
                raise RuntimeError('Immutable declaration facts contradicted lock order')
            if (first, second) == ('record', 'source') and facts['state'] != 'stale':
                raise RuntimeError('Later source change must retain history as stale')
            results.append({'first': first, 'second': second, 'realBlockingObserved': True, 'secondRefused': should_refuse, 'facts': facts})
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=10)
            if created:
                command(['dropdb', '-U', 'postgres', '--force', database])
                if sql(args.database, f"select exists(select 1 from pg_database where datname='{database}');") != 'f':
                    raise RuntimeError('Owned declaration child database remains')
    print(json.dumps({'cases': results, 'allOwnedChildrenRemoved': True, 'syntheticAuthFactorStandins': True, 'retainedOrProviderWrites': False}))


if __name__ == '__main__':
    main()
