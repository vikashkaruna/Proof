#!/usr/bin/env bash
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
first_pid=''
second_pid=''
barrier_open=false
cleanup() {
  if [ "$barrier_open" = true ]; then
    printf 'rollback;\n\\q\n' >&3 2>/dev/null || true
    exec 3>&-
  fi
  for worker_pid in "$first_pid" "$second_pid"; do
    if [ -n "$worker_pid" ]; then kill "$worker_pid" 2>/dev/null || true; fi
  done
  rm -rf "$result_dir"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
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
enable="public.manage_connector('41410000-0000-4000-8000-0000000000f2','41410000-0000-4000-8000-0000000000f1','transition','41410000-0000-4000-8000-0000000000f6','{\"status\":\"active\",\"expectedVersion\":1}','{\"schemaVersion\":1,\"id\":\"41410000-0000-4000-8000-0000000000f5\",\"targetBinding\":\"production\",\"assurance\":\"high\"}'::jsonb,gen_random_uuid())"
race() {
  local barrier="$result_dir/first-input"
  mkfifo "$barrier"
  sql < "$barrier" > "$result_dir/first" 2>&1 &
  first_pid=$!
  exec 3> "$barrier"
  barrier_open=true
  printf "set application_name='connector-first'; begin; set local role human_action_writer; select %s;\n" "$1" >&3
  # Keep the transaction open on stdin rather than scheduling the race inside
  # a fixed sleep. It cannot commit before the actual row-lock wait is seen.
  ready=false
  local deadline=$((SECONDS + 90))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$(sql -c "select count(*) from pg_stat_activity where application_name='connector-first' and state='idle in transaction'")" = 1 ]; then ready=true; break; fi
    if ! kill -0 "$first_pid" 2>/dev/null; then break; fi
    sleep 0.05
  done
  [ "$ready" = true ] || { echo 'First connector transaction did not reach its barrier.' >&2; cat "$result_dir/first"; exit 1; }
  sql -c "set application_name='connector-second'; set role human_action_writer; select $2;" 3>&- > "$result_dir/second" 2>&1 &
  second_pid=$!
  blocked=false
  deadline=$((SECONDS + 90))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$(sql -c "select count(*) from pg_stat_activity contender where application_name='connector-second' and wait_event_type='Lock' and wait_event in ('transactionid','tuple') and exists(select 1 from pg_stat_activity holder where holder.application_name='connector-first' and holder.pid=any(pg_blocking_pids(contender.pid)))")" = 1 ]; then blocked=true; break; fi
    if ! kill -0 "$second_pid" 2>/dev/null; then break; fi
    sleep 0.05
  done
  [ "$blocked" = true ] || { echo 'Connector contender did not wait for the held row lock.' >&2; cat "$result_dir/second"; exit 1; }
  printf 'commit;\n\\q\n' >&3
  exec 3>&-
  barrier_open=false
  wait "$first_pid"; first_pid=''
  wait "$second_pid"; second_pid=''
  rm "$barrier"
  grep -q "$3" "$result_dir/second" || { echo "Expected connector refusal: $3" >&2; cat "$result_dir/second"; exit 1; }
}
race "$archive" "$enable" parent_archived
[ "$(sql -c "select status from public.connectors where id='41410000-0000-4000-8000-0000000000f6'")" = draft ]
# Reset only this disposable fixture to exercise the opposite lock ordering.
sql -c "update public.estates set status='active',version=1 where id='41410000-0000-4000-8000-0000000000f3';"
race "$enable" "$archive" active_connectors
[ "$(sql -c "select status from public.estates where id='41410000-0000-4000-8000-0000000000f3'")" = active ]
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id='41410000-0000-4000-8000-0000000000f2' and action_type='connector.updated'")" = 1 ]
echo 'Concurrent connector enable/estate archive: both lock orderings serialize; conflicting operation refused.'
