#!/usr/bin/env bash
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql -c 'create schema scheduling_race'
sed '/set local role service_role/,$d' tests/database/assessment-scheduling.test.sql | sed '/^begin;$/d;s/pg_temp/scheduling_race/g' | sql
sql -c 'grant usage on schema scheduling_race to service_role; grant execute on all functions in schema scheduling_race to service_role; set role service_role; select scheduling_race.enqueue()' > /dev/null
barrier() {
 for attempt in $(seq 1 100); do
  if [ "$(sql -c "select count(*) from pg_stat_activity where application_name='$1' and $2='$3'")" = 1 ]; then return; fi
  sleep 0.05
 done
 echo 'Scheduling concurrency barrier not reached'; exit 1
}
sql -c "set application_name='schedule-first'; begin; set local role service_role; select scheduling_race.reserve(); select pg_sleep(4); commit;" > "$result_dir/first" 2>&1 &
first_pid=$!
barrier schedule-first wait_event PgSleep
[ "$(sql -c "set role service_role; select jsonb_array_length(scheduling_race.reserve()->'jobs')")" = 0 ]
wait "$first_pid" || { cat "$result_dir/first"; exit 1; }
[ "$(sql -c 'select scheduling_attempts from public.assessment_dispatch_jobs where id=scheduling_race.id(51)')" = 1 ]
sql <<'SQL'
create function scheduling_race.ticket() returns jsonb language sql as $$select jsonb_build_object('tenantId',tenant_id,'jobId',id,'leaseId',scheduling_lease_id,'namespace',workflow_namespace,'workflowId','assessment-'||tenant_id::text||'-'||id::text) from public.assessment_dispatch_jobs where id=scheduling_race.id(51)$$;
create table scheduling_race.original as select scheduling_race.ticket() value;
grant select on scheduling_race.original to service_role;
update public.assessment_dispatch_jobs set scheduling_lease_until=clock_timestamp()-interval '1 second',scheduling_next_at=clock_timestamp()-interval '1 second' where id=scheduling_race.id(51);
SQL
race() {
 sql -c "set application_name='schedule-first'; begin; $1; select pg_sleep(4); commit;" > "$result_dir/first" 2>&1 &
 local first_pid=$!
 barrier schedule-first wait_event PgSleep
 sql -c "set application_name='schedule-second'; $2;" > "$result_dir/second" 2>&1 &
 local second_pid=$!
 barrier schedule-second wait_event_type Lock
 wait "$first_pid" || { cat "$result_dir/first"; exit 1; }
 wait "$second_pid" || { cat "$result_dir/second"; exit 1; }
}
race 'set local role service_role; select scheduling_race.reserve()' 'set role service_role; select scheduling_race.ack((select value from scheduling_race.original))'
grep -q scheduling_refused "$result_dir/second"
[ "$(sql -c "select scheduling_status from public.assessment_dispatch_jobs where id=scheduling_race.id(51)")" = pending ]
race 'set local role service_role; select scheduling_race.ack(scheduling_race.ticket())' 'set role service_role; select scheduling_race.ack(scheduling_race.ticket())'
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id=scheduling_race.id(11) and action_type='workload.dispatch_scheduled'")" = 1 ]
[ "$(sql -c "select scheduling_status from public.assessment_dispatch_jobs where id=scheduling_race.id(51)")" = submitted ]
sql -c 'drop schema scheduling_race cascade' > /dev/null 2>&1
echo 'Concurrent scheduling: skip locked reservation, stale producer fencing, one acknowledged receipt.'
