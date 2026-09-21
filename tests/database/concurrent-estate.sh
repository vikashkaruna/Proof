#!/usr/bin/env bash
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql <<'SQL'
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000000f1','estate-race@test.invalid');
insert into public.users(id,email) values ('00000000-0000-4000-8000-0000000000f1','estate-race@test.invalid');
insert into public.tenants(id,slug,name) values ('00000000-0000-4000-8000-0000000000f2','estate-race','Estate race');
insert into public.tenant_users(tenant_id,user_id,role) values ('00000000-0000-4000-8000-0000000000f2','00000000-0000-4000-8000-0000000000f1','owner');
insert into public.estates(id,tenant_id,slug,name) values ('00000000-0000-4000-8000-0000000000f3','00000000-0000-4000-8000-0000000000f2','race','Race');
SQL
manage="public.manage_estate('00000000-0000-4000-8000-0000000000f2','00000000-0000-4000-8000-0000000000f1','estate.update','00000000-0000-4000-8000-0000000000f3','{\"name\":\"Changed\",\"status\":\"active\",\"expectedVersion\":1}',gen_random_uuid())"
sql -c "set application_name='estate-first'; begin; set local role service_role; select $manage; select pg_sleep(3); commit;" > "$result_dir/first" 2>&1 &
first_pid=$!
ready=false
for attempt in $(seq 1 50); do
  if [ "$(sql -c "select count(*) from pg_stat_activity where application_name='estate-first' and wait_event='PgSleep'")" = 1 ]; then ready=true; break; fi
  sleep 0.05
done
[ "$ready" = true ] || { echo 'Estate race missed barrier'; exit 1; }
sql -c "set application_name='estate-second'; set role service_role; select $manage;" > "$result_dir/second" 2>&1 &
second_pid=$!
blocked=false
for attempt in $(seq 1 30); do
  if [ "$(sql -c "select count(*) from pg_stat_activity where application_name='estate-second' and wait_event_type='Lock'")" = 1 ]; then blocked=true; break; fi
  sleep 0.05
done
[ "$blocked" = true ] || { echo 'Estate race did not contend'; cat "$result_dir/second"; exit 1; }
wait "$first_pid"
wait "$second_pid"
grep -q 'version_conflict' "$result_dir/second"
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id='00000000-0000-4000-8000-0000000000f2' and action_type='estate.updated'")" = 1 ]
[ "$(sql -c "select version from public.estates where id='00000000-0000-4000-8000-0000000000f3'")" = 2 ]
echo 'Concurrent estate edits: one update/audit event; stale contender refused after waiting.'
