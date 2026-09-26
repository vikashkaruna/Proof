#!/usr/bin/env bash
# Real PostgreSQL contention: durable intent, single settlement, live authority.
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
tenant='99739999-0000-4000-8000-000000000010'
owner='99739999-0000-4000-8000-000000000001'
key='99739999-0000-4000-8000-000000000030'
sql <<SQL
insert into auth.users(id,email) values('$owner','evidence-race@example.invalid');
insert into public.users(id,email) values('$owner','evidence-race@example.invalid');
insert into public.tenants(id,slug,name) values('$tenant','evidence-race','Evidence race');
insert into public.tenant_users(tenant_id,user_id,role) values('$tenant','$owner','owner');
SQL
request=$(sql -c "select jsonb_build_object('content_hash',repeat('b',64),'byte_size',3,'mime_type','text/plain','evidence_type','document','control_ids','[]'::jsonb,'engagement_id',null,'collected_by_agent','human','provider','s3-compatible','bucket','axiom-test-vault','object_key','tenants/$tenant/evidence-ingestions/$key/'||repeat('b',64),'retention_policy','seven_years','legal_hold',false)")
race() {
 local label="$1" first="$2" second="$3" role_name="${4:-service_role}"
 sql -c "set application_name='$label-first'; begin; set local role $role_name; $first; select pg_sleep(3); commit;" > "$result_dir/$label-first" 2>&1 &
 local first_pid=$! ready=false blocked=false
 for attempt in $(seq 1 60); do
  [ "$(sql -c "select count(*) from pg_stat_activity where application_name='$label-first' and wait_event='PgSleep'")" = 1 ] && { ready=true; break; }
  sleep 0.05
 done
 [ "$ready" = true ] || { cat "$result_dir/$label-first"; exit 1; }
 sql -c "set application_name='$label-second'; set role service_role; $second;" > "$result_dir/$label-second" 2>&1 &
 local second_pid=$!
 for attempt in $(seq 1 40); do
  [ "$(sql -c "select count(*) from pg_stat_activity where application_name='$label-second' and wait_event_type='Lock'")" = 1 ] && { blocked=true; break; }
  sleep 0.05
 done
 [ "$blocked" = true ] || { cat "$result_dir/$label-second"; exit 1; }
 wait "$first_pid"; wait "$second_pid"
}
begin="select public.begin_evidence_ingest('$tenant','$owner','$key','$request',gen_random_uuid())"
race evidence-begin "$begin" "$begin"
grep -q '"replayed": true' "$result_dir/evidence-begin-second"
[ "$(sql -c "select count(*) from public.evidence_ingestions where tenant_id='$tenant'")" = 1 ]
operation=$(sql -c "select id from public.evidence_ingestions where tenant_id='$tenant'")
receipt=$(sql -c "select (request-array['mime_type','filename','description','evidence_type','control_ids','retention_policy'])||jsonb_build_object('tenant_id',tenant_id,'operation_id',id,'correlation_id',correlation_id,'version_id','actual-test-version','retain_until',retain_until,'readback_at',clock_timestamp(),'lock_mode','COMPLIANCE','verified',true,'encryption','AES256') from public.evidence_ingestions where id='$operation'")
settle="select public.settle_evidence_ingest('$tenant','$owner','$operation','$receipt',gen_random_uuid())"
race evidence-settle "$settle" "$settle"
grep -q '"replayed": true' "$result_dir/evidence-settle-second"
[ "$(sql -c "select count(*) from public.evidence_object_versions where tenant_id='$tenant'")" = 1 ]
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id='$tenant' and action_type='evidence.ingestion.settled'")" = 1 ]
race evidence-demotion "update public.tenant_users set role='viewer' where tenant_id='$tenant' and user_id='$owner'" "$settle" postgres
grep -q 'forbidden' "$result_dir/evidence-demotion-second"
echo 'Evidence races: identical begin/settle serialize, exactly one receipt, committed actor demotion refuses replay.'
