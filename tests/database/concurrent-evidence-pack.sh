#!/usr/bin/env bash
# Exact-byte pack lifecycle races against real locks, including both founder authorities.
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
tenant='99749999-0000-4000-8000-000000000010'
owner='99749999-0000-4000-8000-000000000001'
founder='99749999-0000-4000-8000-000000000002'
engagement='99749999-0000-4000-8000-000000000030'
key='99749999-0000-4000-8000-000000000040'
build_key='99749999-0000-4000-8000-000000000050'
sql <<SQL
insert into auth.users(id,email) values('$owner','pack-race-owner@example.invalid'),('$founder','pack-race-founder@example.invalid');
insert into public.users(id,email,is_axiom_internal) values('$owner','pack-race-owner@example.invalid',false),('$founder','pack-race-founder@example.invalid',true);
insert into public.tenants(id,slug,name) values('$tenant','pack-race','Pack race');
insert into public.tenant_users(tenant_id,user_id,role) values('$tenant','$owner','owner'),('$tenant','$founder','founder');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values('test-pack-race',now(),'fixture','synthetic',0);
insert into public.engagements(id,tenant_id,library_version,title) values('$engagement','$tenant','test-pack-race','Pack race');
do \$\$ declare x jsonb;r public.evidence_ingestions;k uuid:=gen_random_uuid();h text:=repeat('a',64); begin
 x:=public.begin_evidence_ingest('$tenant','$owner',k,jsonb_build_object('content_hash',h,'byte_size',3,'mime_type','text/plain',
 'evidence_type','document','control_ids','[]'::jsonb,'collected_by_agent','human','provider','s3-compatible','bucket','pack-race',
 'object_key','tenants/$tenant/evidence-ingestions/'||k||'/'||h,'retention_policy','seven_years','legal_hold',false),gen_random_uuid());
 select * into r from public.evidence_ingestions where id=(x->>'operation_id')::uuid;
 perform public.settle_evidence_ingest('$tenant','$owner',r.id,
  (r.request-array['mime_type','filename','description','evidence_type','control_ids','retention_policy'])||jsonb_build_object(
   'tenant_id','$tenant','operation_id',r.id,'correlation_id',r.correlation_id,'version_id','member-race-v1','retain_until',r.retain_until,
   'readback_at',clock_timestamp(),'lock_mode','COMPLIANCE','verified',true,'encryption','AES256'),gen_random_uuid());
end \$\$;
SQL
race() {
 local label="$1" first="$2" second="$3" first_role="${4:-statutory_proof_writer}" second_role="${5:-statutory_proof_writer}"
 sql -c "set application_name='$label-first'; begin; set local role $first_role; $first; select pg_sleep(3); commit;" > "$result_dir/$label-first" 2>&1 &
 local first_pid=$! ready=false blocked=false
 for attempt in $(seq 1 60); do
  [ "$(sql -c "select count(*) from pg_stat_activity where application_name='$label-first' and wait_event='PgSleep'")" = 1 ] && { ready=true; break; }
  sleep 0.05
 done
 [ "$ready" = true ] || { cat "$result_dir/$label-first"; exit 1; }
 sql -c "set application_name='$label-second'; set role $second_role; $second;" > "$result_dir/$label-second" 2>&1 &
 local second_pid=$!
 for attempt in $(seq 1 40); do
  [ "$(sql -c "select count(*) from pg_stat_activity where application_name='$label-second' and wait_event_type='Lock'")" = 1 ] && { blocked=true; break; }
  sleep 0.05
 done
 [ "$blocked" = true ] || { cat "$result_dir/$label-second"; exit 1; }
 wait "$first_pid"; wait "$second_pid"
}
member=$(sql -c "select id from public.evidence_object_versions where tenant_id='$tenant'")
prepare="select public.prepare_evidence_pack('$tenant','$owner','$key','Raced pack','$engagement',null,array['$member'::uuid],gen_random_uuid())"
race pack-prepare "$prepare" "$prepare"
grep -q '"replayed": true' "$result_dir/pack-prepare-second"
pack=$(sql -c "select id from public.evidence_packs where tenant_id='$tenant'")
report=$(sql -c "select report_id from public.evidence_packs where id='$pack'")
manifest=$(sql -c "select manifest_sha256 from public.evidence_packs where id='$pack'")
approve="select public.review_report('$tenant','$report','approved',null,'$founder','$manifest',gen_random_uuid())"
reject="select public.review_report('$tenant','$report','rejected','raced rejection','$founder','$manifest',gen_random_uuid())"
race pack-review "$approve" "$reject"
grep -q 'not_reviewable' "$result_dir/pack-review-second"
review=$(sql -c "select review_sha256 from public.report_reviews where report_id='$report'")
request=$(sql -c "select jsonb_build_object('provider','s3-compatible','bucket','pack-race','object_key','tenants/$tenant/evidence-packs/$pack/$build_key/'||repeat('d',64),'content_hash',repeat('d',64),'byte_size',1024,'manifest_sha256','$manifest','review_sha256','$review','retention_policy','seven_years','legal_hold',false)")
begin="select public.begin_evidence_pack_build('$tenant','$owner','$pack','$build_key','$request',gen_random_uuid())"
race pack-build "$begin" "$begin"
grep -q '"replayed": true' "$result_dir/pack-build-second"
build=$(sql -c "select id from public.evidence_pack_builds where pack_id='$pack'")
receipt=$(sql -c "select (request-array['manifest_sha256','review_sha256','retention_policy'])||jsonb_build_object('tenant_id',tenant_id,'engagement_id','$engagement','collected_by_agent','evidence-pack-builder','operation_id',id,'correlation_id',correlation_id,'version_id','archive-race-v1','retain_until',retain_until,'readback_at',clock_timestamp(),'lock_mode','COMPLIANCE','verified',true,'encryption','AES256') from public.evidence_pack_builds where id='$build'")
settle="select public.settle_evidence_pack_build('$tenant','$owner','$build','$receipt',gen_random_uuid())"
race pack-settle "$settle" "$settle"
grep -q '"replayed": true' "$result_dir/pack-settle-second"
release="select public.release_report('$tenant','$report','$founder','$manifest',repeat('d',64),gen_random_uuid())"
race pack-release "$release" "$release"
grep -q '"replayed": true' "$result_dir/pack-release-second"
[ "$(sql -c "select count(*) from public.report_reviews where report_id='$report'")" = 1 ]
[ "$(sql -c "select count(*) from public.evidence_pack_archives where pack_id='$pack'")" = 1 ]
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id='$tenant' and action_type='report.released'")" = 1 ]
race pack-founder-demotion "update public.tenant_users set role='owner' where tenant_id='$tenant' and user_id='$founder'" "$release" postgres
grep -q 'founder_authority_required' "$result_dir/pack-founder-demotion-second"
sql -c "update public.tenant_users set role='founder' where tenant_id='$tenant' and user_id='$founder'"
race pack-internal-revocation "update public.users set is_axiom_internal=false where id='$founder'" "$release" postgres
grep -q 'founder_authority_required' "$result_dir/pack-internal-revocation-second"
sql -c "update public.users set is_axiom_internal=true where id='$founder'"
# The deprecated draft RPC is superuser fixture-only; service_role and the writer are denied.
fresh=$(sql -c "select public.record_report_draft('$tenant','$owner',gen_random_uuid(),'board','Fresh review race','$engagement',null,'{\"synthetic\":true}','fixture',gen_random_uuid())->>'reportId'")
fresh_hash=$(sql -c "select content_sha256 from public.reports where id='$fresh'")
fresh_review="select public.review_report('$tenant','$fresh','approved',null,'$founder','$fresh_hash',gen_random_uuid())"
race pack-fresh-review-demotion "update public.tenant_users set role='owner' where tenant_id='$tenant' and user_id='$founder'" "$fresh_review" postgres
grep -q 'founder_authority_required' "$result_dir/pack-fresh-review-demotion-second"
[ "$(sql -c "select status from public.reports where id='$fresh'")" = draft ]
[ "$(sql -c "select count(*) from public.report_reviews where report_id='$fresh'")" = 0 ]
echo 'Pack races: one prepare/review/build/archive/release; founder membership and internal-flag revocation block replay and fresh review under real contention.'
