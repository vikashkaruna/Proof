begin;
create schema reviewed_draft_races;grant usage on schema reviewed_draft_races to human_action_writer,agent_ledger_writer;
-- New controlled synthetic fixture; no selected stack or customer data.

create function reviewed_draft_races.id(n integer) returns uuid language sql immutable as $$
 select ('99311800-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
create function reviewed_draft_races.ok(v boolean,m text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'ASSERTION: %',m;end if;end $$;
insert into auth.users(id,email) select reviewed_draft_races.id(n),'reviewed-race-'||n||'@example.invalid' from generate_series(1,4)n;
insert into public.users(id,email,is_axiom_internal) select reviewed_draft_races.id(n),'reviewed-race-'||n||'@example.invalid',n=3 from generate_series(1,4)n;
insert into public.tenants(id,slug,name) values(reviewed_draft_races.id(11),'reviewed-race-a','A'),(reviewed_draft_races.id(12),'reviewed-race-b','B');
insert into public.tenant_users(tenant_id,user_id,role) values
 (reviewed_draft_races.id(11),reviewed_draft_races.id(1),'owner'),(reviewed_draft_races.id(11),reviewed_draft_races.id(2),'viewer'),
 (reviewed_draft_races.id(11),reviewed_draft_races.id(3),'founder'),(reviewed_draft_races.id(12),reviewed_draft_races.id(4),'owner');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('reviewed-race-test',now(),'test','Synthetic only',0);
insert into public.engagements(id,tenant_id,library_version,title) values
 (reviewed_draft_races.id(31),reviewed_draft_races.id(11),'reviewed-race-test','A'),(reviewed_draft_races.id(32),reviewed_draft_races.id(12),'reviewed-race-test','B');
create table reviewed_draft_races.fixture(k text primary key,v jsonb);
grant select,insert on reviewed_draft_races.fixture to human_action_writer;
set local role human_action_writer;
insert into reviewed_draft_races.fixture values('ropa',public.record_operator_workflow(reviewed_draft_races.id(11),reviewed_draft_races.id(1),reviewed_draft_races.id(101),'ropa',
 jsonb_build_object('engagementId',reviewed_draft_races.id(31),'sourceNote','Human declaration; verification remains separate','system','Public contact form',
 'purpose',null,'legalBasis',null,'retentionMonths',null,'dataCategories',null,'processors','[]'::jsonb,
 'region',null,'crossBorder',false,'securityMeasures',null,'dataPrincipals',null,'recipients',null,
 'destinationCountries',null,'transferSafeguards',null,'dpiaRequired',null),reviewed_draft_races.id(201)));
insert into reviewed_draft_races.fixture values('task',public.record_operator_workflow(reviewed_draft_races.id(11),reviewed_draft_races.id(3),reviewed_draft_races.id(102),'delivery_task',
 jsonb_build_object('engagementId',reviewed_draft_races.id(31),'taskName','Review inventory','source','Reported by operator',
 'durationMinutes',0,'repetitions',3,'notes','Instrumentation has not been verified'),reviewed_draft_races.id(202)));
reset role;
select reviewed_draft_races.ok((select bool_and(v?'data' and not(v?'error')) from reviewed_draft_races.fixture),'real human writer created both sources');
create function reviewed_draft_races.records() returns text language sql stable as $$
 select jsonb_agg(v->'data' order by k)::text from reviewed_draft_races.fixture where k in ('ropa','task') $$;
create function reviewed_draft_races.input(records text default reviewed_draft_races.records()) returns text language sql stable as $$
 select jsonb_build_object('schema_version',1,'mode','reviewed_workflow','tenant_id',reviewed_draft_races.id(11),
  'engagement_id',reviewed_draft_races.id(31),'records',records::jsonb,
  'source_records_sha256',encode(sha256(convert_to(records,'UTF8')),'hex'))::text $$;
create function reviewed_draft_races.valid(records text default reviewed_draft_races.records(),actor integer default 1,tenant integer default 11,eng integer default 31) returns boolean language sql as $$
 select controller_security.reviewed_workflow_source_valid(reviewed_draft_races.id(tenant),reviewed_draft_races.id(actor),reviewed_draft_races.id(eng),reviewed_draft_races.input(records),records) $$;
select reviewed_draft_races.ok(reviewed_draft_races.valid(),'authentic original human receipts accepted for current owner');
select reviewed_draft_races.ok(reviewed_draft_races.valid(actor=>3),'current internal founder can review other human declarations without changing origin');
select reviewed_draft_races.ok(not reviewed_draft_races.valid(actor=>2),'viewer lacks agent invocation authority');
select reviewed_draft_races.ok(not reviewed_draft_races.valid(actor=>4),'other tenant owner cannot invoke');
select reviewed_draft_races.ok(not reviewed_draft_races.valid(tenant=>12),'input tenant mismatch refused');
select reviewed_draft_races.ok(not reviewed_draft_races.valid(eng=>32),'engagement mismatch refused');
select reviewed_draft_races.ok(not reviewed_draft_races.valid('[]'),'empty source refused');
select reviewed_draft_races.ok(not reviewed_draft_races.valid((reviewed_draft_races.records()::jsonb||reviewed_draft_races.records()::jsonb)::text),'duplicate IDs keys receipts refused');
select reviewed_draft_races.ok(not reviewed_draft_races.valid(jsonb_set(reviewed_draft_races.records()::jsonb,'{1,created_by}',to_jsonb(reviewed_draft_races.id(1)::text))::text),'original creator cannot be relabelled');
select reviewed_draft_races.ok(not reviewed_draft_races.valid(jsonb_set(reviewed_draft_races.records()::jsonb,'{0,payload,crossBorder}','null')::text),'false must remain false');
select reviewed_draft_races.ok(not reviewed_draft_races.valid(jsonb_set(reviewed_draft_races.records()::jsonb,'{0,payload,processors}','null')::text),'explicit empty list cannot become unknown');
select reviewed_draft_races.ok(not reviewed_draft_races.valid(jsonb_set(reviewed_draft_races.records()::jsonb,'{0,payload,purpose}','"Invented purpose"')::text),'unknown declaration cannot become invented fact');
select reviewed_draft_races.ok(not reviewed_draft_races.valid(jsonb_set(reviewed_draft_races.records()::jsonb,'{1,receipt_id}','"999999"')::text),'receipt identity must match source');
select reviewed_draft_races.ok(not reviewed_draft_races.valid(jsonb_set(reviewed_draft_races.records()::jsonb,'{1,payload,durationMinutes}','30')::text),'reported zero remains zero');
select reviewed_draft_races.ok(not controller_security.reviewed_workflow_source_valid(reviewed_draft_races.id(11),reviewed_draft_races.id(1),reviewed_draft_races.id(31),
 jsonb_set(reviewed_draft_races.input()::jsonb,'{source_records_sha256}',to_jsonb(repeat('a',64)))::text,reviewed_draft_races.records()),'exact source bytes checksum required');
select reviewed_draft_races.ok(not controller_security.reviewed_workflow_source_valid(reviewed_draft_races.id(11),reviewed_draft_races.id(1),reviewed_draft_races.id(31),
 (reviewed_draft_races.input()::jsonb||'{"publication_allowed":true}'::jsonb)::text,reviewed_draft_races.records()),'unknown transport authority key refused');
select reviewed_draft_races.ok(not controller_security.reviewed_workflow_source_valid(reviewed_draft_races.id(11),reviewed_draft_races.id(1),reviewed_draft_races.id(31),
 jsonb_set(reviewed_draft_races.input()::jsonb,'{schema_version}','true')::text,reviewed_draft_races.records()),'Boolean schema version refused');
select reviewed_draft_races.ok(not controller_security.reviewed_workflow_source_valid(reviewed_draft_races.id(11),reviewed_draft_races.id(1),reviewed_draft_races.id(31),'{}','{'),'malformed records refused without writes');
grant select,insert on reviewed_draft_races.fixture to agent_ledger_writer;
set local role human_action_writer;
insert into reviewed_draft_races.fixture values('dispatch',public.start_reviewed_workflow_dispatch(reviewed_draft_races.id(11),reviewed_draft_races.id(1),reviewed_draft_races.id(31),reviewed_draft_races.id(301),reviewed_draft_races.input(),reviewed_draft_races.records()));
select reviewed_draft_races.ok((select v->'created'='true'::jsonb and v->>'status'='running' from reviewed_draft_races.fixture where k='dispatch'),'human request and retained snapshot atomically recorded');
reset role;
set local role human_action_writer;
select reviewed_draft_races.ok(public.start_reviewed_workflow_dispatch(reviewed_draft_races.id(11),reviewed_draft_races.id(1),reviewed_draft_races.id(31),reviewed_draft_races.id(301),reviewed_draft_races.input(),reviewed_draft_races.records())->'created'='false'::jsonb,'exact replay cannot dispatch twice');
select reviewed_draft_races.ok(public.start_reviewed_workflow_dispatch(reviewed_draft_races.id(11),reviewed_draft_races.id(3),reviewed_draft_races.id(31),reviewed_draft_races.id(301),reviewed_draft_races.input(),reviewed_draft_races.records())->>'error'='dispatch_conflict','other authorized actor cannot recover original request');
select reviewed_draft_races.ok(public.start_reviewed_workflow_dispatch(reviewed_draft_races.id(11),reviewed_draft_races.id(1),reviewed_draft_races.id(31),reviewed_draft_races.id(301),reviewed_draft_races.input(reviewed_draft_races.records()||' '),reviewed_draft_races.records()||' ')->>'error'='dispatch_conflict','changed exact source bytes cannot replay');
reset role;
create function reviewed_draft_races.run_id() returns uuid language sql stable as $$select (v->>'run_id')::uuid from reviewed_draft_races.fixture where k='dispatch'$$;
set local role agent_ledger_writer;
select reviewed_draft_races.ok(public.read_reviewed_workflow_dispatch(reviewed_draft_races.id(11),reviewed_draft_races.run_id(),reviewed_draft_races.id(301))->>'input_text'=reviewed_draft_races.input(),'restricted transport reads exact original input');
select reviewed_draft_races.ok(public.read_reviewed_workflow_dispatch(reviewed_draft_races.id(12),reviewed_draft_races.run_id(),reviewed_draft_races.id(301))->>'error'='reviewed_source_refused','transport tenant mismatch refused');
select reviewed_draft_races.ok(public.read_reviewed_workflow_dispatch(reviewed_draft_races.id(11),reviewed_draft_races.run_id(),reviewed_draft_races.id(302))->>'error'='reviewed_source_refused','transport operation mismatch refused');
select reviewed_draft_races.ok(public.claim_reviewed_workflow_dispatch(reviewed_draft_races.id(11),reviewed_draft_races.run_id(),reviewed_draft_races.id(301),repeat('a',64))->>'error'='reviewed_source_refused','changed claim hash refused');
select reviewed_draft_races.ok(public.claim_reviewed_workflow_dispatch(reviewed_draft_races.id(11),reviewed_draft_races.run_id(),reviewed_draft_races.id(301),encode(sha256(convert_to(reviewed_draft_races.input(),'UTF8')),'hex'))->'claimed'='true'::jsonb,'one genuine stored request claimed');
select reviewed_draft_races.ok(public.claim_reviewed_workflow_dispatch(reviewed_draft_races.id(11),reviewed_draft_races.run_id(),reviewed_draft_races.id(301),encode(sha256(convert_to(reviewed_draft_races.input(),'UTF8')),'hex'))->'claimed'='false'::jsonb,'uncertain prior claim never grants second execution');
reset role;
select reviewed_draft_races.ok((select count(*)=1 from public.reviewed_workflow_dispatch_claims where run_id=reviewed_draft_races.run_id()),'only one immutable claim retained');
select reviewed_draft_races.ok((select count(*)=1 from public.reviewed_workflow_dispatches where run_id=reviewed_draft_races.run_id()),'one immutable source snapshot retained');
select reviewed_draft_races.ok((select bool_and(not has_table_privilege(r,'public.reviewed_workflow_dispatches','INSERT') and not has_table_privilege(r,'public.reviewed_workflow_dispatch_claims','INSERT')) from unnest(array['anon','authenticated','service_role','human_action_writer','agent_ledger_writer'])r),'no role may forge source snapshots or claims');
select reviewed_draft_races.ok(not has_function_privilege('agent_ledger_writer','public.start_reviewed_workflow_dispatch(uuid,uuid,uuid,uuid,text,text)','EXECUTE'),'runtime cannot impersonate human request');
select reviewed_draft_races.ok(not has_function_privilege('human_action_writer','public.claim_reviewed_workflow_dispatch(uuid,uuid,uuid,text)','EXECUTE'),'human writer cannot execute runtime claim');
create function reviewed_draft_races.h() returns text language sql stable as $$select encode(sha256(convert_to(reviewed_draft_races.input(),'UTF8')),'hex')$$;
create function reviewed_draft_races.output() returns text language sql stable security definer as $$select controller_security.reviewed_workflow_expected_output(reviewed_draft_races.input())::text$$;
create function reviewed_draft_races.oh(output text default reviewed_draft_races.output()) returns text language sql immutable as $$select encode(sha256(convert_to(output,'UTF8')),'hex')$$;
create table reviewed_draft_races.receipts(k text primary key,id text);
grant select,insert on reviewed_draft_races.receipts to agent_ledger_writer,human_action_writer;
grant execute on function reviewed_draft_races.output() to agent_ledger_writer,human_action_writer;
set local role agent_ledger_writer;
insert into reviewed_draft_races.receipts values('started',public.append_agent_ledger(reviewed_draft_races.id(11),reviewed_draft_races.id(301),'agent','vibhaag','0.1.0',null,null,
 'classification.started',reviewed_draft_races.id(31)::text,reviewed_draft_races.h(),null,null,null,null,null,'pending',
 jsonb_build_object('phase','started','run_id',reviewed_draft_races.run_id(),'request_hash',reviewed_draft_races.h()))::text);
insert into reviewed_draft_races.receipts values('completed',public.append_agent_ledger(reviewed_draft_races.id(11),reviewed_draft_races.id(301),'agent','vibhaag','0.1.0',null,null,
 'classification.started',reviewed_draft_races.id(31)::text,reviewed_draft_races.h(),reviewed_draft_races.oh(),null,null,null,null,'success',
 jsonb_build_object('phase','completed','run_id',reviewed_draft_races.run_id(),'request_hash',reviewed_draft_races.h(),
 'started_entry',(select id from reviewed_draft_races.receipts where k='started')))::text);
reset role;
create function reviewed_draft_races.settle(output text default reviewed_draft_races.output(),actor integer default 1) returns jsonb language sql as $$
 select public.settle_reviewed_workflow_output(reviewed_draft_races.id(11),reviewed_draft_races.id(actor),reviewed_draft_races.run_id(),reviewed_draft_races.id(31),reviewed_draft_races.id(301),
 reviewed_draft_races.h(),reviewed_draft_races.input(),output,reviewed_draft_races.oh(output),1,0,0,0,
 (select id from reviewed_draft_races.receipts where k='started'),(select id from reviewed_draft_races.receipts where k='completed'))$$;
set local role human_action_writer;
select reviewed_draft_races.ok(reviewed_draft_races.settle(actor=>3)->>'error'='output_context_refused','other actor cannot settle original request');
select reviewed_draft_races.ok(reviewed_draft_races.settle(jsonb_set(reviewed_draft_races.output()::jsonb,'{policy_drafts,0,content}',to_jsonb('Invented legal compliant facts'::text))::text)->>'error'='output_context_refused','policy claims must match exact deterministic source output');
select reviewed_draft_races.ok(reviewed_draft_races.settle(jsonb_set(reviewed_draft_races.output()::jsonb,'{processing_reviews,0,declarations,crossBorder}','null')::text)->>'error'='output_context_refused','output cannot relabel recorded false');
select reviewed_draft_races.ok(reviewed_draft_races.settle(jsonb_set(reviewed_draft_races.output()::jsonb,'{playbook_reviews,0,measurement_status}','"verified"')::text)->>'error'='output_context_refused','reported task cannot masquerade as instrumented measurement');
select reviewed_draft_races.ok(reviewed_draft_races.settle()->>'status'='succeeded','ordered runtime receipts atomically settle and capture exact review output');
select reviewed_draft_races.ok(reviewed_draft_races.settle()->'replayed'='true'::jsonb,'exact settlement replay captures no duplicate output');
select reviewed_draft_races.ok(public.recover_reviewed_workflow_output(reviewed_draft_races.id(11),reviewed_draft_races.id(1),reviewed_draft_races.id(31),reviewed_draft_races.id(301),reviewed_draft_races.input())->>'output_text'=reviewed_draft_races.output(),'lost successful response recovers exact stored output without redispatch');
select reviewed_draft_races.ok(public.recover_reviewed_workflow_output(reviewed_draft_races.id(11),reviewed_draft_races.id(3),reviewed_draft_races.id(31),reviewed_draft_races.id(301),reviewed_draft_races.input())->>'error'='output_context_refused','other actor cannot recover original output');
select reviewed_draft_races.ok(public.recover_reviewed_workflow_output(reviewed_draft_races.id(11),reviewed_draft_races.id(1),reviewed_draft_races.id(31),reviewed_draft_races.id(301),reviewed_draft_races.input()||' ')->>'error'='output_context_refused','changed exact original input cannot recover output');
reset role;
select reviewed_draft_races.ok((select count(*)=1 from public.reviewed_workflow_settled_outputs where run_id=reviewed_draft_races.run_id()),'one immutable exact output captured');
select reviewed_draft_races.ok((select bool_and(not has_table_privilege(r,'public.reviewed_workflow_settled_outputs','INSERT')) from unnest(array['anon','authenticated','service_role','human_action_writer','agent_ledger_writer'])r),'no direct output import writer');
select reviewed_draft_races.ok(not has_function_privilege('agent_ledger_writer','public.settle_reviewed_workflow_output(uuid,uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,integer,numeric,text,text)','EXECUTE'),'runtime cannot controller-settle or import output');
create function reviewed_draft_races.body(index integer default null,reason text default 'Reviewed human declarations; legal approval remains separate') returns text language sql stable as $$
 select jsonb_build_object('runId',reviewed_draft_races.run_id(),'outputHash',reviewed_draft_races.oh(),'policyIndex',index,'reason',reason,'confirmReview',true)::text$$;
create function reviewed_draft_races.ack(op integer,index integer default null,actor integer default 1,body text default null) returns jsonb language sql as $$
 select public.acknowledge_reviewed_workflow_output(reviewed_draft_races.id(11),reviewed_draft_races.id(actor),reviewed_draft_races.id(31),reviewed_draft_races.id(301),reviewed_draft_races.input(),reviewed_draft_races.id(op),coalesce(body,reviewed_draft_races.body(index)))$$;
set local role human_action_writer;
insert into reviewed_draft_races.fixture values('ack',reviewed_draft_races.ack(401));
select reviewed_draft_races.ok((select v?'acknowledgement_id' and v->'policy_draft_id'='null'::jsonb and v->'replayed'='false'::jsonb from reviewed_draft_races.fixture where k='ack'),'separate human acknowledgement saves review artifact without duplicating original source');
select reviewed_draft_races.ok(reviewed_draft_races.ack(401)->'replayed'='true'::jsonb,'lost acknowledgement response recovers same receipt');
select reviewed_draft_races.ok(reviewed_draft_races.ack(401,0)->>'error'='acknowledgement_conflict','same acknowledgement key cannot become policy adoption');
select reviewed_draft_races.ok(reviewed_draft_races.ack(401,actor=>3)->>'error'='output_proof_refused','changed actor cannot recover acknowledgement');
select reviewed_draft_races.ok(reviewed_draft_races.ack(402,body=>jsonb_set(reviewed_draft_races.body()::jsonb,'{confirmReview}','false')::text)->>'error'='invalid_acknowledgement','explicit human confirmation required');
select reviewed_draft_races.ok(reviewed_draft_races.ack(402,body=>jsonb_set(reviewed_draft_races.body()::jsonb,'{outputHash}',to_jsonb(repeat('f',64)))::text)->>'error'='output_proof_refused','changed output cannot be acknowledged');
select reviewed_draft_races.ok(reviewed_draft_races.ack(402,79)->>'error'='invalid_acknowledgement','unproduced policy index refused');
insert into reviewed_draft_races.fixture values('adoption',reviewed_draft_races.ack(403,0));
select reviewed_draft_races.ok((select v->>'policy_draft_id' is not null and v->'replayed'='false'::jsonb from reviewed_draft_races.fixture where k='adoption'),'explicit selected genuine policy adopted only as new unpublished human draft');
select reviewed_draft_races.ok(reviewed_draft_races.ack(403,0)->'replayed'='true'::jsonb,'policy lost response recover does not duplicate domain records');
select reviewed_draft_races.ok(reviewed_draft_races.ack(403,1)->>'error'='acknowledgement_conflict','changed selected policy cannot reuse operation');
reset role;
select reviewed_draft_races.ok((select count(*)=2 from public.reviewed_workflow_acknowledgements where tenant_id=reviewed_draft_races.id(11)),'acknowledgement and policy adoption are independently recorded');
select reviewed_draft_races.ok((select count(*)=3 from public.operator_workflow_records where tenant_id=reviewed_draft_races.id(11)),'only one new policy added; original RoPA/task not duplicated');
select reviewed_draft_races.ok((select count(*)=1 from public.policy_drafts where tenant_id=reviewed_draft_races.id(11) and status='draft'),'adoption never approves or publishes policy');
select reviewed_draft_races.ok((select bool_and(created_by=reviewed_draft_races.id(case when kind='ropa' then 1 else 3 end)) from public.operator_workflow_records where tenant_id=reviewed_draft_races.id(11) and kind in ('ropa','delivery_task')),'original human creators retained');
select reviewed_draft_races.ok((select payload->>'content'=reviewed_draft_races.output()::jsonb#>>'{policy_drafts,0,content}' and payload->>'sourceNote'=(select v#>>'{data,payload,sourceNote}' from reviewed_draft_races.fixture where k='ropa') from public.operator_workflow_records where id=(select (v->>'policy_draft_id')::uuid from reviewed_draft_races.fixture where k='adoption')),'adopted exact source-bound content and original note retained');
create function reviewed_draft_races.forgery(agent boolean default false) returns void language plpgsql as $$
begin
 begin
  if agent then
   perform public.append_agent_ledger(reviewed_draft_races.id(11),reviewed_draft_races.id(499),'system','forger',null,null,null,'classification.reviewed','fake',null,null,null,null,null,null,'success','{"purpose":"reviewed_workflow_acknowledgement"}');
  else
   perform public.append_human_ledger(reviewed_draft_races.id(11),reviewed_draft_races.id(499),'human',reviewed_draft_races.id(1)::text,null,null,null,'classification.reviewed','fake',null,null,null,null,null,null,'success','{"purpose":"reviewed_workflow_acknowledgement"}');
  end if;
 exception when insufficient_privilege then return;end;
 raise exception 'ASSERTION: generic append forged reserved acknowledgement';
end $$;
set local role human_action_writer;
select reviewed_draft_races.forgery();
reset role;
set local role agent_ledger_writer;
select reviewed_draft_races.forgery(true);
reset role;
select reviewed_draft_races.ok((select bool_and(not has_function_privilege(r,'public.acknowledge_reviewed_workflow_output(uuid,uuid,uuid,uuid,text,uuid,text)','EXECUTE') and not has_table_privilege(r,'public.reviewed_workflow_acknowledgements','INSERT')) from unnest(array['anon','authenticated','service_role','agent_ledger_writer'])r),'no producer/direct service acknowledgement grant');

set role human_action_writer;
insert into reviewed_draft_races.fixture values('unclaimed',public.start_reviewed_workflow_dispatch(reviewed_draft_races.id(11),reviewed_draft_races.id(1),reviewed_draft_races.id(31),reviewed_draft_races.id(302),reviewed_draft_races.input(),reviewed_draft_races.records()));
reset role;
create function reviewed_draft_races.claim() returns jsonb language sql as $$select public.claim_reviewed_workflow_dispatch(reviewed_draft_races.id(11),(select (v->>'run_id')::uuid from reviewed_draft_races.fixture where k='unclaimed'),reviewed_draft_races.id(302),reviewed_draft_races.h())$$;

commit;
