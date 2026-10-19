#!/usr/bin/env python3
"""Actual same-key branded replay and legacy/new request races in owned SQL.

Only disposable synthetic finalized assessments and privileged fixture actors;
product writer ACLs are checked by the independent lifecycle suites.
No retained database, real Auth, account, provider or business report effects.
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
    text = (root / 'tests/database/branded-board-lifecycle.test.sql').read_text()
    marker = 'reset role; -- privileged fixture'
    if text.count(marker) != 1 or text.count('\nbegin;\n') != 1:
        raise ValueError('Reviewed branded fixture boundary changed')
    text = text[:text.index(marker)]
    text = text.replace('\nbegin;\n', '\nbegin;\ncreate schema brand177_race;\n', 1)
    text = text.replace('pg_temp.', 'brand177_race.').replace('create temporary table ', 'create table ')
    return text + "\nselect public.confirm_workload_assessment('99750000-0000-4000-8000-000000000010',(select run_id from board_issued));\ncommit;\n"


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
    spec = importlib.util.spec_from_file_location('brand177_owned_fixture', ROOT / 'tests/database/lib/preprovision-local-custody-verifier.py')
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
        function = {'brand': 'request_branded_board_report', 'legacy': 'request_board_report'}[kind]
        return f"begin;set local application_name='{label}';select public.{function}('99750000-0000-4000-8000-000000000010','99750000-0000-4000-8000-000000000001','77717700-0000-4000-8000-000000000001','99750000-0000-4000-8000-000000000030',(select run_id from board_issued),'Same original request',gen_random_uuid());"

    results = []
    cases = [('brand', 'brand', True), ('legacy', 'brand', False), ('brand', 'legacy', True)]
    for index, (first, second, recorded) in enumerate(cases):
        database = 'axiom_proof_local_brand177_' + secrets.token_hex(6)
        created = False
        processes: list[subprocess.Popen[str]] = []
        try:
            command(['createdb', '-U', 'postgres', '-T', args.database, database])
            created = True
            sql(database, fixture_program())
            labels = [f'brand177-first-{index}', f'brand177-second-{index}']
            argv = [docker, 'exec', '-i', args.container, 'psql', '-X', '-U', 'supabase_admin', '-d', database, '-Atq', '-v', 'ON_ERROR_STOP=1']
            owned()
            a = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)  # nosec B603 -- exact owned container and synthetic child DB
            processes.append(a)
            assert a.stdin is not None and a.stdout is not None
            a.stdin.write(statement(first, labels[0]) + "select 'BRAND177_FIRST_LOCKED';\n")
            a.stdin.flush()
            # Read actual PostgreSQL idle-in-transaction acknowledgement; pipe
            # buffering is not evidence that the first SQL acquired locks.
            deadline = time.monotonic() + 15
            acknowledged = False
            while time.monotonic() < deadline:
                state = sql(database, f"select exists(select 1 from pg_stat_activity where datname=current_database()and application_name='{labels[0]}'and state='idle in transaction'and query like '%BRAND177_FIRST_LOCKED%');")
                if state == 't':
                    acknowledged = True
                    break
                if a.poll() is not None:
                    break
                time.sleep(.02)
            if not acknowledged:
                raise RuntimeError('First request transaction did not establish locks')
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
                raise RuntimeError('Expected actual request advisory lock dependency was absent')
            a.stdin.write('commit;\n')
            a.stdin.close()
            a.stdin = None
            output_a, error_a = a.communicate(timeout=10)
            output_b, error_b = b.communicate(timeout=10)
            if a.returncode:
                raise RuntimeError(output_a + error_a)
            if b.returncode:
                raise RuntimeError(output_b + error_b)
            replies=[json.loads(line) for line in output_b.splitlines() if line.startswith('{')]
            if len(replies)!=1 or ((replies[0].get('error')=='idempotency_conflict') != (first=='legacy' and second=='brand')):
                raise RuntimeError('Replay/legacy conflict contradicted original request order')
            facts=json.loads(sql(database,"select jsonb_build_object('requests',(select count(*)from public.board_report_requests where tenant_id='99750000-0000-4000-8000-000000000010'),'sources',(select count(*)from public.board_request_sources where tenant_id='99750000-0000-4000-8000-000000000010'),'version',(select source_text::jsonb->'schema_version'from public.board_request_sources where tenant_id='99750000-0000-4000-8000-000000000010'),'ledger',(select count(*)from public.audit_ledger where tenant_id='99750000-0000-4000-8000-000000000010' and action_type='report.requested'))"))
            if facts!={'requests':1,'sources':1,'version':6 if first=='brand' else 5,'ledger':1}:
                raise RuntimeError('Concurrent original request duplicated or changed source/ledger')
            results.append({'first': first, 'second': second, 'realBlockingObserved': True, 'facts': facts})
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=10)
            if created:
                command(['dropdb', '-U', 'postgres', '--force', database])
                if sql(args.database, f"select exists(select 1 from pg_database where datname='{database}');") != 'f':
                    raise RuntimeError('Owned branded child database remains')
    print(json.dumps({'cases': results, 'allOwnedChildrenRemoved': True, 'syntheticAuthFactorStandins': True, 'retainedOrProviderWrites': False}))


if __name__ == '__main__':
    main()
