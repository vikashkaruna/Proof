#!/usr/bin/env python3
"""Real173 policy-revoke / execution-claim lock orders in owned disposable SQL.

Commits only synthetic fixture rows in newly created child databases. No real
TOTP, HMAC, host provisioning, provider writes or retained database is involved.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess  # nosec B404 -- fixed executable/list argv in owned fixtures
import tempfile
import time
from uuid import UUID

ROOT = Path(__file__).resolve().parents[3]


def fixture_program(root: Path = ROOT) -> str:
    pg = (root / 'tests/database/postgresql-sandbox-discovery.test.sql').read_text()
    cut = "select pg_temp.ok(pg_temp.resolve()->>'targetBinding'"
    human = (root / 'tests/database/owned-human-plans.test.sql').read_text()
    human_cut = '-- Ordinary backend, browser and target roles cannot use the human source.'
    standing = (root / 'tests/database/standing-approval-coordinator.test.sql').read_text()
    standing_cut = '-- Default legacy revoke return/actor behavior'
    if any(text.count(marker) != 1 for text, marker in [(pg, cut), (human, human_cut), (standing, standing_cut)]):
        raise ValueError('Reviewed173 fixture boundaries changed')
    program = pg[:pg.index(cut)] + '\nreset role;\n' + (root / 'tests/database/lib/owned-deployment-fixture.sql').read_text() + '\n' + human[:human.index(human_cut)] + '\nreset role;\n' + standing[:standing.index(standing_cut)]
    if program.count('\nbegin;\n') != 1:
        raise ValueError('One disposable transaction required')
    program = program.replace('\nbegin;\n', '\nbegin;\ncreate schema standing173_race;\ngrant usage on schema standing173_race to human_action_writer,service_role,agent_ledger_writer,owned_target_controller,axiom_sandbox_connector_operator;\n', 1)
    return program.replace('pg_temp.', 'standing173_race.').replace('create temporary table ', 'create table ') + '\ncommit;\n'


class Refused(RuntimeError):
    pass


def validate_fixture_inputs(container: str, image: str) -> None:
    if not re.fullmatch(r'[a-f0-9]{64}',container) or not re.fullmatch(r'sha256:[a-f0-9]{64}',image):
        raise Refused('Immutable owned fixture ID and image required')


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--container', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--database', choices=['axiom_policy_test', 'axiom_proof_local'], required=True)
    args = parser.parse_args()
    docker = shutil.which('docker')
    if not docker or Path.cwd().resolve() != ROOT:
        raise Refused('Owned fixture context unavailable')
    spec = importlib.util.spec_from_file_location('standing173_fixture_guard', ROOT / 'tests/database/lib/preprovision-local-custody-verifier.py')
    if spec is None or spec.loader is None:
        raise Refused('Fixture guard unavailable')
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    validate_fixture_inputs(args.container,args.image)
    guard.inspect(docker, args.container, ROOT, args.image)
    os.umask(0o077)
    evidence = Path(tempfile.mkdtemp(prefix='axiom-standing173-races-'))
    clients: list[subprocess.Popen[str]] = []
    databases: list[str] = []
    proof: list[dict[str, object]] = []

    def command(argv: list[str], name: str, sql: str | None = None) -> str:
        result = subprocess.run([docker, *argv], input=sql, capture_output=True, text=True, timeout=120, check=False)  # nosec B603 -- fixed Docker executable/list argv, IDs guarded
        (evidence / (name + '.log')).write_text(result.stdout + result.stderr)
        if result.returncode:
            raise Refused(name + ' failed; protected fixture evidence retained')
        return result.stdout.strip()

    def psql(database: str) -> list[str]:
        if not re.fullmatch(r'axiom_proof_local_173_[a-f0-9]{12}_(revoke|claim)', database):
            raise Refused('Owned database name refused')
        return ['exec', '-i', args.container, 'psql', '-X', '-U', 'supabase_admin', '-d', database, '-v', 'ON_ERROR_STOP=1', '-qAt']

    def query(database: str, sql: str, name: str) -> str:
        return command(psql(database), name, sql)

    def spawn(database: str, sql: str) -> subprocess.Popen[str]:
        child = subprocess.Popen([docker, *psql(database)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)  # nosec B603 -- fixed Docker/psql; owned IDs and database
        clients.append(child)
        if child.stdin is None:
            raise Refused('Fixture client unavailable')
        child.stdin.write(sql + '\n')
        child.stdin.flush()
        return child

    def wait_blocked(database: str, app: str, blocker: str, label: str) -> None:
        if app not in {'axiom173_claim', 'axiom173_revoke'} or blocker not in {'axiom173_claim', 'axiom173_revoke', 'axiom173_barrier'}:
            raise Refused('Fixed race phase required')
        # Names are fixed constants above. Metadata proves the actual dependency,
        # not merely that an unrelated advisory wait happened somewhere.
        sql = f"select exists(select 1 from pg_stat_activity waiter join pg_stat_activity holder on holder.pid=any(pg_blocking_pids(waiter.pid)) where waiter.application_name='{app}' and holder.application_name='{blocker}');"  # nosec B608 -- fixed allowlisted app constants
        for n in range(50):
            if query(database, sql, label) == 't':
                return
            time.sleep(0.05)
        raise Refused('Required173 lock dependency was not observed')

    try:
        suffix = secrets.token_hex(6)
        first = 'axiom_proof_local_173_' + suffix + '_revoke'
        second = 'axiom_proof_local_173_' + suffix + '_claim'
        command(['exec', args.container, 'createdb', '-U', 'supabase_admin', '--template', args.database, first], 'create-revoke-database')
        databases.append(first)
        query(first, fixture_program(), 'committed-synthetic-fixture')
        command(['exec', args.container, 'createdb', '-U', 'supabase_admin', '--template', first, second], 'create-claim-database')
        databases.append(second)
        for database, order in [(first, 'revoke'), (second, 'claim')]:
            data = json.loads(query(database, "select jsonb_build_object('tenant',standing173_race.pg_id(1),'policy',(select v#>>'{policy,id}'from standing173_saved where name='policy'),'plan',(select v->>'planId'from standing173_saved where name='tokenPayload'),'action',(select v#>>'{actionIds,0}'from standing173_saved where name='tokenPayload'),'token',(select v->>'tokenId'from standing173_saved where name='issued'),'owner',standing173_race.id(1));", order + '-metadata'))
            if set(data) != {'tenant', 'policy', 'plan', 'action', 'token', 'owner'}:
                raise Refused('Exact synthetic race identity required')
            data = {k: str(UUID(v)) for k, v in data.items()}
            table = 'standing_approval_policies' if order == 'revoke' else 'approval_tokens'
            condition = "new.status='revoked'" if order == 'revoke' else "new.status='consumed'"
            query(database, "create function standing173_race.pause173()returns trigger language plpgsql as $$begin if " + condition + " then perform pg_advisory_xact_lock(17373,1);end if;return new;end$$;create trigger standing173_pause before update on public." + table + " for each row execute function standing173_race.pause173();", order + '-install-barrier')
            barrier = spawn(database, "set application_name='axiom173_barrier';select pg_advisory_lock(17373,1);\n\\echo READY173")
            if barrier.stdout is None:
                raise Refused('Barrier output unavailable')
            for _ in range(4):
                if barrier.stdout.readline().strip() == 'READY173':
                    break
            else:
                raise Refused('Barrier acquisition unavailable')
            revoke = f"set application_name='axiom173_revoke';begin;set local statement_timeout='15s';set local role human_action_writer;select public.revoke_standing_policy('{data['tenant']}','{data['policy']}','{data['owner']}',gen_random_uuid());commit;"  # nosec B608 -- UUID-only owned fixture data
            claim = f"set application_name='axiom173_claim';begin;set local statement_timeout='15s';set local role service_role;select public.claim_plan_execution('{data['tenant']}','{data['plan']}','{data['token']}',array['{data['action']}'::uuid],'standing173-race',gen_random_uuid(),'{{}}');commit;"  # nosec B608 -- UUID-only owned fixture data
            holder = spawn(database, revoke if order == 'revoke' else claim)
            wait_blocked(database, 'axiom173_' + order, 'axiom173_barrier', order + '-holder-blocked')
            contender = spawn(database, claim if order == 'revoke' else revoke)
            other = 'claim' if order == 'revoke' else 'revoke'
            wait_blocked(database, 'axiom173_' + other, 'axiom173_' + order, order + '-contender-blocked')
            assert barrier.stdin is not None
            barrier.stdin.write('select pg_advisory_unlock(17373,1);\n\\q\n')
            barrier.stdin.flush()
            barrier.wait(timeout=10)
            outcomes = []
            for name, child in [('holder', holder), ('contender', contender)]:
                stdout, stderr = child.communicate(timeout=20)
                (evidence / (order + '-' + name + '.log')).write_text(stdout + stderr)
                if child.returncode:
                    raise Refused('Actual173 raced function refused')
                outcomes.append(stdout.strip())
            final = json.loads(query(database, "select jsonb_build_object('policy',(select status from public.standing_approval_policies where id='" + data['policy'] + "'),'token',(select status from public.approval_tokens where id='" + data['token'] + "'),'revokedAt',(select revoked_at is not null from public.approval_tokens where id='" + data['token'] + "'),'targetOperations',(select count(*)from owned_synthetic.operations),'outboxes',(select count(*)from public.execution_dispatch_outbox));", order + '-final'))
            expected = {'policy': 'revoked', 'token': 'revoked' if order == 'revoke' else 'consumed', 'revokedAt': order == 'revoke', 'targetOperations': 0, 'outboxes': 0 if order == 'revoke' else 1}
            if final != expected:
                raise Refused('173 race final authority mismatch')
            proof.append({'order': order + '_first', 'actualBlockingObserved': True, 'final': final})
        (evidence / 'proof.json').write_text(json.dumps({'races': proof, 'scope': 'owned_disposable_SQL_only'}, indent=2))
        print('Both173 actual plan-lock race orders passed; evidence ' + str(evidence))
    finally:
        for client in clients:
            if client.poll() is None:
                if client.stdin is not None:
                    client.stdin.close()
                try:
                    client.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    client.terminate()
                    client.wait(timeout=10)
        guard.inspect(docker, args.container, ROOT, args.image)
        for database in reversed(databases):
            command(['exec', args.container, 'dropdb', '-U', 'supabase_admin', database], 'remove-' + database)


if __name__ == '__main__':
    main()
