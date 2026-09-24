#!/usr/bin/env bash
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql <<'SQL'
insert into auth.users(id,email) values ('41410000-0000-4000-8000-0000000000f1','connector-race@test.invalid');
insert into public.users(id,email) values ('41410000-0000-4000-8000-0000000000f1','connector-race@test.invalid');
insert into public.tenants(id,slug,name) values ('41410000-0000-4000-8000-0000000000f2','connector-race','Connector race');
insert into public.tenant_users(tenant_id,user_id,role) values ('41410000-0000-4000-8000-0000000000f2','41410000-0000-4000-8000-0000000000f1','owner');
insert into public.estates(id,tenant_id,slug,name) values ('41410000-0000-4000-8000-0000000000f3','41410000-0000-4000-8000-0000000000f2','race','Race');
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) values ('41410000-0000-4000-8000-0000000000f4','41410000-0000-4000-8000-0000000000f2','41410000-0000-4000-8000-0000000000f3','Race','database');
insert into public.connector_descriptors(id,slug,version,transport,target_binding,manifest) values ('41410000-0000-4000-8000-0000000000f5','race','1.0.0','sql','production','{"schemaVersion":1,"id":"41410000-0000-4000-8000-0000000000f5","targetBinding":"production","assurance":"high"}');
insert into public.connectors(id,tenant_id,system_id,descriptor_id,target_binding,name,endpoint_ref,assurance) values ('41410000-0000-4000-8000-0000000000f6','41410000-0000-4000-8000-0000000000f2','41410000-0000-4000-8000-0000000000f4','41410000-0000-4000-8000-0000000000f5','production','Race','race','high');
SQL
archive="public.manage_estate('41410000-0000-4000-8000-0000000000f2','41410000-0000-4000-8000-0000000000f1','estate.update','41410000-0000-4000-8000-0000000000f3','{\"name\":\"Race\",\"status\":\"archived\",\"expectedVersion\":1}',gen_random_uuid())"
enable="public.manage_connector('41410000-0000-4000-8000-0000000000f2','41410000-0000-4000-8000-0000000000f1','transition','41410000-0000-4000-8000-0000000000f6','{\"status\":\"active\",\"expectedVersion\":1}',(select manifest from public.connector_descriptors where id='41410000-0000-4000-8000-0000000000f5'),gen_random_uuid())"
race() {
  sql -c "set application_name='connector-first'; begin; set local role service_role; select $1; select pg_sleep(3); commit;" > "$result_dir/first" 2>&1 &
  first_pid=$!
  ready=false
  for attempt in $(seq 1 50); do
    if [ "$(sql -c "select count(*) from pg_stat_activity where application_name='connector-first' and wait_event='PgSleep'")" = 1 ]; then ready=true; break; fi
    sleep 0.05
  done
  [ "$ready" = true ] || { cat "$result_dir/first"; exit 1; }
  sql -c "set application_name='connector-second'; set role service_role; select $2;" > "$result_dir/second" 2>&1 &
  second_pid=$!
  blocked=false
  for attempt in $(seq 1 30); do
    if [ "$(sql -c "select count(*) from pg_stat_activity where application_name='connector-second' and wait_event_type='Lock'")" = 1 ]; then blocked=true; break; fi
    sleep 0.05
  done
  [ "$blocked" = true ] || { cat "$result_dir/second"; exit 1; }
  wait "$first_pid"; wait "$second_pid"
  grep -q "$3" "$result_dir/second"
}
race "$archive" "$enable" parent_archived
[ "$(sql -c "select status from public.connectors where id='41410000-0000-4000-8000-0000000000f6'")" = draft ]
# Reset only this disposable fixture to exercise the opposite lock ordering.
sql -c "update public.estates set status='active',version=1 where id='41410000-0000-4000-8000-0000000000f3';"
race "$enable" "$archive" active_connectors
[ "$(sql -c "select status from public.estates where id='41410000-0000-4000-8000-0000000000f3'")" = active ]
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id='41410000-0000-4000-8000-0000000000f2' and action_type='connector.updated'")" = 1 ]
echo 'Concurrent connector enable/estate archive: both lock orderings serialize; conflicting operation refused.'
