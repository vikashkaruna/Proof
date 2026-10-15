#!/usr/bin/env bash
# A writer holds the row lock while issuance starts from the reviewed snapshot.
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
source tests/database/lib/concurrency-barrier.sh
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
  race_run "$edit" "set role service_role; select public.issue_reviewed_plan_approval(
    '10000000-0000-0000-0000-0000000000c1','10000000-0000-0000-0000-0000000000c3',
    array['10000000-0000-0000-0000-0000000000d1']::uuid[],
    '10000000-0000-0000-0000-0000000000a9','batch',1,true,'sig',
    jsonb_build_object('contentDigest','$digest'),'race-$kind',now()+interval '1 hour',
    null,'{}','10000000-0000-0000-0000-0000000000f1','$digest',
    jsonb_build_object('mfa',jsonb_build_object('challengeId','10000000-0000-0000-0000-0000000000f1','satisfiedAt',(select satisfied_at from public.mfa_challenges where id='10000000-0000-0000-0000-0000000000f1'),'binding',repeat('a',64))),gen_random_uuid(),1)->>'decision'" "$result_dir/writer" "$result_dir/issuer"
  [ "$(cat "$result_dir/issuer")" = "$expected" ] || { cat "$result_dir/issuer"; exit 1; }
done
[ "$(sql -c "select count(*) from public.approval_tokens where tenant_id='10000000-0000-0000-0000-0000000000c1'")" = 0 ]
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id='10000000-0000-0000-0000-0000000000c1'")" = 0 ]
echo 'Concurrent approval: changed content and revision refused after waiting for writer locks.'
