begin;
create temporary table cancel_assertions(count int not null);
insert into cancel_assertions values(0);
grant select,update on cancel_assertions to human_action_writer,agent_ledger_writer,service_role;
create function pg_temp.id(n int) returns uuid language sql immutable as $$select ('78880000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m; end if; update cancel_assertions set count=count+1; end$$;
create function pg_temp.reject(q text,code text default '42501') returns void language plpgsql as $$begin begin execute q; exception when others then if sqlstate=code then update cancel_assertions set count=count+1; return; end if; raise; end; raise exception 'Unexpected success: %',q; end$$;
insert into auth.users(id,email) values(pg_temp.id(1),'cancel-owner@test.invalid'),(pg_temp.id(2),'cancel-second-owner@test.invalid');
insert into public.users(id,email) values(pg_temp.id(1),'cancel-owner@test.invalid'),(pg_temp.id(2),'cancel-second-owner@test.invalid');
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'cancel-fixture','Cancellation fixture'),(pg_temp.id(12),'cancel-foreign','Foreign fixture');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(1),'owner'),(pg_temp.id(11),pg_temp.id(2),'owner');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values('cancel-fixture-v1',now(),'test','Synthetic',1);
insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version)
 values('WA-CANCEL','cancel-fixture-v1','Fixture','Fixture','SEC','low','[]','[]','[]','{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":1000000}','{}','cancel-fixture-v1');
insert into public.engagements(id,tenant_id,library_version,title) values(pg_temp.id(21),pg_temp.id(11),'cancel-fixture-v1','New assessment');
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status) values(pg_temp.id(31),pg_temp.id(11),'parikshan','spiffe://axiom.test/cancel-fixture','active');
create temporary table cancel_policy(value jsonb);
grant select,insert on cancel_policy to human_action_writer;
create function pg_temp.enqueue(job int default 51) returns jsonb language sql as $$
 select public.enqueue_assessment_dispatch(pg_temp.id(job),pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),null,pg_temp.id(21),pg_temp.id(job),repeat('a',64),encode(sha256(convert_to(job::text,'UTF8')),'hex'),clock_timestamp()+interval '5 minutes',
 'arn:aws:kms:ap-south-1:123456789012:key/'||pg_temp.id(61)::text,decode(repeat('ab',12),'hex'),decode(repeat('ab',100),'hex'),decode(repeat('cd',32),'hex'),1,(select value->>'fingerprint' from cancel_policy))$$;
create function pg_temp.cancel(job int default 51,actor int default 1,hash text default repeat('a',64),version text default 'cancel-fixture-v1',tenant int default 11,engagement int default 21) returns jsonb language sql as $$
 select public.cancel_unclaimed_assessment_request(pg_temp.id(tenant),pg_temp.id(actor),pg_temp.id(job),pg_temp.id(engagement),version,hash)$$;
create function pg_temp.append_generic(kind public.actor_type,action public.ledger_action_type) returns bigint language plpgsql as $$begin
 if kind='human' then return public.append_human_ledger(pg_temp.id(11),pg_temp.id(51),kind,pg_temp.id(1)::text,null,null,null,action,pg_temp.id(51)::text,repeat('a',64),null,null,null,null,null,'pending','{}'); end if;
 return public.append_agent_ledger(pg_temp.id(11),pg_temp.id(51),kind,'fixture-agent',null,null,null,action,pg_temp.id(51)::text,repeat('a',64),null,null,null,null,null,'pending','{}');
end$$;
do $$declare r text; begin foreach r in array array['anon','authenticated','service_role','agent_ledger_writer','axiom_assessment_controller'] loop
 perform pg_temp.ok(not has_function_privilege(r,'public.cancel_unclaimed_assessment_request(uuid,uuid,uuid,uuid,text,text)','execute'),'cancel RPC role denied '||r);
 perform pg_temp.ok(not has_table_privilege(r,'public.assessment_request_resolutions','insert,update,delete'),'resolution writes denied '||r);
 end loop; end$$;
do $$declare r text; signature text; begin foreach r in array array['anon','authenticated','service_role','human_action_writer','agent_ledger_writer','axiom_assessment_controller'] loop
 foreach signature in array array['controller_security.append_human_ledger_before_0113(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)','controller_security.append_agent_ledger_before_0113(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)'] loop
 perform pg_temp.ok(not has_function_privilege(r,signature,'execute'),'protected original append helper denied '||r);
 end loop; end loop; end$$;
select pg_temp.ok(has_function_privilege('human_action_writer','public.cancel_unclaimed_assessment_request(uuid,uuid,uuid,uuid,text,text)','execute'),'human cancel grant');
select pg_temp.ok(not has_table_privilege('human_action_writer','public.assessment_request_resolutions','insert,update,delete'),'human must use atomic RPC');
set local role human_action_writer;
insert into cancel_policy select public.publish_assessment_dispatch_key_policy(pg_temp.id(11),pg_temp.id(1),pg_temp.id(51),0,'aws','arn:aws:kms:ap-south-1:123456789012:key/'||pg_temp.id(61)::text,array['arn:aws:kms:ap-south-1:123456789012:key/'||pg_temp.id(61)::text]);
select pg_temp.ok(pg_temp.cancel()->>'error'='assessment_job_not_found','missing request not cancelled or invented');
select pg_temp.ok(pg_temp.enqueue() ? 'run_id','actual human enqueue succeeded');
select pg_temp.ok(pg_temp.cancel(51,2)->>'error'='cancellation_conflict','other current owner cannot cancel original actor request');
select pg_temp.ok(pg_temp.cancel(51,1,repeat('b',64))->>'error'='cancellation_conflict','changed declaration hash refused');
select pg_temp.ok(pg_temp.cancel(51,1,repeat('a',64),'other-version')->>'error'='cancellation_conflict','changed pinned library refused');
select pg_temp.ok(pg_temp.cancel(51,1,repeat('a',64),'cancel-fixture-v1',12)->>'error'='forbidden','foreign tenant refused');
select pg_temp.ok(pg_temp.cancel(51,1,repeat('a',64),'cancel-fixture-v1',11,22)->>'error'='cancellation_conflict','changed engagement refused');
reset role;
create temporary table original_state as select run_id,input_hash,nonce,ciphertext,wrapped_key from public.assessment_dispatch_jobs where id=pg_temp.id(51);
create temporary table no_append as select (select count(*) from public.audit_ledger where tenant_id=pg_temp.id(11)) rows,(select last_value from public.audit_ledger_id_seq) sequence;
grant select on original_state,no_append to human_action_writer;
savepoint role_disabled;
update public.tenant_users set role='viewer' where tenant_id=pg_temp.id(11) and user_id=pg_temp.id(1);
set local role human_action_writer;
select pg_temp.ok(pg_temp.cancel()->>'error'='forbidden','current lowered capability refuses cancellation');
reset role;rollback to role_disabled;
savepoint membership_removed;
delete from public.tenant_users where tenant_id=pg_temp.id(11) and user_id=pg_temp.id(1);
set local role human_action_writer;select pg_temp.ok(pg_temp.cancel()->>'error'='forbidden','removed current membership refuses cancellation');reset role;rollback to membership_removed;
savepoint internal_role;
update public.tenant_users set role='founder' where tenant_id=pg_temp.id(11) and user_id=pg_temp.id(1);
set local role human_action_writer;select pg_temp.ok(pg_temp.cancel()->>'error'='forbidden','internal role without internal flag refuses cancellation');reset role;rollback to internal_role;
savepoint kill_active;
update public.kill_switch_state set engaged=true where scope_key='global';
set local role human_action_writer;
select pg_temp.ok(pg_temp.cancel()->>'error'='kill_switch_engaged','current kill switch blocks mutation');
reset role;rollback to kill_active;
savepoint claimed;
update public.assessment_dispatch_jobs set claimed_at=clock_timestamp() where id=pg_temp.id(51);
set local role human_action_writer;select pg_temp.ok(pg_temp.cancel()->>'error'='assessment_not_unclaimed','claimed delivery cannot be cancelled');reset role;rollback to claimed;
savepoint running;
update public.agent_runs set status='running' where id=(select run_id from original_state);
set local role human_action_writer;select pg_temp.ok(pg_temp.cancel()->>'error'='assessment_not_unclaimed','started run refused');reset role;rollback to running;
savepoint orphan_receipt;
update public.agent_runs set metadata='{}' where id=(select run_id from original_state);
set local role human_action_writer;select pg_temp.ok(pg_temp.cancel()->>'error'='cancellation_conflict','legacy/orphan request receipt refused');reset role;rollback to orphan_receipt;
savepoint revoked;
update public.workload_task_delegations set revoked_at=clock_timestamp() where run_id=(select run_id from original_state);
set local role human_action_writer;select pg_temp.ok(pg_temp.cancel()->>'error'='assessment_not_unclaimed','revocation alone is not cancellation proof');reset role;rollback to revoked;
savepoint existing_packet;
insert into public.workload_assessment_packets(run_id,tenant_id,engagement_id,library_version,controls,library_digest,started_receipt)
 select run_id,pg_temp.id(11),pg_temp.id(21),'cancel-fixture-v1','[]',repeat('e',64),1 from original_state;
set local role human_action_writer;select pg_temp.ok(pg_temp.cancel()->>'error'='assessment_already_started','any existing worker packet refuses unclaimed cancellation');reset role;rollback to existing_packet;
savepoint start_receipt;
select public.append_ledger(pg_temp.id(11),pg_temp.id(51),'agent','parikshan',null,null,null,'assessment.started',pg_temp.id(21)::text,repeat('a',64),null,null,null,null,null,'pending',jsonb_build_object('run_id',(select run_id from original_state)));
set local role human_action_writer;select pg_temp.ok(pg_temp.cancel()->>'error'='assessment_already_started','any recorded start without packet still refuses cancellation');reset role;rollback to start_receipt;
set local role human_action_writer;
select pg_temp.reject('select pg_temp.append_generic(''human'',''assessment.request_cancelled'')');
select pg_temp.reject('select pg_temp.append_generic(''human'',''assessment.requested'')');
reset role;
set local role agent_ledger_writer;
select pg_temp.reject('select pg_temp.append_generic(''agent'',''assessment.request_cancelled'')');
select pg_temp.reject('select pg_temp.append_generic(''system'',''assessment.request_cancelled'')');
select pg_temp.reject('select pg_temp.append_generic(''agent'',''assessment.requested'')');
reset role;
select pg_temp.ok((select rows=(select count(*) from public.audit_ledger where tenant_id=pg_temp.id(11)) from no_append),'refused cancellation/generic writes append no row');
-- Verify ordinary append paths retain their existing validation and grants.
set local role human_action_writer;select pg_temp.ok(pg_temp.append_generic('human','workload.task_revoked')>0,'ordinary human append still works');reset role;
set local role agent_ledger_writer;select pg_temp.ok(pg_temp.append_generic('agent','discovery.started')>0,'ordinary agent append still works');select pg_temp.ok(pg_temp.append_generic('system','discovery.started')>0,'ordinary system append still works');reset role;
-- A later legitimate engagement pin change cannot invalidate original cancellation.
insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values('cancel-fixture-v2',now(),'test','Synthetic changed pin',1);
update public.engagements set library_version='cancel-fixture-v2' where id=pg_temp.id(21);
create temporary table cancelled(value jsonb);
grant insert,select on cancelled to human_action_writer;
set local role human_action_writer;
insert into cancelled select pg_temp.cancel();
select pg_temp.ok((select value ? 'cancellation_receipt' from cancelled),'atomic cancellation has durable receipt');
select pg_temp.ok(pg_temp.cancel()=(select value from cancelled),'lost response retry recovers identical resolution without write');
select pg_temp.ok(pg_temp.cancel(51,1,repeat('b',64))->>'error'='cancellation_conflict','changed retry body refused after resolution');
reset role;
select pg_temp.ok((select count(*)=1 from public.assessment_request_resolutions where tenant_id=pg_temp.id(11)),'one immutable resolution');
select pg_temp.ok((select library_version='cancel-fixture-v1' from public.assessment_request_resolutions where job_id=pg_temp.id(51)),'resolution retains original human library after current engagement pin changes');
select pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type='assessment.request_cancelled'),'one human cancellation receipt');
select pg_temp.ok((select r.status='cancelled' and r.completed_at=c.resolved_at and r.output_redacted_hash is null and r.error is null and t.revoked_at=c.resolved_at and j.claimed_at is null
 from public.assessment_request_resolutions c join public.agent_runs r on r.id=c.run_id join public.workload_task_delegations t on t.run_id=c.run_id join public.assessment_dispatch_jobs j on j.id=c.job_id where c.job_id=pg_temp.id(51)),'resolved cancelled run and revoked unclaimed task share exact timestamp');
select pg_temp.ok((select j.input_hash=o.input_hash and j.nonce=o.nonce and j.ciphertext=o.ciphertext and j.wrapped_key=o.wrapped_key from public.assessment_dispatch_jobs j,original_state o where j.id=pg_temp.id(51)),'cancellation never deletes or replaces encrypted original payload');
select pg_temp.ok((select count(*)=0 from public.workload_assessment_packets where tenant_id=pg_temp.id(11)),'no scoring/finalization manufactured');
select pg_temp.reject('update public.assessment_request_resolutions set library_version=''changed'' where job_id=pg_temp.id(51)','42501');
select pg_temp.reject('delete from public.assessment_request_resolutions where job_id=pg_temp.id(51)','42501');
set local role service_role;
select pg_temp.ok((select count(*)=1 from public.assessment_request_resolutions where tenant_id=pg_temp.id(11)),'backend can read verified resolution');
select pg_temp.reject('insert into public.assessment_request_resolutions select * from public.assessment_request_resolutions');
select pg_temp.reject('select pg_temp.cancel()');
reset role;
select 'Unclaimed assessment cancellation: '||count||' assertions passed' from cancel_assertions;
rollback;
