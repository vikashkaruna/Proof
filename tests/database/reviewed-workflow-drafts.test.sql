-- New controlled synthetic fixture; no selected stack or customer data.
begin;
create function pg_temp.id(n integer) returns uuid language sql immutable as $$
 select ('99111800-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'ASSERTION: %',m;end if;end $$;
insert into auth.users(id,email) select pg_temp.id(n),'reviewed-draft-'||n||'@example.invalid' from generate_series(1,4)n;
insert into public.users(id,email,is_axiom_internal) select pg_temp.id(n),'reviewed-draft-'||n||'@example.invalid',n=3 from generate_series(1,4)n;
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'reviewed-draft-a','A'),(pg_temp.id(12),'reviewed-draft-b','B');
insert into public.tenant_users(tenant_id,user_id,role) values
 (pg_temp.id(11),pg_temp.id(1),'owner'),(pg_temp.id(11),pg_temp.id(2),'viewer'),
 (pg_temp.id(11),pg_temp.id(3),'founder'),(pg_temp.id(12),pg_temp.id(4),'owner');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('reviewed-draft-test',now(),'test','Synthetic only',0);
insert into public.engagements(id,tenant_id,library_version,title) values
 (pg_temp.id(31),pg_temp.id(11),'reviewed-draft-test','A'),(pg_temp.id(32),pg_temp.id(12),'reviewed-draft-test','B');
create temporary table reviewed_source_fixture(k text primary key,v jsonb);
grant select,insert on reviewed_source_fixture to human_action_writer;
set local role human_action_writer;
insert into reviewed_source_fixture values('ropa',public.record_operator_workflow(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),'ropa',
 jsonb_build_object('engagementId',pg_temp.id(31),'sourceNote','Human declaration; verification remains separate','system','Public contact form',
 'purpose',null,'legalBasis',null,'retentionMonths',null,'dataCategories',null,'processors','[]'::jsonb,
 'region',null,'crossBorder',false,'securityMeasures',null,'dataPrincipals',null,'recipients',null,
 'destinationCountries',null,'transferSafeguards',null,'dpiaRequired',null),pg_temp.id(201)));
insert into reviewed_source_fixture values('task',public.record_operator_workflow(pg_temp.id(11),pg_temp.id(3),pg_temp.id(102),'delivery_task',
 jsonb_build_object('engagementId',pg_temp.id(31),'taskName','Review inventory','source','Reported by operator',
 'durationMinutes',0,'repetitions',3,'notes','Instrumentation has not been verified'),pg_temp.id(202)));
reset role;
select pg_temp.ok((select bool_and(v?'data' and not(v?'error')) from reviewed_source_fixture),'real human writer created both sources');
create function pg_temp.records() returns text language sql stable as $$
 select jsonb_agg(v->'data' order by k)::text from reviewed_source_fixture where k in ('ropa','task') $$;
create function pg_temp.input(records text default pg_temp.records()) returns text language sql stable as $$
 select jsonb_build_object('schema_version',1,'mode','reviewed_workflow','tenant_id',pg_temp.id(11),
  'engagement_id',pg_temp.id(31),'records',records::jsonb,
  'source_records_sha256',encode(sha256(convert_to(records,'UTF8')),'hex'))::text $$;
create function pg_temp.valid(records text default pg_temp.records(),actor integer default 1,tenant integer default 11,eng integer default 31) returns boolean language sql as $$
 select controller_security.reviewed_workflow_source_valid(pg_temp.id(tenant),pg_temp.id(actor),pg_temp.id(eng),pg_temp.input(records),records) $$;
select pg_temp.ok(pg_temp.valid(),'authentic original human receipts accepted for current owner');
select pg_temp.ok(pg_temp.valid(actor=>3),'current internal founder can review other human declarations without changing origin');
select pg_temp.ok(not pg_temp.valid(actor=>2),'viewer lacks agent invocation authority');
select pg_temp.ok(not pg_temp.valid(actor=>4),'other tenant owner cannot invoke');
select pg_temp.ok(not pg_temp.valid(tenant=>12),'input tenant mismatch refused');
select pg_temp.ok(not pg_temp.valid(eng=>32),'engagement mismatch refused');
select pg_temp.ok(not pg_temp.valid('[]'),'empty source refused');
select pg_temp.ok(not pg_temp.valid((pg_temp.records()::jsonb||pg_temp.records()::jsonb)::text),'duplicate IDs keys receipts refused');
select pg_temp.ok(not pg_temp.valid(jsonb_set(pg_temp.records()::jsonb,'{1,created_by}',to_jsonb(pg_temp.id(1)::text))::text),'original creator cannot be relabelled');
select pg_temp.ok(not pg_temp.valid(jsonb_set(pg_temp.records()::jsonb,'{0,payload,crossBorder}','null')::text),'false must remain false');
select pg_temp.ok(not pg_temp.valid(jsonb_set(pg_temp.records()::jsonb,'{0,payload,processors}','null')::text),'explicit empty list cannot become unknown');
select pg_temp.ok(not pg_temp.valid(jsonb_set(pg_temp.records()::jsonb,'{0,payload,purpose}','"Invented purpose"')::text),'unknown declaration cannot become invented fact');
select pg_temp.ok(not pg_temp.valid(jsonb_set(pg_temp.records()::jsonb,'{1,receipt_id}','"999999"')::text),'receipt identity must match source');
select pg_temp.ok(not pg_temp.valid(jsonb_set(pg_temp.records()::jsonb,'{1,payload,durationMinutes}','30')::text),'reported zero remains zero');
select pg_temp.ok(not controller_security.reviewed_workflow_source_valid(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),
 jsonb_set(pg_temp.input()::jsonb,'{source_records_sha256}',to_jsonb(repeat('a',64)))::text,pg_temp.records()),'exact source bytes checksum required');
select pg_temp.ok(not controller_security.reviewed_workflow_source_valid(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),
 (pg_temp.input()::jsonb||'{"publication_allowed":true}'::jsonb)::text,pg_temp.records()),'unknown transport authority key refused');
select pg_temp.ok(not controller_security.reviewed_workflow_source_valid(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),
 jsonb_set(pg_temp.input()::jsonb,'{schema_version}','true')::text,pg_temp.records()),'Boolean schema version refused');
select pg_temp.ok(not controller_security.reviewed_workflow_source_valid(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),'{}','{'),'malformed records refused without writes');
grant select,insert on reviewed_source_fixture to agent_ledger_writer;
set local role human_action_writer;
insert into reviewed_source_fixture values('dispatch',public.start_reviewed_workflow_dispatch(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(301),pg_temp.input(),pg_temp.records()));
select pg_temp.ok((select v->'created'='true'::jsonb and v->>'status'='running' from reviewed_source_fixture where k='dispatch'),'human request and retained snapshot atomically recorded');
reset role;
set local role human_action_writer;
select pg_temp.ok(public.start_reviewed_workflow_dispatch(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(301),pg_temp.input(),pg_temp.records())->'created'='false'::jsonb,'exact replay cannot dispatch twice');
select pg_temp.ok(public.start_reviewed_workflow_dispatch(pg_temp.id(11),pg_temp.id(3),pg_temp.id(31),pg_temp.id(301),pg_temp.input(),pg_temp.records())->>'error'='dispatch_conflict','other authorized actor cannot recover original request');
select pg_temp.ok(public.start_reviewed_workflow_dispatch(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(301),pg_temp.input(pg_temp.records()||' '),pg_temp.records()||' ')->>'error'='dispatch_conflict','changed exact source bytes cannot replay');
reset role;
create function pg_temp.run_id() returns uuid language sql stable as $$select (v->>'run_id')::uuid from reviewed_source_fixture where k='dispatch'$$;
set local role agent_ledger_writer;
select pg_temp.ok(public.read_reviewed_workflow_dispatch(pg_temp.id(11),pg_temp.run_id(),pg_temp.id(301))->>'input_text'=pg_temp.input(),'restricted transport reads exact original input');
select pg_temp.ok(public.read_reviewed_workflow_dispatch(pg_temp.id(12),pg_temp.run_id(),pg_temp.id(301))->>'error'='reviewed_source_refused','transport tenant mismatch refused');
select pg_temp.ok(public.read_reviewed_workflow_dispatch(pg_temp.id(11),pg_temp.run_id(),pg_temp.id(302))->>'error'='reviewed_source_refused','transport operation mismatch refused');
select pg_temp.ok(public.claim_reviewed_workflow_dispatch(pg_temp.id(11),pg_temp.run_id(),pg_temp.id(301),repeat('a',64))->>'error'='reviewed_source_refused','changed claim hash refused');
select pg_temp.ok(public.claim_reviewed_workflow_dispatch(pg_temp.id(11),pg_temp.run_id(),pg_temp.id(301),encode(sha256(convert_to(pg_temp.input(),'UTF8')),'hex'))->'claimed'='true'::jsonb,'one genuine stored request claimed');
select pg_temp.ok(public.claim_reviewed_workflow_dispatch(pg_temp.id(11),pg_temp.run_id(),pg_temp.id(301),encode(sha256(convert_to(pg_temp.input(),'UTF8')),'hex'))->'claimed'='false'::jsonb,'uncertain prior claim never grants second execution');
reset role;
select pg_temp.ok((select count(*)=1 from public.reviewed_workflow_dispatch_claims where run_id=pg_temp.run_id()),'only one immutable claim retained');
select pg_temp.ok((select count(*)=1 from public.reviewed_workflow_dispatches where run_id=pg_temp.run_id()),'one immutable source snapshot retained');
select pg_temp.ok((select bool_and(not has_table_privilege(r,'public.reviewed_workflow_dispatches','INSERT') and not has_table_privilege(r,'public.reviewed_workflow_dispatch_claims','INSERT')) from unnest(array['anon','authenticated','service_role','human_action_writer','agent_ledger_writer'])r),'no role may forge source snapshots or claims');
select pg_temp.ok(not has_function_privilege('agent_ledger_writer','public.start_reviewed_workflow_dispatch(uuid,uuid,uuid,uuid,text,text)','EXECUTE'),'runtime cannot impersonate human request');
select pg_temp.ok(not has_function_privilege('human_action_writer','public.claim_reviewed_workflow_dispatch(uuid,uuid,uuid,text)','EXECUTE'),'human writer cannot execute runtime claim');
create function pg_temp.h() returns text language sql stable as $$select encode(sha256(convert_to(pg_temp.input(),'UTF8')),'hex')$$;
create function pg_temp.output() returns text language sql stable security definer as $$select controller_security.reviewed_workflow_expected_output(pg_temp.input())::text$$;
create function pg_temp.oh(output text default pg_temp.output()) returns text language sql immutable as $$select encode(sha256(convert_to(output,'UTF8')),'hex')$$;
create temporary table reviewed_receipts(k text primary key,id text);
grant select,insert on reviewed_receipts to agent_ledger_writer,human_action_writer;
grant execute on function pg_temp.output() to agent_ledger_writer,human_action_writer;
set local role agent_ledger_writer;
insert into reviewed_receipts values('started',public.append_agent_ledger(pg_temp.id(11),pg_temp.id(301),'agent','vibhaag','0.1.0',null,null,
 'classification.started',pg_temp.id(31)::text,pg_temp.h(),null,null,null,null,null,'pending',
 jsonb_build_object('phase','started','run_id',pg_temp.run_id(),'request_hash',pg_temp.h()))::text);
insert into reviewed_receipts values('completed',public.append_agent_ledger(pg_temp.id(11),pg_temp.id(301),'agent','vibhaag','0.1.0',null,null,
 'classification.started',pg_temp.id(31)::text,pg_temp.h(),pg_temp.oh(),null,null,null,null,'success',
 jsonb_build_object('phase','completed','run_id',pg_temp.run_id(),'request_hash',pg_temp.h(),
 'started_entry',(select id from reviewed_receipts where k='started')))::text);
reset role;
create function pg_temp.settle(output text default pg_temp.output(),actor integer default 1) returns jsonb language sql as $$
 select public.settle_reviewed_workflow_output(pg_temp.id(11),pg_temp.id(actor),pg_temp.run_id(),pg_temp.id(31),pg_temp.id(301),
 pg_temp.h(),pg_temp.input(),output,pg_temp.oh(output),1,0,0,0,
 (select id from reviewed_receipts where k='started'),(select id from reviewed_receipts where k='completed'))$$;
set local role human_action_writer;
select pg_temp.ok(pg_temp.settle(actor=>3)->>'error'='output_context_refused','other actor cannot settle original request');
select pg_temp.ok(pg_temp.settle(jsonb_set(pg_temp.output()::jsonb,'{policy_drafts,0,content}',to_jsonb('Invented legal compliant facts'::text))::text)->>'error'='output_context_refused','policy claims must match exact deterministic source output');
select pg_temp.ok(pg_temp.settle(jsonb_set(pg_temp.output()::jsonb,'{processing_reviews,0,declarations,crossBorder}','null')::text)->>'error'='output_context_refused','output cannot relabel recorded false');
select pg_temp.ok(pg_temp.settle(jsonb_set(pg_temp.output()::jsonb,'{playbook_reviews,0,measurement_status}','"verified"')::text)->>'error'='output_context_refused','reported task cannot masquerade as instrumented measurement');
select pg_temp.ok(pg_temp.settle()->>'status'='succeeded','ordered runtime receipts atomically settle and capture exact review output');
select pg_temp.ok(pg_temp.settle()->'replayed'='true'::jsonb,'exact settlement replay captures no duplicate output');
select pg_temp.ok(public.recover_reviewed_workflow_output(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(301),pg_temp.input())->>'output_text'=pg_temp.output(),'lost successful response recovers exact stored output without redispatch');
select pg_temp.ok(public.recover_reviewed_workflow_output(pg_temp.id(11),pg_temp.id(3),pg_temp.id(31),pg_temp.id(301),pg_temp.input())->>'error'='output_context_refused','other actor cannot recover original output');
select pg_temp.ok(public.recover_reviewed_workflow_output(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(301),pg_temp.input()||' ')->>'error'='output_context_refused','changed exact original input cannot recover output');
reset role;
select pg_temp.ok((select count(*)=1 from public.reviewed_workflow_settled_outputs where run_id=pg_temp.run_id()),'one immutable exact output captured');
select pg_temp.ok((select bool_and(not has_table_privilege(r,'public.reviewed_workflow_settled_outputs','INSERT')) from unnest(array['anon','authenticated','service_role','human_action_writer','agent_ledger_writer'])r),'no direct output import writer');
select pg_temp.ok(not has_function_privilege('agent_ledger_writer','public.settle_reviewed_workflow_output(uuid,uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,integer,numeric,text,text)','EXECUTE'),'runtime cannot controller-settle or import output');
create function pg_temp.body(index integer default null,reason text default 'Reviewed human declarations; legal approval remains separate') returns text language sql stable as $$
 select jsonb_build_object('runId',pg_temp.run_id(),'outputHash',pg_temp.oh(),'policyIndex',index,'reason',reason,'confirmReview',true)::text$$;
create function pg_temp.ack(op integer,index integer default null,actor integer default 1,body text default null) returns jsonb language sql as $$
 select public.acknowledge_reviewed_workflow_output(pg_temp.id(11),pg_temp.id(actor),pg_temp.id(31),pg_temp.id(301),pg_temp.input(),pg_temp.id(op),coalesce(body,pg_temp.body(index)))$$;
set local role human_action_writer;
select pg_temp.ok(public.recover_reviewed_workflow_acknowledgement(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(301),pg_temp.input(),pg_temp.id(499),pg_temp.body())->'missing'='true'::jsonb,'read-only missing acknowledgement does not save a human decision');
reset role;
select pg_temp.ok((select count(*)=0 from public.reviewed_workflow_acknowledgements where tenant_id=pg_temp.id(11)),'read-only missing acknowledgement leaves immutable table empty');
set local role human_action_writer;
insert into reviewed_source_fixture values('ack',pg_temp.ack(401));
select pg_temp.ok((select v?'acknowledgement_id' and v->'policy_draft_id'='null'::jsonb and v->'replayed'='false'::jsonb from reviewed_source_fixture where k='ack'),'separate human acknowledgement saves review artifact without duplicating original source');
select pg_temp.ok(pg_temp.ack(401)->'replayed'='true'::jsonb,'lost acknowledgement response recovers same receipt');
select pg_temp.ok(pg_temp.ack(401,0)->>'error'='acknowledgement_conflict','same acknowledgement key cannot become policy adoption');
select pg_temp.ok(pg_temp.ack(401,actor=>3)->>'error'='output_proof_refused','changed actor cannot recover acknowledgement');
select pg_temp.ok(pg_temp.ack(402,body=>jsonb_set(pg_temp.body()::jsonb,'{confirmReview}','false')::text)->>'error'='invalid_acknowledgement','explicit human confirmation required');
select pg_temp.ok(pg_temp.ack(402,body=>jsonb_set(pg_temp.body()::jsonb,'{outputHash}',to_jsonb(repeat('f',64)))::text)->>'error'='output_proof_refused','changed output cannot be acknowledged');
select pg_temp.ok(pg_temp.ack(402,79)->>'error'='invalid_acknowledgement','unproduced policy index refused');
insert into reviewed_source_fixture values('adoption',pg_temp.ack(403,0));
select pg_temp.ok((select v->>'policy_draft_id' is not null and v->'replayed'='false'::jsonb from reviewed_source_fixture where k='adoption'),'explicit selected genuine policy adopted only as new unpublished human draft');
select pg_temp.ok(pg_temp.ack(403,0)->'replayed'='true'::jsonb,'policy lost response recover does not duplicate domain records');
select pg_temp.ok(pg_temp.ack(403,1)->>'error'='acknowledgement_conflict','changed selected policy cannot reuse operation');
select pg_temp.ok(public.recover_reviewed_workflow_acknowledgement(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(301),pg_temp.input(),pg_temp.id(403),pg_temp.body(0))->'manifest'->>'initialPolicyStatus'='draft','read-only lost policy response confirms original initial draft');
select pg_temp.ok(public.recover_reviewed_workflow_acknowledgement(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(301),pg_temp.input(),pg_temp.id(403),pg_temp.body(1))->>'error'='acknowledgement_conflict','read-only altered selection cannot recover human decision');
insert into reviewed_source_fixture values('policy_review',public.record_operator_workflow(pg_temp.id(11),pg_temp.id(3),pg_temp.id(404),'policy_review',
 jsonb_build_object('draftId',(select v->>'policy_draft_id' from reviewed_source_fixture where k='adoption'),
 'expectedHash',encode(sha256(convert_to(pg_temp.output()::jsonb#>>'{policy_drafts,0,content}','UTF8')),'hex'),
 'decision','approved','reason','Separate recorded legal review'),pg_temp.id(404)));
select pg_temp.ok((select v?'data' and not(v?'error') from reviewed_source_fixture where k='policy_review'),'separate current internal founder review uses existing policy workflow');
select pg_temp.ok(public.recover_reviewed_workflow_acknowledgement(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(301),pg_temp.input(),pg_temp.id(403),pg_temp.body(0))->'manifest' @> '{"initialPolicyStatus":"draft","currentPolicyStatus":"approved"}'::jsonb,'historical acknowledgement remains recoverable while reporting current approved status honestly');

reset role;
select pg_temp.ok((select count(*)=2 from public.reviewed_workflow_acknowledgements where tenant_id=pg_temp.id(11)),'acknowledgement and policy adoption are independently recorded');
select pg_temp.ok((select count(*)=4 from public.operator_workflow_records where tenant_id=pg_temp.id(11)),'only one new policy added; original RoPA/task not duplicated');
select pg_temp.ok((select count(*)=1 from public.policy_drafts where tenant_id=pg_temp.id(11) and status='approved'),'separate human review only approves original saved policy; no publication');
select pg_temp.ok((select bool_and(created_by=pg_temp.id(case when kind='ropa' then 1 else 3 end)) from public.operator_workflow_records where tenant_id=pg_temp.id(11) and kind in ('ropa','delivery_task')),'original human creators retained');
select pg_temp.ok((select payload->>'content'=pg_temp.output()::jsonb#>>'{policy_drafts,0,content}' and payload->>'sourceNote'=(select v#>>'{data,payload,sourceNote}' from reviewed_source_fixture where k='ropa') from public.operator_workflow_records where id=(select (v->>'policy_draft_id')::uuid from reviewed_source_fixture where k='adoption')),'adopted exact source-bound content and original note retained');
create function pg_temp.forgery(agent boolean default false) returns void language plpgsql as $$
begin
 begin
  if agent then
   perform public.append_agent_ledger(pg_temp.id(11),pg_temp.id(499),'system','forger',null,null,null,'classification.reviewed','fake',null,null,null,null,null,null,'success','{"purpose":"reviewed_workflow_acknowledgement"}');
  else
   perform public.append_human_ledger(pg_temp.id(11),pg_temp.id(499),'human',pg_temp.id(1)::text,null,null,null,'classification.reviewed','fake',null,null,null,null,null,null,'success','{"purpose":"reviewed_workflow_acknowledgement"}');
  end if;
 exception when insufficient_privilege then return;end;
 raise exception 'ASSERTION: generic append forged reserved acknowledgement';
end $$;
set local role human_action_writer;
select pg_temp.forgery();
reset role;
set local role agent_ledger_writer;
select pg_temp.forgery(true);
reset role;
update public.policy_drafts set content=content||'Changed without retained revision' where id=(select (v->>'policy_draft_id')::uuid from reviewed_source_fixture where k='adoption');
set local role human_action_writer;
select pg_temp.ok(public.recover_reviewed_workflow_acknowledgement(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(301),pg_temp.input(),pg_temp.id(403),pg_temp.body(0))->>'error'='policy_state_changed','historical recovery cannot silently substitute changed policy content');
reset role;
select pg_temp.ok((select bool_and(not has_function_privilege(r,'public.acknowledge_reviewed_workflow_output(uuid,uuid,uuid,uuid,text,uuid,text)','EXECUTE') and not has_table_privilege(r,'public.reviewed_workflow_acknowledgements','INSERT')) from unnest(array['anon','authenticated','service_role','agent_ledger_writer'])r),'no producer/direct service acknowledgement grant');
update public.tenant_users set role='viewer' where tenant_id=pg_temp.id(11) and user_id=pg_temp.id(1);
select pg_temp.ok(not pg_temp.valid(),'current role revocation overrides original receipt');
update public.tenant_users set role='owner' where tenant_id=pg_temp.id(11) and user_id=pg_temp.id(1);
update public.users set is_axiom_internal=false where id=pg_temp.id(3);
select pg_temp.ok(not pg_temp.valid(actor=>3),'current founder flag required');
update public.users set is_axiom_internal=true where id=pg_temp.id(3);
update public.kill_switch_state set engaged=true where scope_key='global';
select pg_temp.ok(not pg_temp.valid(),'global kill refuses source dispatch');
update public.kill_switch_state set engaged=false where scope_key='global';
update public.engagements set status='cancelled' where id=pg_temp.id(31);
select pg_temp.ok(not pg_temp.valid(),'cancelled engagement refused');
select pg_temp.ok((select count(*)=10 from public.audit_ledger where tenant_id=pg_temp.id(11)),'source validation creates no receipts or domain records');
select pg_temp.ok((select count(*)=4 from public.operator_workflow_records where tenant_id=pg_temp.id(11)),'no duplicate original facts or measurements');
select pg_temp.ok((select bool_and(not has_function_privilege(r,'controller_security.reviewed_workflow_source_valid(uuid,uuid,uuid,text,text)','EXECUTE'))
 from unnest(array['anon','authenticated','service_role','human_action_writer','agent_ledger_writer','axiom_assessment_controller'])r),'private verifier grants no direct producer or caller authority');
rollback;
