begin;
create function pg_temp.id(n int) returns uuid language sql immutable as $$select ('69690000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m; end if; end$$;
create function pg_temp.reject(q text,code text) returns void language plpgsql as $$begin begin execute q; exception when others then if sqlstate=code then return; end if; raise; end; raise exception 'Unexpected success'; end$$;
insert into auth.users(id,email) values(pg_temp.id(1),'retention-fixture@test.invalid');
insert into public.users(id,email) values(pg_temp.id(1),'retention-fixture@test.invalid');
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'retention-fixture','Worker fixture');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(1),'owner');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('retention-fixture-v1',now(),'test','Synthetic fixture',2);
insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version)
 select 'WA-'||n,'retention-fixture-v1','Fixture','Fixture','SEC','low','[]','[]','[]','{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":1000000}','{}','retention-fixture-v1' from generate_series(1,2) n;
insert into public.estates(id,tenant_id,name,slug) values(pg_temp.id(22),pg_temp.id(11),'Synthetic estate','synthetic');
insert into public.engagements(id,tenant_id,estate_id,library_version,title) values(pg_temp.id(21),pg_temp.id(11),pg_temp.id(22),'retention-fixture-v1','New assessment');
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status)
 values(pg_temp.id(31),pg_temp.id(11),'parikshan','spiffe://axiom.test/parikshan','active');

create function pg_temp.enqueue(job int default 51,hash text default repeat('a',64),cipher bytea default decode(repeat('ab',100),'hex')) returns jsonb language sql as $$
 select public.enqueue_assessment_dispatch(pg_temp.id(job),pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(22),pg_temp.id(21),pg_temp.id(41),hash,encode(sha256(convert_to('retention-'||job::text,'UTF8')),'hex'),clock_timestamp()+interval '10 minutes','synthetic-key/v1',decode(repeat('ab',12),'hex'),cipher,decode(repeat('cd',32),'hex'))$$;

create temporary table issued as select (pg_temp.enqueue()->>'run_id')::uuid run_id;
grant select on issued to service_role;
create function pg_temp.purge(days integer default 90) returns jsonb language sql as $$select public.purge_next_assessment_dispatch_payload(days,pg_temp.id(11))$$;
select public.claim_assessment_dispatch(pg_temp.id(11),pg_temp.id(51));
select public.start_workload_assessment(pg_temp.id(11),(select run_id from issued),pg_temp.id(31),encode(sha256(convert_to('retention-51','UTF8')),'hex'),repeat('a',64),clock_timestamp()+interval '5 minutes');
select public.complete_workload_assessment(pg_temp.id(11),(select run_id from issued),pg_temp.id(31),encode(sha256(convert_to('retention-51','UTF8')),'hex'),(select library_digest from public.workload_assessment_packets where run_id=(select run_id from issued)),
 '{"library_version":"retention-fixture-v1","posture_score":50,"estimated_exposure_inr":10000000,"findings":[{"control_id":"WA-1","score":0,"risk_points":10,"rationale":"No answers comply"},{"control_id":"WA-2","score":100,"risk_points":0,"rationale":"All answers comply"}]}'::jsonb,clock_timestamp()+interval '5 minutes');
-- FIXTURE_READY: populated old-schema state stops here for upgrade coverage.
update public.assessment_dispatch_jobs set created_at=clock_timestamp()-interval '190 days' where id=pg_temp.id(51);
set local role service_role;
select pg_temp.ok(pg_temp.purge()->>'status'='idle','completed computation without independent confirmation survives');
select public.confirm_workload_assessment(pg_temp.id(11),(select run_id from issued));
select pg_temp.ok(pg_temp.purge()->>'status'='idle','new confirmation survives default policy');
select pg_temp.ok(pg_temp.purge(0)->>'error'='retention_refused','zero refuses');
select pg_temp.ok(pg_temp.purge(null)->>'error'='retention_refused','null refuses');
select pg_temp.ok(pg_temp.purge(36501)->>'error'='retention_refused','excessive retention refuses');
reset role;
update public.workload_assessment_packets set finalized_at=clock_timestamp()-interval '89 days' where run_id=(select run_id from issued);
select pg_temp.ok(pg_temp.purge()->>'status'='idle','89 days survives default 90');
savepoint shorter_policy;
select pg_temp.ok(pg_temp.purge(30)->>'status'='purged','configured shorter policy is effective');
select pg_temp.ok((select payload_retention_days=30 from public.assessment_dispatch_jobs where id=pg_temp.id(51)),'receipt records effective policy');
rollback to shorter_policy;
update public.workload_assessment_packets set finalized_at=clock_timestamp()-interval '91 days' where run_id=(select run_id from issued);
select pg_temp.ok(pg_temp.purge(100)->>'status'='idle','configured longer policy preserves ciphertext');
select pg_temp.ok(public.purge_next_assessment_dispatch_payload(90,pg_temp.id(99))->>'status'='idle','foreign tenant cannot select this job');
savepoint unclaimed;
update public.assessment_dispatch_jobs set claimed_at=null where id=pg_temp.id(51);
select pg_temp.ok(pg_temp.purge()->>'status'='idle','undelivered job survives');
rollback to unclaimed;
savepoint cancelled;
update public.agent_runs set status='cancelled' where id=(select run_id from issued);
select pg_temp.ok(pg_temp.purge()->>'status'='idle','cancelled job survives');
rollback to cancelled;
savepoint corrupt;
update public.workload_assessment_packets set result=jsonb_set(result,'{posture_score}','60') where run_id=(select run_id from issued);
select pg_temp.ok(pg_temp.purge()->>'status'='review','changed result stops cleanup for review');
select pg_temp.ok((select ciphertext is not null from public.assessment_dispatch_jobs where id=pg_temp.id(51)),'conflict retains ciphertext');
rollback to corrupt;
savepoint wrong_receipt;
update public.workload_assessment_packets set finalized_receipt=completed_receipt where run_id=(select run_id from issued);
select pg_temp.ok(pg_temp.purge()->>'status'='review','immutable finalization receipt must bind the job');
rollback to wrong_receipt;
create function pg_temp.fail_purge() returns trigger language plpgsql as $$begin if new.action_type='workload.dispatch_payload_purged' then raise exception 'synthetic audit failure'; end if; return new; end$$;
create trigger fail_purge before insert on public.audit_ledger for each row execute function pg_temp.fail_purge();
set local role service_role;
select pg_temp.reject('select pg_temp.purge()','P0001');
select pg_temp.ok((select ciphertext is not null and payload_purged_at is null from public.assessment_dispatch_jobs where id=pg_temp.id(51)),'audit failure leaves payload intact');
reset role;
drop trigger fail_purge on public.audit_ledger;
set local role service_role;
select pg_temp.ok(pg_temp.purge()->>'status'='purged','eligible confirmed payload purged');
select pg_temp.ok(pg_temp.purge()->>'status'='idle','repeat cleanup is idempotent');
select pg_temp.ok((select nonce is null and ciphertext is null and wrapped_key is null and payload_purge_receipt is not null and payload_retention_days=90 and claimed_at is not null from public.assessment_dispatch_jobs where id=pg_temp.id(51)),'private bytes removed, single-use delivery preserved');
select pg_temp.ok(pg_temp.enqueue()->>'run_id'=(select run_id::text from issued),'stable enqueue retry retains original receipt after purge');
select pg_temp.ok(public.claim_assessment_dispatch(pg_temp.id(11),pg_temp.id(51)) ? 'error','purge cannot revive delivery');
select pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type='workload.dispatch_payload_purged'),'exactly one cleanup audit');
select pg_temp.ok((select count(*)=2 from public.findings where tenant_id=pg_temp.id(11)),'findings survive');
select pg_temp.ok((select count(*)=1 from public.workload_assessment_packets where finalized_receipt is not null),'confirmed result survives');
select pg_temp.reject('update public.assessment_dispatch_jobs set payload_purged_at=null','42501');
reset role;
set local role authenticated;
select pg_temp.reject('select pg_temp.purge()','42501');
reset role;
set local role anon;
select pg_temp.reject('select pg_temp.purge()','42501');
reset role;
rollback;
