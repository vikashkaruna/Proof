#!/usr/bin/env bash
# Every case owns fresh fixture identities; ledger/token history is never reset.
set -euo pipefail
container="${1:?disposable database container required}"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
source tests/database/lib/concurrency-barrier.sh
case_number=0
seed_case() {
  case_number=$((case_number+1))
  prefix=$(printf '%08d' "$((13000000+case_number))")
  sed -e "s/10000000/$prefix/g" -e "s/test-appr/factor-race-$prefix/g" -e "s/appr-a/factor-race-$prefix/g" -e "s/reviewed-race/factor-race-$prefix/g" tests/database/reviewed-approval-fixture.sql | sql
  actor="$prefix-0000-0000-0000-0000000000a9"
  tenant="$prefix-0000-0000-0000-0000000000c1"
  plan="$prefix-0000-0000-0000-0000000000c3"
  action="$prefix-0000-0000-0000-0000000000d1"
  factor="$prefix-0000-0000-0000-0000000000e1"
  replacement="$prefix-0000-0000-0000-0000000000e2"
  challenge="$prefix-0000-0000-0000-0000000000f1"
  enrollment="$prefix-0000-0000-0000-0000000000f2"
  sql -c "insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted,replaces_factor_id) values('$replacement','$actor','totp','pending','fixture-replacement','$factor');
    insert into public.mfa_challenges(id,user_id,factor_id,purpose,bound_resource_ref,expires_at,satisfied_at,consumed_at,satisfied_with) values('$enrollment','$actor','$factor','enrolment','$factor',clock_timestamp()+interval '5 minutes',clock_timestamp(),clock_timestamp(),'totp');
    update public.user_mfa_factors set replacement_challenge_id='$enrollment' where id='$replacement';"
  digest=$(sql -c "select public.action_set_content_digest('$tenant','$plan',array['$action']::uuid[])")
  issue="select public.issue_reviewed_plan_approval('$tenant','$plan',array['$action']::uuid[],'$actor','batch',1,true,'signature-fixture',jsonb_build_object('contentDigest','$digest'),'factor-race-$prefix',clock_timestamp()+interval '1 hour',null,'{}','$challenge','$digest',jsonb_build_object('mfa',jsonb_build_object('challengeId','$challenge','satisfiedAt',(select satisfied_at from public.mfa_challenges where id='$challenge'),'binding',repeat('a',64))),gen_random_uuid(),1)->>'decision'"
}
for mutation in replacement revocation; do
  for ordering in mutation-first issuance-first; do
    seed_case
    if [ "$mutation" = replacement ]; then
      change="select public.finalize_totp_enrolment('$actor','$replacement',42,(select array_agg('scrypt$'||md5(i::text)||'$'||repeat(md5(i::text),2)) from generate_series(1,10)i))"
    else
      change="select public.revoke_totp_factor('$actor','$factor')"
    fi
    if [ "$ordering" = mutation-first ]; then before="$change"; after="$issue"; else before="$issue"; after="$change"; fi
    race_run "set local role service_role; $before" "set role service_role; $after" "$result_dir/first" "$result_dir/second"
    if [ "$ordering" = mutation-first ]; then
      [ "$(cat "$result_dir/second")" = fresh_mfa_required ]
      [ "$(sql -c "select count(*) from public.approval_tokens where tenant_id='$tenant'")" = 0 ]
    else
      [ "$(cat "$result_dir/first")" = issued ]
      [ "$(sql -c "select count(*) from public.approval_tokens where tenant_id='$tenant' and status='issued' and expires_at>clock_timestamp()")" = 1 ]
    fi
  done
done
for lock_kind in user plan; do
  seed_case
  sql -c "update public.mfa_challenges set expires_at=clock_timestamp()+interval '3 seconds' where id='$challenge';"
  if [ "$lock_kind" = user ]; then hold="select 1 from public.users where id='$actor' for no key update"; else hold="select 1 from public.remediation_plans where id='$plan' for update"; fi
  contender="select 'RACE_DEADLINE='||expires_at::text from public.mfa_challenges where id='$challenge'; set role service_role; $issue"
  race_run "$hold" "$contender" "$result_dir/first" "$result_dir/second" expires
  [ "$(tail -n 1 "$result_dir/second")" = fresh_mfa_required ]
  [ "$(sql -c "select count(*) from public.approval_tokens where tenant_id='$tenant'")" = 0 ]
done
echo 'Approval factor races: replacement/revocation serialize in both orders; expiry after user/plan waits refuses; existing issued tokens stay issued.'
