begin;
create function pg_temp.id(n int) returns uuid language sql immutable as $$select ('79790000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m; end if; end$$;
create function pg_temp.reject(q text,code text) returns void language plpgsql as $$begin begin execute q; exception when others then if sqlstate=code then return; end if; raise; end; raise exception 'Unexpected success'; end$$;
insert into auth.users(id,email) values(pg_temp.id(1),'reviewed-source-fixture@test.invalid');
insert into public.users(id,email) values(pg_temp.id(1),'reviewed-source-fixture@test.invalid');
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'reviewed-source-fixture','Worker fixture');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(1),'owner');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('reviewed-source-fixture-v1',now(),'test','Synthetic fixture',2);
insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version)
 select 'WA-'||n,'reviewed-source-fixture-v1','Fixture','Fixture','SEC','low','[]','[]','[]','{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":1000000}','{}','reviewed-source-fixture-v1' from generate_series(1,2) n;
insert into public.estates(id,tenant_id,name,slug) values(pg_temp.id(22),pg_temp.id(11),'Synthetic estate','synthetic');
insert into public.engagements(id,tenant_id,estate_id,library_version,title) values(pg_temp.id(21),pg_temp.id(11),pg_temp.id(22),'reviewed-source-fixture-v1','New assessment');
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status)
 values(pg_temp.id(31),pg_temp.id(11),'parikshan','spiffe://axiom.test/parikshan','active');


create temporary table policy(value jsonb);
grant select on policy to human_action_writer,service_role,agent_ledger_writer;
grant insert on policy to human_action_writer;
create function pg_temp.enqueue(job int default 51, hash text default repeat('a',64), rev integer default 1, fp text default null, expected_library text default 'reviewed-source-fixture-v1') returns jsonb language sql as $$
 select public.enqueue_reviewed_assessment_dispatch(pg_temp.id(job),pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(22),pg_temp.id(21),pg_temp.id(41),hash,encode(sha256(convert_to(job::text,'UTF8')),'hex'),clock_timestamp()+interval '5 minutes',
 'arn:aws:kms:ap-south-1:123456789012:key/'||pg_temp.id(61)::text,decode(repeat('ab',12),'hex'),decode(repeat('ab',100),'hex'),decode(repeat('cd',32),'hex'),rev,coalesce(fp,(select value->>'fingerprint' from policy)), expected_library, (select value->>'digest' from policy))$$;
create function pg_temp.recover(job int default 51, hash text default repeat('a',64)) returns jsonb language sql as $$
 select public.recover_assessment_dispatch(pg_temp.id(job),pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(22),pg_temp.id(21),pg_temp.id(41),hash)$$;
select pg_temp.ok(encode(sha256(convert_to(controller_security.canonical_questionnaire_json('{"libraryVersion": "reviewed-source-fixture-v1", "controls": [{"id": "WA-1", "title": "Fixture", "questions": []}, {"id": "WA-2", "title": "Fixture", "questions": []}]}'::jsonb),'UTF8')),'hex')='f91b195aaaf22a8b825589fb5949b69bb0bf3586a96b41f456ccb29b7c03685e','TS canonical ordered projection digest exact');
select pg_temp.ok(controller_security.canonical_questionnaire_json('{"prompt":" spaced  déclaration \n \"quoted\" ","id":"Q"}'::jsonb)='{"id":"Q","prompt":" spaced  déclaration \n \"quoted\" "}','canonical Unicode whitespace and escapes preserve values');
do $$declare r text; begin foreach r in array array['service_role','anon','authenticated','agent_ledger_writer','axiom_assessment_controller'] loop
 perform pg_temp.ok(not has_function_privilege(r,'public.enqueue_reviewed_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text,text,text)','execute'),'reviewed enqueue role refused '||r);
end loop; end$$;
select pg_temp.reject('select pg_temp.enqueue()','42501');
set local role service_role;
select pg_temp.reject('select pg_temp.enqueue()','42501');
reset role;
set local role human_action_writer;
insert into policy select public.publish_assessment_dispatch_key_policy(pg_temp.id(11),pg_temp.id(1),pg_temp.id(41),0,'aws','arn:aws:kms:ap-south-1:123456789012:key/'||pg_temp.id(61)::text,array['arn:aws:kms:ap-south-1:123456789012:key/'||pg_temp.id(61)::text])||jsonb_build_object('digest','f91b195aaaf22a8b825589fb5949b69bb0bf3586a96b41f456ccb29b7c03685e');
reset role;
update policy set value=jsonb_set(value,'{digest}',to_jsonb(repeat('f',64)));
set local role human_action_writer;
select pg_temp.ok(pg_temp.enqueue()->>'error'='questionnaire_source_changed','changed review digest refused before dispatch');
reset role;
update policy set value=jsonb_set(value,'{digest}',to_jsonb('f91b195aaaf22a8b825589fb5949b69bb0bf3586a96b41f456ccb29b7c03685e'::text));
savepoint changed_pin;
insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values('reviewed-source-other',now(),'test','fixture',2);
select pg_temp.reject('update public.engagements set library_version=''reviewed-source-other'' where id=pg_temp.id(21)','23514');
set local role human_action_writer;
select pg_temp.ok(pg_temp.enqueue(51,repeat('a',64),1,null,'reviewed-source-other')->>'error'='questionnaire_source_changed','mismatched reviewed library refused independently of immutable pin');
reset role;
select pg_temp.ok((select count(*)=0 from public.assessment_dispatch_jobs where tenant_id=pg_temp.id(11)),'refusal left no outbox or dispatch');
rollback to changed_pin;
set local role human_action_writer;
create temporary table issued as select pg_temp.enqueue() value;
select pg_temp.ok((select value ? 'run_id' from issued),'matching canonical reviewed source dispatches');
select pg_temp.ok(pg_temp.enqueue()=(select value from issued),'same reviewed request recovers exact original receipt');
select pg_temp.ok(pg_temp.recover()->>'error'='dispatch_conflict','dropped expected metadata cannot recover guarded receipt');
select pg_temp.ok(public.recover_reviewed_assessment_dispatch(pg_temp.id(51),pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(22),pg_temp.id(21),pg_temp.id(41),repeat('a',64),'reviewed-source-fixture-v1',repeat('f',64))->>'error'='dispatch_conflict','changed review digest cannot recover same worker hash');
select pg_temp.ok(public.enqueue_assessment_dispatch(pg_temp.id(51),pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(22),pg_temp.id(21),pg_temp.id(41),repeat('a',64),repeat('b',64),now()+interval '5 minutes','fixture',decode(repeat('ab',12),'hex'),decode(repeat('ab',100),'hex'),decode(repeat('cd',32),'hex'),1,repeat('f',64))->>'error'='dispatch_conflict','legacy enqueue cannot bypass original reviewed body');
reset role;
select pg_temp.ok((select not rolbypassrls from pg_roles where rolname='service_role'),'ordinary service role has no RLS bypass');
update public.users set is_axiom_internal=true where id=pg_temp.id(1);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.id(1),'role','service_role')::text,true);
set local role service_role;
select pg_temp.reject('delete from public.controls where library_version=''reviewed-source-fixture-v1''','42501');
reset role;
select pg_temp.reject('delete from public.controls where library_version=''reviewed-source-fixture-v1''','42501');
select pg_temp.reject('insert into public.controls select ''EXTRA'',library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,tags,sdf_only,children_only,introduced_in_version,revised_in_version,notes,created_at from public.controls where library_version=''reviewed-source-fixture-v1'' limit 1','42501');
select pg_temp.reject('update public.control_libraries set control_count=3 where version=''reviewed-source-fixture-v1''','42501');
select pg_temp.reject('update public.control_libraries set status=''draft'' where version=''reviewed-source-fixture-v1''','42501');
select pg_temp.reject('delete from public.control_libraries where version=''reviewed-source-fixture-v1''','42501');
select pg_temp.reject('truncate public.controls cascade','42501');
update public.control_libraries set status='deprecated',is_current=false where version='reviewed-source-fixture-v1';
select pg_temp.reject('delete from public.controls where library_version=''reviewed-source-fixture-v1''','42501');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count,status) values('reviewed-source-draft',now(),'test','fixture',2,'draft');
select pg_temp.reject('update public.control_libraries set status=''published'' where version=''reviewed-source-draft''','42501');
insert into public.controls select id,'reviewed-source-draft',title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,tags,sdf_only,children_only,'reviewed-source-draft',revised_in_version,notes,created_at from public.controls where library_version='reviewed-source-fixture-v1';
update public.control_libraries set status='published' where version='reviewed-source-draft';
select pg_temp.reject('delete from public.controls where library_version=''reviewed-source-draft''','42501');
select pg_temp.reject('update public.engagements set library_version=''reviewed-source-draft'' where id=pg_temp.id(21)','23514');
set local role human_action_writer;
select pg_temp.ok(pg_temp.enqueue()=(select value from issued),'recorded reviewed receipt survives refused engagement repinning');
reset role;
select pg_temp.ok((select detail->'expected_questionnaire' = jsonb_build_object('libraryVersion','reviewed-source-fixture-v1','questionnaireDigest',(select value->>'digest' from policy)) from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type='assessment.requested'),'immutable receipt binds reviewed projection digest');
select pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type='assessment.requested'),'one human request receipt');
update public.engagements set library_version='reviewed-source-fixture-v1' where id=pg_temp.id(21);
create function pg_temp.fail_reviewed_request() returns trigger language plpgsql as $$begin if new.action_type::text='assessment.requested' then raise exception 'Synthetic reviewed audit failure'; end if; return new; end$$;
create trigger fail_reviewed_request before insert on public.audit_ledger for each row execute function pg_temp.fail_reviewed_request();
set local role human_action_writer;
select pg_temp.reject('select pg_temp.enqueue(52)','P0001');
reset role;
select pg_temp.ok((select count(*)=1 from public.assessment_dispatch_jobs where tenant_id=pg_temp.id(11)) and (select count(*)=1 from public.agent_runs where tenant_id=pg_temp.id(11)) and (select count(*)=1 from public.workload_task_delegations where tenant_id=pg_temp.id(11)),'reviewed receipt failure rolls back new run/task/outbox');
drop trigger fail_reviewed_request on public.audit_ledger;
rollback;
