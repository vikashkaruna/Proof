#!/usr/bin/env bash
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql <<'SQL'
create schema assessment_race;
create function assessment_race.id(n int) returns uuid language sql immutable as $$select ('52520000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function assessment_race.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m; end if; end$$;
create function assessment_race.reject(q text,code text) returns void language plpgsql as $$begin begin execute q; exception when others then if sqlstate=code then return; end if; raise; end; raise exception 'Unexpected success'; end$$;
insert into auth.users(id,email) values(assessment_race.id(1),'assessment-race@test.invalid');
insert into public.users(id,email) values(assessment_race.id(1),'assessment-race@test.invalid');
insert into public.tenants(id,slug,name) values(assessment_race.id(11),'assessment-race','Worker fixture');
insert into public.tenant_users(tenant_id,user_id,role) values(assessment_race.id(11),assessment_race.id(1),'owner');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('assessment-race-v1',now(),'test','Synthetic fixture',2);
insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version)
 select 'WA-'||n,'assessment-race-v1','Fixture','Fixture','SEC','low','[]','[]','[]','{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":1000000}','{}','assessment-race-v1' from generate_series(1,2) n;
insert into public.estates(id,tenant_id,name,slug) values(assessment_race.id(22),assessment_race.id(11),'Synthetic estate','synthetic');
insert into public.engagements(id,tenant_id,estate_id,library_version,title) values(assessment_race.id(21),assessment_race.id(11),assessment_race.id(22),'assessment-race-v1','New assessment');
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status)
 values(assessment_race.id(31),assessment_race.id(11),'parikshan','spiffe://axiom.test/parikshan','active');
create table assessment_race.issued as select (public.delegate_workload_task(assessment_race.id(11),assessment_race.id(1),assessment_race.id(31),'parikshan',assessment_race.id(22),assessment_race.id(21),assessment_race.id(41),repeat('a',64),repeat('b',64),array['control_library.read','findings.write'],clock_timestamp()+interval '10 minutes')->>'run_id')::uuid run_id;
grant select on assessment_race.issued to service_role;
create function assessment_race.start_tool(proof text default repeat('b',64),input_hash text default repeat('a',64),deadline timestamptz default clock_timestamp()+interval '5 minutes') returns jsonb language sql as $$
 select public.start_workload_assessment(assessment_race.id(11),(select run_id from assessment_race.issued),assessment_race.id(31),proof,input_hash,deadline)$$;
create function assessment_race.result() returns jsonb language sql immutable as $$select '{"library_version":"assessment-race-v1","posture_score":50,"estimated_exposure_inr":10000000,"findings":[{"control_id":"WA-1","score":0,"risk_points":10,"rationale":"No answers comply"},{"control_id":"WA-2","score":100,"risk_points":0,"rationale":"All answers comply"}]}'::jsonb$$;
create function assessment_race.finish_tool(result jsonb default assessment_race.result(),deadline timestamptz default clock_timestamp()+interval '5 minutes') returns jsonb language sql as $$
 select public.complete_workload_assessment(assessment_race.id(11),(select run_id from assessment_race.issued),assessment_race.id(31),repeat('b',64),(select library_digest from public.workload_assessment_packets where run_id=(select run_id from assessment_race.issued)),result,deadline)$$;

grant usage on schema assessment_race to service_role;
grant execute on all functions in schema assessment_race to service_role;
select assessment_race.start_tool();
SQL
barrier() {
  for attempt in $(seq 1 80); do
    if [ "$(sql -c "select count(*) from pg_stat_activity where application_name='$1' and $2='$3'")" = 1 ]; then return; fi
    sleep 0.05
  done
  echo 'Assessment concurrency barrier not reached'; exit 1
}
race() {
 echo 'Checking assessment lock ordering'
 sql -c "set application_name='assessment-first'; begin; $1; select pg_sleep(2); commit;" > "$result_dir/first" 2>&1 &
 local first_pid=$!
 barrier assessment-first wait_event PgSleep
 sql -c "set application_name='assessment-second'; $2;" > "$result_dir/second" 2>&1 &
 local second_pid=$!
 barrier assessment-second wait_event_type Lock
 wait "$first_pid" || { cat "$result_dir/first"; exit 1; }
 wait "$second_pid" || { cat "$result_dir/second"; exit 1; }
}
refused() {
 if ! grep -q 'task_refused' "$result_dir/second"; then
  echo 'Expected transactional authority refusal; synthetic response:'
  cat "$result_dir/second"
  return 1
 fi
 [ "$(sql -c 'select count(*) from public.findings where tenant_id=assessment_race.id(11)')" = 0 ]
}
race "update public.tenant_users set role='viewer' where user_id=assessment_race.id(1)" "set role service_role; select assessment_race.finish_tool()"
refused
sql -c "update public.tenant_users set role='owner' where user_id=assessment_race.id(1)"
race "update public.workload_identities set status='disabled' where id=assessment_race.id(31)" "set role service_role; select assessment_race.finish_tool()"
refused
sql -c "update public.workload_identities set status='active' where id=assessment_race.id(31)"
race "select public.revoke_workload_task(assessment_race.id(11),assessment_race.id(1),(select run_id from assessment_race.issued),assessment_race.id(41))" "set role service_role; select assessment_race.finish_tool()"
refused
# Fixture reset by the disposable DB administrator only.
sql -c 'update public.workload_task_delegations set revoked_at=null where run_id=(select run_id from assessment_race.issued)'
race "insert into public.kill_switch_state(scope_key,scope,tenant_id,engaged) values(assessment_race.id(11)::text,'tenant',assessment_race.id(11),true)" "set role service_role; select assessment_race.finish_tool()"
refused
sql -c "update public.kill_switch_state set engaged=false where tenant_id=assessment_race.id(11)"
race "update public.estates set status='archived' where id=assessment_race.id(22)" "set role service_role; select assessment_race.finish_tool()"
refused
sql -c "update public.estates set status='active' where id=assessment_race.id(22)"
# Identity expires while waiting on the engagement lock: no stale commit.
race "select id from public.engagements where id=assessment_race.id(21) for update" "set role service_role; select assessment_race.finish_tool(assessment_race.result(),clock_timestamp()+interval '1 second')"
refused
# Two identical completions serialize into one result and one audit event.
race "set local role service_role; select assessment_race.finish_tool()" "set role service_role; select assessment_race.finish_tool()"
grep -q completed_receipt "$result_dir/second"
[ "$(sql -c 'select count(*) from public.findings where tenant_id=assessment_race.id(11)')" = 2 ]
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id=assessment_race.id(11) and action_type='assessment.scored'")" = 1 ]
# Reverse ordering: a transaction that checked authority first finishes before halt.
race "set local role service_role; select assessment_race.finish_tool()" "update public.kill_switch_state set engaged=true where tenant_id=assessment_race.id(11)"
[ "$(sql -c "select assessment_race.finish_tool()->>'error'")" = task_refused ]
sql -c 'drop schema assessment_race cascade' >/dev/null 2>&1
echo 'Concurrent assessments: demotion, registration, revocation, new halt and identity expiry refuse stale writes; retries and halt ordering serialize.'
