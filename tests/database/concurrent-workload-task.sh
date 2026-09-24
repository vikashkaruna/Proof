#!/usr/bin/env bash
# Real lock contention in the disposable database only; no bearer material.
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql <<'SQL'
create schema task_race;
create function task_race.id(n int) returns uuid language sql immutable as $$select ('48480000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
insert into auth.users(id,email) values(task_race.id(1),'task-race@test.invalid');
insert into public.users(id,email) values(task_race.id(1),'task-race@test.invalid');
insert into public.tenants(id,slug,name) values(task_race.id(11),'task-race','Task race');
insert into public.tenant_users(tenant_id,user_id,role) values(task_race.id(11),task_race.id(1),'owner');
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id) values(task_race.id(21),task_race.id(11),'drishti','spiffe://test/task-race/drishti');
update public.workload_identities set status='active' where id=task_race.id(21);
create function task_race.issue() returns jsonb language sql as $$select public.delegate_workload_task(task_race.id(11),task_race.id(1),task_race.id(21),'drishti',null,null,task_race.id(31),repeat('b',64),repeat('a',64),array['connector.read'],clock_timestamp()+interval '5 minutes')$$;
create function task_race.revoke() returns jsonb language sql as $$select public.revoke_workload_task(task_race.id(11),task_race.id(1),(select id from public.agent_runs where tenant_id=task_race.id(11)),task_race.id(31))$$;
grant usage on schema task_race to service_role;
grant execute on all functions in schema task_race to service_role;
SQL
barrier() {
  local name="$1" column="$2" event="$3"
  for attempt in $(seq 1 80); do
    if [ "$(sql -c "select count(*) from pg_stat_activity where application_name='$name' and $column='$event'")" = 1 ]; then return; fi
    sleep 0.05
  done
  echo 'Task concurrency barrier not reached'; exit 1
}
race() {
 local first="$1" second="$2"
 sql -c "set application_name='task-first'; begin; $first; select pg_sleep(4); commit;" > "$result_dir/first" 2>&1 &
 local first_pid=$!
 barrier task-first wait_event PgSleep
 sql -c "set application_name='task-second'; $second;" > "$result_dir/second" 2>&1 &
 local second_pid=$!
 barrier task-second wait_event_type Lock
 wait "$first_pid" || { cat "$result_dir/first"; exit 1; }
 wait "$second_pid" || { cat "$result_dir/second"; exit 1; }
}
# Demotion holds the membership lock first: issuance must re-check after waiting.
race "update public.tenant_users set role='viewer' where user_id=task_race.id(1)" "set role service_role; select task_race.issue()"
grep -q forbidden "$result_dir/second"
[ "$(sql -c 'select count(*) from public.agent_runs where tenant_id=task_race.id(11)')" = 0 ]
sql -c "update public.tenant_users set role='owner' where user_id=task_race.id(1)"
# Issuance holds the lock first: the later demotion invalidates its proof.
race "set local role service_role; select task_race.issue()" "update public.tenant_users set role='viewer' where user_id=task_race.id(1)"
[ "$(sql -c "select public.read_workload_task(task_race.id(11),(select id from public.agent_runs where tenant_id=task_race.id(11)),task_race.id(21),'drishti',repeat('a',64),'connector.read') is null")" = t ]
sql -c "update public.tenant_users set role='owner' where user_id=task_race.id(1)"
race "set local role service_role; select task_race.revoke()" "set role service_role; select task_race.revoke()"
grep -q '"revoked": true' "$result_dir/second"
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id=task_race.id(11) and action_type='workload.task_revoked'")" = 1 ]
sql -c 'drop schema task_race cascade' >/dev/null 2>&1
echo 'Concurrent tasks: both issuance/demotion orderings refuse stale authority; competing revocations append one event.'
