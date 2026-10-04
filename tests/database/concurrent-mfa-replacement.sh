#!/usr/bin/env bash
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
source tests/database/lib/concurrency-barrier.sh
sql <<'SQL'
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000000d1','mfa-replacement-race@test.invalid');
insert into public.users(id,email) values ('00000000-0000-4000-8000-0000000000d1','mfa-replacement-race@test.invalid');
insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted) values
 ('00000000-0000-4000-8000-0000000000d2','00000000-0000-4000-8000-0000000000d1','totp','active','sealed');
insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted,replaces_factor_id) values
 ('00000000-0000-4000-8000-0000000000d3','00000000-0000-4000-8000-0000000000d1','totp','pending','sealed-new','00000000-0000-4000-8000-0000000000d2');
insert into public.mfa_challenges(id,user_id,factor_id,purpose,bound_resource_ref,expires_at,satisfied_at,consumed_at,satisfied_with) values
 ('00000000-0000-4000-8000-0000000000d4','00000000-0000-4000-8000-0000000000d1','00000000-0000-4000-8000-0000000000d2','enrolment','00000000-0000-4000-8000-0000000000d2',now()+interval '5 minutes',now(),now(),'recovery_code');
update public.user_mfa_factors set replacement_challenge_id='00000000-0000-4000-8000-0000000000d4' where id='00000000-0000-4000-8000-0000000000d3';
SQL
revoke="select public.finalize_totp_enrolment('00000000-0000-4000-8000-0000000000d1','00000000-0000-4000-8000-0000000000d3',42,(select array_agg('scrypt$'||md5(i::text)||'$'||repeat(md5(i::text),2)) from generate_series(1,10) i))"
attest="insert into public.mfa_session_attestations(user_id,session_id,factor_id,expires_at) values ('00000000-0000-4000-8000-0000000000d1','racing-session','00000000-0000-4000-8000-0000000000d2',now()+interval '1 hour')"
for first in revoke attest; do
  sql -c "update public.user_mfa_factors set status='pending' where id='00000000-0000-4000-8000-0000000000d3'; update public.user_mfa_factors set status='active',revoked_at=null where id='00000000-0000-4000-8000-0000000000d2'; delete from public.mfa_session_attestations where session_id='racing-session';"
  if [ "$first" = revoke ]; then before="$revoke"; after="$attest"; else before="$attest"; after="$revoke"; fi
  expectation=success
  if [ "$first" = revoke ]; then expectation=error; fi
  race_run "set local role service_role; $before" "set role service_role; $after" "$result_dir/first" "$result_dir/second" blocked "$expectation"
  if [ "$first" = revoke ]; then
    [ "$race_second_status" != 0 ] || { echo 'Late attestation was accepted'; exit 1; }
    grep -q 'MFA session requires an active factor' "$result_dir/second"
  fi
  [ "$(sql -c "select count(*) from public.mfa_session_attestations where session_id='racing-session' and revoked_at is null")" = 0 ]
done
echo 'Concurrent MFA: either ordering of login and recovery replacement leaves no live attestation.'
