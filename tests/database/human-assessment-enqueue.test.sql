begin;
create function pg_temp.id(n int) returns uuid language sql immutable as $$select ('78780000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m; end if; end$$;
create function pg_temp.reject(q text,code text) returns void language plpgsql as $$begin begin execute q; exception when others then if sqlstate=code then return; end if; raise; end; raise exception 'Unexpected success'; end$$;
insert into auth.users(id,email) values(pg_temp.id(1),'human-enqueue-fixture@test.invalid');
insert into public.users(id,email) values(pg_temp.id(1),'human-enqueue-fixture@test.invalid');
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'human-enqueue-fixture','Worker fixture');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(1),'owner');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('human-enqueue-fixture-v1',now(),'test','Synthetic fixture',2);
insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version)
 select 'WA-'||n,'human-enqueue-fixture-v1','Fixture','Fixture','SEC','low','[]','[]','[]','{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":1000000}','{}','human-enqueue-fixture-v1' from generate_series(1,2) n;
insert into public.estates(id,tenant_id,name,slug) values(pg_temp.id(22),pg_temp.id(11),'Synthetic estate','synthetic');
insert into public.engagements(id,tenant_id,estate_id,library_version,title) values(pg_temp.id(21),pg_temp.id(11),pg_temp.id(22),'human-enqueue-fixture-v1','New assessment');
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status)
 values(pg_temp.id(31),pg_temp.id(11),'parikshan','spiffe://axiom.test/parikshan','active');


create temporary table policy(value jsonb);
grant select on policy to human_action_writer,service_role,agent_ledger_writer;
grant insert on policy to human_action_writer;
create function pg_temp.enqueue(job int default 51, hash text default repeat('a',64), rev integer default 1, fp text default null) returns jsonb language sql as $$
 select public.enqueue_assessment_dispatch(pg_temp.id(job),pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(22),pg_temp.id(21),pg_temp.id(41),hash,encode(sha256(convert_to(job::text,'UTF8')),'hex'),clock_timestamp()+interval '5 minutes',
 'arn:aws:kms:ap-south-1:123456789012:key/'||pg_temp.id(61)::text,decode(repeat('ab',12),'hex'),decode(repeat('ab',100),'hex'),decode(repeat('cd',32),'hex'),rev,coalesce(fp,(select value->>'fingerprint' from policy)))$$;
create function pg_temp.recover(job int default 51, hash text default repeat('a',64)) returns jsonb language sql as $$
 select public.recover_assessment_dispatch(pg_temp.id(job),pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(22),pg_temp.id(21),pg_temp.id(41),hash)$$;
select pg_temp.ok(has_function_privilege('human_action_writer','public.enqueue_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text)','execute'),'human writer owns enqueue');
do $$declare role_name text; begin
 foreach role_name in array array['service_role','anon','authenticated','agent_ledger_writer','axiom_assessment_controller'] loop
  perform pg_temp.ok(not has_function_privilege(role_name,'public.recover_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)','execute'),'forbidden recovery role '||role_name);
  perform pg_temp.ok(not has_function_privilege(role_name,'public.enqueue_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text)','execute'),'forbidden enqueue role '||role_name);
  perform pg_temp.ok(not has_function_privilege(role_name,'controller_security.enqueue_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text)','execute'),'private fenced helper role '||role_name);
  perform pg_temp.ok(not has_function_privilege(role_name,'public.enqueue_assessment_dispatch_unfenced(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea)','execute'),'private unfenced helper role '||role_name);
 end loop;
end $$;
select pg_temp.ok(not has_function_privilege('human_action_writer','controller_security.enqueue_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text)','execute'),'human writer cannot bypass public fence');
select pg_temp.ok(not has_function_privilege('human_action_writer','public.enqueue_assessment_dispatch_unfenced(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea)','execute'),'human writer cannot bypass private unfenced helper');
set local role service_role;
select pg_temp.reject('select pg_temp.enqueue()','42501');
select pg_temp.reject('select pg_temp.recover()','42501');
reset role;
set local role human_action_writer;
select pg_temp.ok(pg_temp.recover() is null,'new job receipt-only lookup is absent');
select pg_temp.ok(pg_temp.enqueue()->>'error'='policy_required','missing published policy cannot create work');
insert into policy select public.publish_assessment_dispatch_key_policy(pg_temp.id(11),pg_temp.id(1),pg_temp.id(41),0,'aws','arn:aws:kms:ap-south-1:123456789012:key/'||pg_temp.id(61)::text,array['arn:aws:kms:ap-south-1:123456789012:key/'||pg_temp.id(61)::text]);
select pg_temp.ok(pg_temp.enqueue(51,repeat('a',64),null)->>'error'='policy_stale','no legacy revision fallback');
select pg_temp.ok(pg_temp.enqueue(51,repeat('a',64),2)->>'error'='policy_stale','stale policy revision cannot create work');
select pg_temp.ok(pg_temp.enqueue(51,repeat('a',64),1,repeat('f',64))->>'error'='policy_stale','foreign policy fingerprint refused');
create temporary table issued as select pg_temp.enqueue() value;
grant select on issued to service_role;
select pg_temp.ok(pg_temp.enqueue()->>'run_id'=(select value->>'run_id' from issued),'stable retry returns same original run');
select pg_temp.ok(pg_temp.recover()=(select value from issued),'receipt-only recovery is exact original receipt');
select pg_temp.ok(pg_temp.recover(51,repeat('c',64))->>'error'='dispatch_conflict','receipt lookup refuses changed input');
select pg_temp.ok(public.recover_assessment_dispatch(pg_temp.id(51),pg_temp.id(11),pg_temp.id(1),pg_temp.id(32),pg_temp.id(22),pg_temp.id(21),pg_temp.id(41),repeat('a',64))->>'error'='dispatch_conflict','receipt lookup binds workload');
select pg_temp.ok(public.recover_assessment_dispatch(pg_temp.id(51),pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),null,pg_temp.id(21),pg_temp.id(41),repeat('a',64))->>'error'='dispatch_conflict','receipt lookup binds nullable estate');
select pg_temp.ok(public.recover_assessment_dispatch(pg_temp.id(51),pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(22),pg_temp.id(23),pg_temp.id(41),repeat('a',64))->>'error'='dispatch_conflict','receipt lookup binds engagement');
select pg_temp.ok(public.recover_assessment_dispatch(pg_temp.id(51),pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(22),pg_temp.id(21),pg_temp.id(42),repeat('a',64))->>'error'='dispatch_conflict','receipt lookup binds correlation');
select pg_temp.ok(pg_temp.enqueue(51,repeat('c',64))->>'error'='dispatch_conflict','different exact input cannot replace original');
reset role;
select pg_temp.ok((select count(*)=1 from public.assessment_dispatch_jobs where tenant_id=pg_temp.id(11)),'only one encrypted job');
select pg_temp.ok((select count(*)=1 from public.agent_runs where tenant_id=pg_temp.id(11)),'only one delegated run');
select pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type='assessment.requested'),'exactly one request receipt');
select pg_temp.ok((select actor_type='human' and actor_id=pg_temp.id(1)::text and input_hash=repeat('a',64) and target_ref=pg_temp.id(51)::text and result='pending' and approval_token_id is null and approver_id is null
 and detail->>'run_id'=(select value->>'run_id' from issued) and detail->>'workload_id'=pg_temp.id(31)::text and detail->>'engagement_id'=pg_temp.id(21)::text and detail->>'library_version'='human-enqueue-fixture-v1'
 and not(detail ?| array['answers','proof_hash','taskProof','nonce','ciphertext','wrapped_key','approval_token'])
 from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type='assessment.requested'),'request is exact-context hash proof without secrets or mutation approval');
select pg_temp.ok((select metadata->>'request_kind'='durable_assessment_v1' and metadata->>'assessment_request_receipt'=(select id::text from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type='assessment.requested') from public.agent_runs where tenant_id=pg_temp.id(11)),'run pins actual atomic request receipt');
create temporary table unchanged as select (select count(*) from public.audit_ledger where tenant_id=pg_temp.id(11)) rows,(select last_value from public.audit_ledger_id_seq) seq;
grant select on unchanged to human_action_writer,agent_ledger_writer;
create function pg_temp.forge_agent(kind public.actor_type,action public.ledger_action_type default 'assessment.requested') returns bigint language sql as $$select public.append_agent_ledger(pg_temp.id(11),pg_temp.id(41),kind,'untrusted-producer',null,null,null,action,pg_temp.id(51)::text,repeat('a',64),null,null,null,null,null,'pending','{}')$$;
create function pg_temp.forge_human() returns bigint language sql as $$select public.append_human_ledger(pg_temp.id(11),pg_temp.id(41),'human',pg_temp.id(1)::text,null,null,null,'assessment.requested',pg_temp.id(51)::text,repeat('a',64),null,null,null,null,null,'pending','{}')$$;
set local role agent_ledger_writer;
select pg_temp.reject('select pg_temp.forge_agent(''agent'')','42501');
select pg_temp.reject('select pg_temp.forge_agent(''system'')','42501');
-- Preserve every prior human-only producer fence through the append-only migration.
do $$declare action text; kind text; begin
 foreach action in array array['public_source.bound','agent.invocation.requested','agent.invocation.settled','classification.reviewed','policy.reviewed','ropa.recorded','policy.drafted','playbook.created','operator.request.cancelled','plan.rejected','plan.published','report.approved','report.rejected','report.released','evidence_pack.exported','approval.exported','approval.archive.reviewed','approval.archive.released','closure.pramaan.sealed','execution.kill_switch.released','user.role.changed','mfa.factor.activated','mfa.factor.revoked','tenant.invitation.accepted','breach.notification.reviewed','consent.withdrawn','consent.legal_hold.set'] loop
  foreach kind in array array['agent','system'] loop
   perform pg_temp.reject(format('select pg_temp.forge_agent(%L::public.actor_type,%L::public.ledger_action_type)',kind,action),'42501');
  end loop;
 end loop;
end $$;
reset role;
set local role human_action_writer;
select pg_temp.reject('select pg_temp.forge_human()','42501');
reset role;
select pg_temp.ok((select rows=(select count(*) from public.audit_ledger where tenant_id=pg_temp.id(11)) and seq=(select last_value from public.audit_ledger_id_seq) from unchanged),'generic producer refusals change neither ledger rows nor sequence');
savepoint expired;
update public.workload_task_delegations set created_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute' where tenant_id=pg_temp.id(11);
create temporary table deadline as select expires_at from public.workload_task_delegations where tenant_id=pg_temp.id(11);
set local role human_action_writer;
select pg_temp.ok(pg_temp.recover()->>'run_id'=(select value->>'run_id' from issued),'historical stable receipt remains recoverable');
reset role;
select pg_temp.ok((select expires_at=(select expires_at from deadline) from public.workload_task_delegations where tenant_id=pg_temp.id(11)),'historical retry does not renew task authority');
rollback to expired;
savepoint unconfigured_recovery;
delete from public.assessment_dispatch_key_policies where tenant_id=pg_temp.id(11);
set local role human_action_writer;
select pg_temp.ok(pg_temp.recover()=(select value from issued),'original receipt does not depend on current policy configuration');
reset role;
rollback to unconfigured_recovery;
savepoint demoted;
update public.tenant_users set role='viewer' where tenant_id=pg_temp.id(11);
set local role human_action_writer;
select pg_temp.ok(pg_temp.recover()->>'error'='forbidden','demotion blocks even stable privileged receipt recovery');
reset role;
rollback to demoted;
savepoint halted;
update public.kill_switch_state set engaged=true where scope_key='global';
set local role human_action_writer;
select pg_temp.ok(pg_temp.recover()->>'error'='kill_switch_engaged','kill switch refuses receipt recovery');
select pg_temp.ok(pg_temp.enqueue()->>'error'='kill_switch_engaged','kill switch refuses direct stable enqueue recovery');
select pg_temp.ok(pg_temp.enqueue(52)->>'error'='kill_switch_engaged','kill switch refuses new enqueue');
reset role;
rollback to halted;
create function pg_temp.fail_request() returns trigger language plpgsql as $$begin if new.action_type::text='assessment.requested' then raise exception 'synthetic human request audit failure'; end if; return new; end$$;
create trigger fail_request before insert on public.audit_ledger for each row execute function pg_temp.fail_request();
set local role human_action_writer;
select pg_temp.reject('select pg_temp.enqueue(52)','P0001');
reset role;
select pg_temp.ok((select count(*)=1 from public.agent_runs where tenant_id=pg_temp.id(11)) and (select count(*)=1 from public.workload_task_delegations where tenant_id=pg_temp.id(11)) and (select count(*)=1 from public.assessment_dispatch_jobs where tenant_id=pg_temp.id(11)),'human request failure rolls back run/task/job and metadata');
select pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type='workload.task_delegated') and (select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type='assessment.requested'),'human request failure leaves no orphan delegation/request proof');
drop trigger fail_request on public.audit_ledger;
select pg_temp.ok(has_function_privilege('service_role','public.claim_assessment_dispatch(uuid,uuid,integer,text)','execute') and has_function_privilege('axiom_assessment_controller','public.claim_assessment_dispatch(uuid,uuid,integer,text)','execute'),'claim retains independent producer/controller grants');
select pg_temp.ok(has_function_privilege('axiom_assessment_controller','public.confirm_workload_assessment(uuid,uuid)','execute'),'independent confirmation remains controller-owned');
rollback;
