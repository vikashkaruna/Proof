#!/usr/bin/env bash
# Hold real purpose row locks: a capture binds reviewed bytes, never a race winner.
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
source tests/database/lib/concurrency-barrier.sh
tenant='99729999-0000-4000-8000-000000000010'
owner='99729999-0000-4000-8000-000000000001'
sql <<SQL
insert into auth.users(id,email) values('$owner','consent-race@example.invalid');
insert into public.users(id,email) values('$owner','consent-race@example.invalid');
insert into public.tenants(id,slug,name) values('$tenant','consent-notice-race','Consent race');
insert into public.tenant_users(tenant_id,user_id,role) values('$tenant','$owner','owner');
select public.register_consent_purpose('$tenant','analytics','Analytics','विश्लेषण',null,null,'consent','Notice one','सूचना एक',true,'$owner',gen_random_uuid());
SQL
purpose=$(sql -c "select id from public.consent_purposes where tenant_id='$tenant'")
race() {
  local label="$1" first="$2" second="$3" role_name="${4:-human_action_writer}"
  race_run "set local role $role_name; select $first" "set role human_action_writer; select $second" "$result_dir/$label-first" "$result_dir/$label-second"
}
publish="public.publish_consent_notice('$tenant','$purpose',1,'Notice two','सूचना दो',true,'$owner',gen_random_uuid())"
capture="public.record_consent('$tenant','$purpose',1,'cookie_id','stale-race-cookie','en','cookie',null,'$owner',gen_random_uuid())"
race consent-publish-first "$publish" "$capture"
grep -q 'stale_notice_version' "$result_dir/consent-publish-first-second"
[ "$(sql -c "select count(*) from public.consent_records where tenant_id='$tenant'")" = 0 ]

capture="public.record_consent('$tenant','$purpose',2,'cookie_id','captured-race-cookie','hi','cookie',null,'$owner',gen_random_uuid())"
publish="public.publish_consent_notice('$tenant','$purpose',2,'Notice three','सूचना तीन',true,'$owner',gen_random_uuid())"
race consent-capture-first "$capture" "$publish"
grep -q '"status": "granted"' "$result_dir/consent-capture-first-first"
[ "$(sql -c "select notice_version from public.consent_records where tenant_id='$tenant'")" = 2 ]
[ "$(sql -c "select notice_version from public.consent_purposes where tenant_id='$tenant'")" = 3 ]
[ "$(sql -c "select count(*) from public.consent_records r join public.consent_notice_versions n on n.tenant_id=r.tenant_id and n.purpose_id=r.purpose_id and n.notice_version=r.notice_version and n.snapshot_sha256=r.notice_snapshot_sha256 where r.tenant_id='$tenant' and n.notice_hi='सूचना दो'")" = 1 ]

deactivate="public.set_consent_purpose_active('$tenant','$purpose',false,'$owner',gen_random_uuid())"
capture="public.record_consent('$tenant','$purpose',3,'cookie_id','retired-race-cookie','en','cookie',null,'$owner',gen_random_uuid())"
race consent-deactivate-first "$deactivate" "$capture"
grep -q 'purpose_inactive' "$result_dir/consent-deactivate-first-second"
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id='$tenant' and action_type='consent.recorded'")" = 1 ]
# A trusted BFF authorization check cannot outlive a committed demotion.
consent=$(sql -c "select id from public.consent_records where tenant_id='$tenant'")
# PostgreSQL holds the membership row until commit; the manager check waits.
race_run "update public.tenant_users set role='viewer' where tenant_id='$tenant' and user_id='$owner'" "set role human_action_writer; select public.set_consent_legal_hold('$tenant','$consent',true,'$owner',gen_random_uuid())" "$result_dir/demote-first" "$result_dir/demote-second"
grep -q forbidden "$result_dir/demote-second"
[ "$(sql -c "select legal_hold from public.consent_records where tenant_id='$tenant'")" = f ]
echo 'Concurrent consent notice: publication/capture/deactivation serialize; stale notice refused; retained capture matches immutable reviewed bytes.'
