#!/usr/bin/env bash
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql -c 'create schema dispatch_race'
sed '/set local role service_role/,$d' tests/database/assessment-dispatch.test.sql | sed '/^begin;$/d;s/pg_temp/dispatch_race/g' | sql
sql -c 'grant usage on schema dispatch_race to service_role; grant execute on all functions in schema dispatch_race to service_role;'
barrier() {
 for attempt in $(seq 1 80); do
  if [ "$(sql -c "select count(*) from pg_stat_activity where application_name='$1' and $2='$3'")" = 1 ]; then return; fi
  sleep 0.05
 done
 echo 'Dispatch concurrency barrier not reached'; exit 1
}
race() {
 sql -c "set application_name='dispatch-first'; begin; $1; select pg_sleep(4); commit;" > "$result_dir/first" 2>&1 &
 local first_pid=$!
 barrier dispatch-first wait_event PgSleep
 sql -c "set application_name='dispatch-second'; $2;" > "$result_dir/second" 2>&1 &
 local second_pid=$!
 barrier dispatch-second wait_event_type Lock
 wait "$first_pid" || { cat "$result_dir/first"; exit 1; }
 wait "$second_pid" || { cat "$result_dir/second"; exit 1; }
}
race 'set local role service_role; select dispatch_race.enqueue()' 'set role service_role; select dispatch_race.enqueue()'
[ "$(sql -c 'select count(*) from public.agent_runs where tenant_id=dispatch_race.id(11)')" = 1 ]
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id=dispatch_race.id(11) and action_type='workload.task_delegated'")" = 1 ]
race 'set local role service_role; select public.claim_assessment_dispatch(dispatch_race.id(11),dispatch_race.id(51))' 'set role service_role; select public.claim_assessment_dispatch(dispatch_race.id(11),dispatch_race.id(51))'
grep -q dispatch_reconciliation_required "$result_dir/second"
sql -c 'set role service_role; select dispatch_race.enqueue(52)' > /dev/null
race "update public.workload_task_delegations set revoked_at=clock_timestamp() where run_id=(select run_id from public.assessment_dispatch_jobs where id=dispatch_race.id(52))" 'set role service_role; select public.claim_assessment_dispatch(dispatch_race.id(11),dispatch_race.id(52))'
grep -q dispatch_unavailable "$result_dir/second"
[ "$(sql -c 'select claimed_at is null from public.assessment_dispatch_jobs where id=dispatch_race.id(52)')" = t ]
sql -c 'drop schema dispatch_race cascade' > /dev/null 2>&1
echo 'Concurrent dispatch: one issuance/audit, one private claim, revocation wins before delivery.'
