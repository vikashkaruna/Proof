#!/usr/bin/env bash
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql -c 'create schema retention_race'
sed '/-- FIXTURE_READY/,$d' tests/database/assessment-retention.test.sql | sed '/^begin;$/d;s/pg_temp/retention_race/g;s/create temporary table issued/create table retention_race.issued/g;s/from issued/from retention_race.issued/g;s/on issued/on retention_race.issued/g;s/69690000/70700000/g;s/retention-fixture/retention-race/g' | sql > "$result_dir/fixture.log"
sql -c 'grant usage on schema retention_race to service_role'
barrier() {
 for attempt in $(seq 1 80); do
  if [ "$(sql -c "select count(*) from pg_stat_activity where application_name='$1' and wait_event='PgSleep'")" = 1 ]; then return; fi
  sleep 0.05
 done
 echo 'Retention concurrency barrier not reached'; exit 1
}
# An in-flight confirmation cannot expose uncommitted completion to cleanup.
sql -c "set application_name='retention-confirm'; begin; select public.confirm_workload_assessment(retention_race.id(11),(select run_id from retention_race.issued)); update public.workload_assessment_packets set finalized_at=clock_timestamp()-interval '91 days' where tenant_id=retention_race.id(11); select pg_sleep(2); commit;" > "$result_dir/confirm" 2>&1 &
first_pid=$!
barrier retention-confirm
[ "$(sql -c "set role service_role; select retention_race.purge()->>'status'")" = idle ]
wait "$first_pid" || { cat "$result_dir/confirm"; exit 1; }
# A locked task is skipped, never deleted by another maintenance worker.
sql -c "set application_name='retention-locked'; begin; select run_id from public.workload_task_delegations where tenant_id=retention_race.id(11) for update; select pg_sleep(2); commit;" > "$result_dir/locked" 2>&1 &
first_pid=$!
barrier retention-locked
[ "$(sql -c "set role service_role; select retention_race.purge()->>'status'")" = idle ]
wait "$first_pid" || { cat "$result_dir/locked"; exit 1; }
# First purge holds its task lock through commit; second gets idle, not a duplicate receipt.
sql -c "set application_name='retention-first'; begin; set local role service_role; select retention_race.purge(); select pg_sleep(2); commit;" > "$result_dir/first" 2>&1 &
first_pid=$!
barrier retention-first
[ "$(sql -c "set role service_role; select retention_race.purge()->>'status'")" = idle ]
wait "$first_pid" || { cat "$result_dir/first"; exit 1; }
sql <<'SQL'
select retention_race.ok((select count(*)=1 from public.audit_ledger where tenant_id=retention_race.id(11) and action_type='workload.dispatch_payload_purged'),'concurrent cleanup emits one receipt');
select retention_race.ok((select ciphertext is null and payload_purge_receipt is not null from public.assessment_dispatch_jobs where tenant_id=retention_race.id(11)),'cleanup committed once');
SQL
sql -c 'drop schema retention_race cascade' >/dev/null 2>&1
echo 'Retention concurrency: confirmation visibility, busy task skipping and single receipt verified.'
