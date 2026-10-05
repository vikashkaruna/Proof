#!/usr/bin/env bash
# Real lock contention on synthetic disposable fixtures only.
set -euo pipefail
container="${1:?Disposable test container required}"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
source tests/database/lib/concurrency-barrier.sh
python3 - <<'PY' | sql
from pathlib import Path
source = Path('tests/database/operator-workflows.test.sql').read_text()
source = source[source.index('create function pg_temp.id'):source.index('create temporary table workflow_fixture')]
source = source.replace('pg_temp.', 'operator_race.').replace('99111100-', '99112100-').replace('operator-workflow-', 'operator-race-').replace('operator-workflows-', 'operator-races-')
print('create schema operator_race; grant usage on schema operator_race to human_action_writer;')
print(source)
PY
race() { race_run "$1" "$2" "$result_dir/first" "$result_dir/second"; }
same="select operator_race.record('delivery_task',operator_race.task(),201)"
race "$same" "$same"
grep -Fq '"replayed": false' "$result_dir/first"
grep -Fq '"replayed": true' "$result_dir/second"
[ "$(sql -c 'select count(*) from public.operator_workflow_records where tenant_id=operator_race.id(11)')" = 1 ]
race "$same" "select operator_race.record('delivery_task',operator_race.task(16,3),201)"
grep -Fq 'idempotency_conflict' "$result_dir/second"
race "update public.tenant_users set role='viewer' where tenant_id=operator_race.id(11) and user_id=operator_race.id(1)" "$same"
grep -Fq 'forbidden' "$result_dir/second"
sql -c "update public.tenant_users set role='owner' where tenant_id=operator_race.id(11) and user_id=operator_race.id(1);"
sql -c "select operator_race.record('policy_draft',operator_race.policy(),202);" > "$result_dir/draft"
review="jsonb_build_object('draftId',(select id from public.policy_drafts where tenant_id=operator_race.id(11)),'expectedHash',(select content_sha256 from public.policy_drafts where tenant_id=operator_race.id(11)),'decision','approved','reason','Synthetic founder concurrency review; no publication')"
race "select operator_race.record('policy_review',$review,203,2)" "select operator_race.record('policy_review',$review,204,2)"
grep -Fq '"replayed": false' "$result_dir/first"
grep -Fq 'invalid_draft_state' "$result_dir/second"
[ "$(sql -c "select count(*) from public.operator_workflow_records where tenant_id=operator_race.id(11) and kind='policy_review'")" = 1 ]
fresh="select operator_race.record('delivery_task',operator_race.task(),205)"
race "update public.engagements set status='cancelled' where id=operator_race.id(31)" "$fresh"
grep -Fq 'context_refused' "$result_dir/second"
sql -c "update public.engagements set status='intake' where id=operator_race.id(31);"
race "$fresh" "update public.engagements set status='cancelled' where id=operator_race.id(31)"
grep -Fq '"replayed": false' "$result_dir/first"
[ "$(sql -c "$fresh")" = '{"error": "context_refused"}' ]
# A cancel tombstone takes the same durable-operation lock as recording.
sql -c "update public.engagements set status='intake' where id=operator_race.id(31);"
cancel="select public.cancel_operator_workflow(operator_race.id(11),operator_race.id(1),operator_race.id(206),'delivery_task',operator_race.task(),gen_random_uuid())"
late="select operator_race.record('delivery_task',operator_race.task(),206)"
race "$cancel" "$late"
grep -Fq '"cancelled": true' "$result_dir/first"
grep -Fq 'operation_cancelled' "$result_dir/second"
[ "$(sql -c "select count(*) from public.operator_workflow_cancellations where tenant_id=operator_race.id(11)")" = 1 ]
cancel_saved="select public.cancel_operator_workflow(operator_race.id(11),operator_race.id(1),operator_race.id(207),'delivery_task',operator_race.task(),gen_random_uuid())"
race "select operator_race.record('delivery_task',operator_race.task(),207)" "$cancel_saved"
grep -Fq '"replayed": false' "$result_dir/first"
grep -Fq '"cancelled": false' "$result_dir/second"
[ "$(sql -c "select count(*) from public.operator_workflow_cancellations where tenant_id=operator_race.id(11)")" = 1 ]
[ "$(sql -c 'select count(*) from public.operator_workflow_records where tenant_id=operator_race.id(11)')" = 5 ]
[ "$(sql -c 'select count(*) from public.audit_ledger where tenant_id=operator_race.id(11)')" = 6 ]
[ "$(sql -c 'select count(*) from public.verify_ledger(operator_race.id(11),1)')" = 0 ]
sql -c 'drop schema operator_race cascade' >/dev/null 2>&1
echo 'Operator workflow contention: exact replay once, changed requests and revocations refused, one terminal founder decision, cancellation/record races in both orders, intact ledger.'
