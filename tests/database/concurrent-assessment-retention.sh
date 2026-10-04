#!/usr/bin/env bash
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
source tests/database/lib/concurrency-barrier.sh
sql -c 'create schema retention_race'
sed '/-- FIXTURE_READY/,$d' tests/database/assessment-retention.test.sql | sed '/^begin;$/d;s/pg_temp/retention_race/g;s/create temporary table issued/create table retention_race.issued/g;s/from issued/from retention_race.issued/g;s/on issued/on retention_race.issued/g;s/69690000/70700000/g;s/retention-fixture/retention-race/g' | sql > "$result_dir/fixture.log"
sql -c 'grant usage on schema retention_race to service_role'
# An in-flight confirmation cannot expose uncommitted completion to cleanup.
race_run "select public.confirm_workload_assessment(retention_race.id(11),(select run_id from retention_race.issued)); update public.workload_assessment_packets set finalized_at=clock_timestamp()-interval '91 days' where tenant_id=retention_race.id(11)" "set role service_role; select retention_race.purge()->>'status'" "$result_dir/confirm" "$result_dir/confirm-probe" nonblocking success idle
[ "$(cat "$result_dir/confirm-probe")" = idle ]
# A locked task is skipped, never deleted by another maintenance worker.
race_run "select run_id from public.workload_task_delegations where tenant_id=retention_race.id(11) for update" "set role service_role; select retention_race.purge()->>'status'" "$result_dir/locked" "$result_dir/locked-probe" nonblocking success idle
[ "$(cat "$result_dir/locked-probe")" = idle ]
# First purge holds its task lock through commit; second gets idle, not a duplicate receipt.
race_run "set local role service_role; select retention_race.purge()" "set role service_role; select retention_race.purge()->>'status'" "$result_dir/first" "$result_dir/first-probe" nonblocking success idle
[ "$(cat "$result_dir/first-probe")" = idle ]
sql <<'SQL'
select retention_race.ok((select count(*)=1 from public.audit_ledger where tenant_id=retention_race.id(11) and action_type='workload.dispatch_payload_purged'),'concurrent cleanup emits one receipt');
select retention_race.ok((select ciphertext is null and payload_purge_receipt is not null from public.assessment_dispatch_jobs where tenant_id=retention_race.id(11)),'cleanup committed once');
SQL
sql -c 'drop schema retention_race cascade' >/dev/null 2>&1
echo 'Retention concurrency: confirmation visibility, busy task skipping and single receipt verified.'
