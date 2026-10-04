#!/usr/bin/env bash
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
source tests/database/lib/concurrency-barrier.sh
sql -c 'create schema scheduling_race'
sed '/set local role service_role/,$d' tests/database/assessment-scheduling.test.sql | sed '/^begin;$/d;s/pg_temp/scheduling_race/g' | sql
sql -c 'grant usage on schema scheduling_race to service_role; grant execute on all functions in schema scheduling_race to service_role; set role service_role; select scheduling_race.enqueue()' > /dev/null
race_run "set local role service_role; select scheduling_race.reserve()" "set role service_role; select jsonb_array_length(scheduling_race.reserve()->'jobs')" "$result_dir/first" "$result_dir/reserve-probe" nonblocking success 0
[ "$(cat "$result_dir/reserve-probe")" = 0 ]
[ "$(sql -c 'select scheduling_attempts from public.assessment_dispatch_jobs where id=scheduling_race.id(51)')" = 1 ]
sql <<'SQL'
create function scheduling_race.ticket() returns jsonb language sql as $$select jsonb_build_object('tenantId',tenant_id,'jobId',id,'leaseId',scheduling_lease_id,'namespace',workflow_namespace,'workflowId','assessment-'||tenant_id::text||'-'||id::text) from public.assessment_dispatch_jobs where id=scheduling_race.id(51)$$;
create table scheduling_race.original as select scheduling_race.ticket() value;
grant select on scheduling_race.original to service_role;
update public.assessment_dispatch_jobs set scheduling_lease_until=clock_timestamp()-interval '1 second',scheduling_next_at=clock_timestamp()-interval '1 second' where id=scheduling_race.id(51);
SQL
race() {
 race_run "$1" "$2" "$result_dir/first" "$result_dir/second"
}
race 'set local role service_role; select scheduling_race.reserve()' 'set role service_role; select scheduling_race.ack((select value from scheduling_race.original))'
grep -q scheduling_refused "$result_dir/second"
[ "$(sql -c "select scheduling_status from public.assessment_dispatch_jobs where id=scheduling_race.id(51)")" = pending ]
race 'set local role service_role; select scheduling_race.ack(scheduling_race.ticket())' 'set role service_role; select scheduling_race.ack(scheduling_race.ticket())'
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id=scheduling_race.id(11) and action_type='workload.dispatch_scheduled'")" = 1 ]
[ "$(sql -c "select scheduling_status from public.assessment_dispatch_jobs where id=scheduling_race.id(51)")" = submitted ]
sql -c 'drop schema scheduling_race cascade' > /dev/null 2>&1
echo 'Concurrent scheduling: skip locked reservation, stale producer fencing, one acknowledged receipt.'
