#!/usr/bin/env bash
# A writer holds the row lock while issuance starts from the reviewed snapshot.
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql < tests/database/reviewed-approval-fixture.sql
for kind in content plan; do
  digest=$(sql -c "select public.action_set_content_digest('10000000-0000-0000-0000-0000000000c1','10000000-0000-0000-0000-0000000000c3',array['10000000-0000-0000-0000-0000000000d1']::uuid[])")
  if [ "$kind" = content ]; then
    edit="update public.remediation_actions set dry_run_result = '{\"changed\":true}' where id='10000000-0000-0000-0000-0000000000d1'"
    expected=content_changed
  else
    edit="update public.remediation_plans set version=2 where id='10000000-0000-0000-0000-0000000000c3'"
    expected=plan_changed
  fi
  sql -c "set application_name='approval-edit-race'; begin; $edit; select pg_sleep(3); commit;" > "$result_dir/writer" &
  writer=$!
  ready=false
  for attempt in $(seq 1 50); do
    if [ "$(sql -c "select count(*) from pg_stat_activity where application_name='approval-edit-race' and wait_event='PgSleep'")" = 1 ]; then ready=true; break; fi
    sleep 0.05
  done
  [ "$ready" = true ] || { echo 'Writer missed the race barrier'; exit 1; }
  sql -c "set application_name='approval-issuer-race'; set role service_role; select public.issue_reviewed_plan_approval(
    '10000000-0000-0000-0000-0000000000c1','10000000-0000-0000-0000-0000000000c3',
    array['10000000-0000-0000-0000-0000000000d1']::uuid[],
    '10000000-0000-0000-0000-0000000000a9','batch',1,true,'sig',
    jsonb_build_object('contentDigest','$digest'),'race-$kind',now()+interval '1 hour',
    null,'{}',null,'$digest',null,gen_random_uuid(),1)->>'decision';" > "$result_dir/issuer" &
  issuer=$!
  blocked=false
  for attempt in $(seq 1 30); do
    if [ "$(sql -c "select count(*) from pg_stat_activity where application_name='approval-issuer-race' and wait_event_type='Lock'")" = 1 ]; then blocked=true; break; fi
    sleep 0.05
  done
  [ "$blocked" = true ] || { echo 'Issuance did not contend on the writer lock'; exit 1; }
  wait "$writer"
  wait "$issuer"
  [ "$(cat "$result_dir/issuer")" = "$expected" ] || { cat "$result_dir/issuer"; exit 1; }
done
[ "$(sql -c "select count(*) from public.approval_tokens where tenant_id='10000000-0000-0000-0000-0000000000c1'")" = 0 ]
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id='10000000-0000-0000-0000-0000000000c1'")" = 0 ]
echo 'Concurrent approval: changed content and revision refused after waiting for writer locks.'
