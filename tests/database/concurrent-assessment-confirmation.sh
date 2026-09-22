#!/usr/bin/env bash
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql <<'SQL'
create schema confirmation_race;
create function confirmation_race.id(n int) returns uuid language sql immutable as $$select ('54540000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function confirmation_race.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m; end if; end$$;
create function confirmation_race.reject(q text,code text) returns void language plpgsql as $$begin begin execute q; exception when others then if sqlstate=code then return; end if; raise; end; raise exception 'Unexpected success'; end$$;
insert into auth.users(id,email) values(confirmation_race.id(1),'confirmation-race@test.invalid');
insert into public.users(id,email) values(confirmation_race.id(1),'confirmation-race@test.invalid');
insert into public.tenants(id,slug,name) values(confirmation_race.id(11),'confirmation-race','Worker fixture');
insert into public.tenant_users(tenant_id,user_id,role) values(confirmation_race.id(11),confirmation_race.id(1),'owner');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('confirmation-race-v1',now(),'test','Synthetic fixture',2);
insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version)
 select 'WA-'||n,'confirmation-race-v1','Fixture','Fixture','SEC','low','[]','[]','[]','{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":1000000}','{}','confirmation-race-v1' from generate_series(1,2) n;
insert into public.estates(id,tenant_id,name,slug) values(confirmation_race.id(22),confirmation_race.id(11),'Synthetic estate','synthetic');
insert into public.engagements(id,tenant_id,estate_id,library_version,title) values(confirmation_race.id(21),confirmation_race.id(11),confirmation_race.id(22),'confirmation-race-v1','New assessment');
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status)
 values(confirmation_race.id(31),confirmation_race.id(11),'parikshan','spiffe://axiom.test/parikshan','active');
create table confirmation_race.issued as select (public.delegate_workload_task(confirmation_race.id(11),confirmation_race.id(1),confirmation_race.id(31),'parikshan',confirmation_race.id(22),confirmation_race.id(21),confirmation_race.id(41),repeat('a',64),repeat('d',64),array['control_library.read','findings.write'],clock_timestamp()+interval '10 minutes')->>'run_id')::uuid run_id;
grant select on confirmation_race.issued to service_role;
create function confirmation_race.start_tool(proof text default repeat('d',64),input_hash text default repeat('a',64),deadline timestamptz default clock_timestamp()+interval '5 minutes') returns jsonb language sql as $$
 select public.start_workload_assessment(confirmation_race.id(11),(select run_id from confirmation_race.issued),confirmation_race.id(31),proof,input_hash,deadline)$$;
create function confirmation_race.result() returns jsonb language sql immutable as $$select '{"library_version":"confirmation-race-v1","posture_score":50,"estimated_exposure_inr":10000000,"findings":[{"control_id":"WA-1","score":0,"risk_points":10,"rationale":"No answers comply"},{"control_id":"WA-2","score":100,"risk_points":0,"rationale":"All answers comply"}]}'::jsonb$$;
create function confirmation_race.finish_tool(result jsonb default confirmation_race.result(),deadline timestamptz default clock_timestamp()+interval '5 minutes') returns jsonb language sql as $$
 select public.complete_workload_assessment(confirmation_race.id(11),(select run_id from confirmation_race.issued),confirmation_race.id(31),repeat('d',64),(select library_digest from public.workload_assessment_packets where run_id=(select run_id from confirmation_race.issued)),result,deadline)$$;

grant usage on schema confirmation_race to service_role;
grant execute on all functions in schema confirmation_race to service_role;
select confirmation_race.start_tool();
select confirmation_race.finish_tool();
create function confirmation_race.confirm_tool() returns jsonb language sql as $$select public.confirm_workload_assessment(confirmation_race.id(11),(select run_id from confirmation_race.issued))$$;
grant execute on function confirmation_race.confirm_tool() to service_role;
SQL
barrier() {
  for attempt in $(seq 1 80); do
    if [ "$(sql -c "select count(*) from pg_stat_activity where application_name='$1' and $2='$3'")" = 1 ]; then return; fi
    sleep 0.05
  done
  echo 'Confirmation concurrency barrier not reached'; exit 1
}
race() {
 echo 'Checking confirmation lock ordering'
 sql -c "set application_name='confirmation-first'; begin; $1; select pg_sleep(2); commit;" > "$result_dir/first" 2>&1 &
 local first_pid=$!
 barrier confirmation-first wait_event PgSleep
 sql -c "set application_name='confirmation-second'; $2;" > "$result_dir/second" 2>&1 &
 local second_pid=$!
 barrier confirmation-second wait_event_type Lock
 wait "$first_pid" || { cat "$result_dir/first"; exit 1; }
 wait "$second_pid" || { cat "$result_dir/second"; exit 1; }
}
race "update public.agent_runs set status='cancelled',completed_at=clock_timestamp() where id=(select run_id from confirmation_race.issued) and status='running'" "set role service_role; select confirmation_race.confirm_tool()"
grep -q terminal_conflict "$result_dir/second"
[ "$(sql -c 'select status from public.agent_runs where id=(select run_id from confirmation_race.issued)')" = cancelled ]
# Reset only this disposable fixture for the reverse ordering.
sql -c "update public.agent_runs set status='running',completed_at=null where id=(select run_id from confirmation_race.issued)"
race "set local role service_role; select confirmation_race.confirm_tool()" "set role service_role; select confirmation_race.confirm_tool()"
grep -q succeeded "$result_dir/second"
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id=confirmation_race.id(11) and action_type='workload.task_completed'")" = 1 ]
# A fresh running task is required for the opposite race; a cancellation of an
# already succeeded row should skip it immediately, not wait on its lock.
sql <<'SQL'
insert into public.engagements(id,tenant_id,estate_id,library_version,title)
 values(confirmation_race.id(23),confirmation_race.id(11),confirmation_race.id(22),'confirmation-race-v1','Reverse race');
create function confirmation_race.second_proof() returns text language sql immutable as $$select encode(sha256(convert_to('confirmation-second-case','UTF8')),'hex')$$;
update confirmation_race.issued set run_id=(public.delegate_workload_task(confirmation_race.id(11),confirmation_race.id(1),confirmation_race.id(31),'parikshan',confirmation_race.id(22),confirmation_race.id(23),confirmation_race.id(42),repeat('a',64),confirmation_race.second_proof(),array['control_library.read','findings.write'],clock_timestamp()+interval '5 minutes')->>'run_id')::uuid;
select confirmation_race.start_tool(confirmation_race.second_proof());
select public.complete_workload_assessment(confirmation_race.id(11),(select run_id from confirmation_race.issued),confirmation_race.id(31),confirmation_race.second_proof(),(select library_digest from public.workload_assessment_packets where run_id=(select run_id from confirmation_race.issued)),confirmation_race.result(),clock_timestamp()+interval '5 minutes');
SQL
race "set local role service_role; select confirmation_race.confirm_tool()" "update public.agent_runs set status='cancelled',completed_at=clock_timestamp() where id=(select run_id from confirmation_race.issued) and status='running'"
[ "$(sql -c 'select status from public.agent_runs where id=(select run_id from confirmation_race.issued)')" = succeeded ]
sql -c 'drop schema confirmation_race cascade' >/dev/null 2>&1
echo 'Concurrent confirmation: cancellation and completion respect lock order; duplicate recovery confirms one receipt.'
