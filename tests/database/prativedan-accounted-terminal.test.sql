-- Disposable SQL contract fixtures, NOT live named-agent acceptance.
-- Uses actual finalized assessment/controller and append_ledger paths.
begin;
-- Disposable fixture custody only; rolled back here or destroyed with the owned container.
-- No SVID/PostgREST/private-channel identity proof is inferred from SET ROLE.
grant axiom_prativedan_controller to postgres with set true;
create function pg_temp.id(n int) returns uuid language sql immutable as $$select ('51230000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m; end if; end$$;
create function pg_temp.reject(q text,code text default '42501') returns void language plpgsql as $$begin begin execute q; execute 'set constraints all immediate'; exception when others then if sqlstate=code then return; end if; raise; end; raise exception 'Unexpected success'; end$$;
insert into auth.users(id,email) values(pg_temp.id(1),'prativedan-sql@test.invalid');
insert into public.users(id,email,is_axiom_internal) values(pg_temp.id(1),'prativedan-sql@test.invalid',true);
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'worker-assessment','Worker fixture');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(1),'founder');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('prativedan-sql-v2',now(),'test','Synthetic fixture',2);
insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version)
 select 'WA-'||n,'prativedan-sql-v2','Fixture','Fixture','SEC','low','[]','[]','[{"id":"Q1","prompt":"Synthetic declaration","type":"boolean"}]','{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":1000000}','{}','prativedan-sql-v2' from generate_series(1,2) n;
insert into public.estates(id,tenant_id,name,slug) values(pg_temp.id(22),pg_temp.id(11),'Synthetic estate','synthetic');
insert into public.engagements(id,tenant_id,estate_id,library_version,title) values(pg_temp.id(21),pg_temp.id(11),pg_temp.id(22),'prativedan-sql-v2','New assessment');
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status)
 values(pg_temp.id(31),pg_temp.id(11),'parikshan','spiffe://axiom.test/parikshan','active');
create temporary table issued as select (public.delegate_workload_task(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),'parikshan',pg_temp.id(22),pg_temp.id(21),pg_temp.id(41),repeat('a',64),repeat('b',64),array['control_library.read','findings.write'],clock_timestamp()+interval '10 minutes')->>'run_id')::uuid run_id;
grant select on issued to service_role;
create function pg_temp.start_tool(proof text default repeat('b',64),input_hash text default repeat('a',64),deadline timestamptz default clock_timestamp()+interval '5 minutes') returns jsonb language sql as $$
 select public.start_workload_assessment(pg_temp.id(11),(select run_id from issued),pg_temp.id(31),proof,input_hash,deadline)$$;
create function pg_temp.result() returns jsonb language sql stable as $$select '{"library_version":"prativedan-sql-v2","posture_score":50,"estimated_exposure_inr":10000000,"findings":[{"control_id":"WA-2","score":100,"risk_points":0,"rationale":"All answers comply"},{"control_id":"WA-1","score":0,"risk_points":10,"rationale":"No answers comply"}]}'::jsonb || jsonb_build_object('questionnaire_provenance',jsonb_build_object(
 'version',1,'source_library_version','prativedan-sql-v2',
 'source_library_digest',(select library_digest from public.workload_assessment_packets where run_id=(select run_id from issued)),
 'estimates','provisional','review_required',true,
 'controls',(select jsonb_agg(jsonb_build_object('control_id','WA-'||n,'questions','[{"question_id":"Q1","declaration":"unknown"}]'::jsonb,
  'known_boolean_question_count',1,'caller_affirmed_count',0,'caller_denied_count',0,'unknown_count',1,
  'answer_state','unknown','applicability_state','unconditional')) from generate_series(1,2) n),
 'applicability',jsonb_build_object(
  'sdf_self_attested',jsonb_build_object('value',null,'provenance','unknown'),
  'processes_children',jsonb_build_object('value',null,'provenance','unknown'),
  'processes_health',jsonb_build_object('value',null,'provenance','unknown'))))$$;
create function pg_temp.finish_tool(result jsonb default pg_temp.result(),deadline timestamptz default clock_timestamp()+interval '5 minutes') returns jsonb language sql as $$
 select public.complete_workload_assessment(pg_temp.id(11),(select run_id from issued),pg_temp.id(31),repeat('b',64),(select library_digest from public.workload_assessment_packets where run_id=(select run_id from issued)),result,deadline)$$;
select pg_temp.start_tool();
select pg_temp.finish_tool();
select public.confirm_workload_assessment(pg_temp.id(11),(select run_id from issued));
select pg_temp.ok(public.board_assessment_source_valid(pg_temp.id(11),(select run_id from issued),pg_temp.id(21)),'actual finalized assessment chain');
insert into auth.users(id,email) values(pg_temp.id(2),'p123-other-founder@test.invalid'),(pg_temp.id(3),'p123-viewer@test.invalid');
insert into public.users(id,email,is_axiom_internal) values(pg_temp.id(2),'p123-other-founder@test.invalid',true),(pg_temp.id(3),'p123-viewer@test.invalid',false);
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(2),'founder'),(pg_temp.id(11),pg_temp.id(3),'viewer');
create temporary table p123_context(preview jsonb,human_text text,reply jsonb,claim jsonb,proof jsonb,input_text text,output_text text,response_text text,started bigint,completed bigint);
insert into p123_context values(null,null,null,null,null,null,null,null,null,null);
grant select,update on p123_context to human_action_writer,agent_ledger_writer;
grant select on issued to human_action_writer,agent_ledger_writer;

-- Equal-sized distinct sets with a foreign ID must not be joined away.
select pg_temp.ok(controller_security.prativedan123_coverage('[{"id":"A"},{"id":"B"}]',
 '[{"control_id":"B"},{"control_id":"A"}]','[{"control_id":"A"},{"control_id":"B"}]') is true,'reordered exact coverage accepted');
select pg_temp.ok(controller_security.prativedan123_coverage('[{"id":"A"},{"id":"B"}]',
 '[{"control_id":"A"},{"control_id":"FOREIGN"}]','[{"control_id":"A"},{"control_id":"B"}]') is false,'equal-count foreign result control refused');
select pg_temp.ok(controller_security.prativedan123_coverage('[{"id":"A"},{"id":"B"}]',
 '[{"control_id":"A"},{"control_id":"B"}]','[{"control_id":"A"},{"control_id":"FOREIGN"}]') is false,'equal-count foreign declaration refused');
select pg_temp.ok(controller_security.prativedan123_coverage('[{"id":"A"},{"id":"B"}]',
 '[{"control_id":"A"},{"control_id":"A"}]','[{"control_id":"A"},{"control_id":"B"}]') is false,'duplicate result control refused');

-- No table privilege or generic human/runtime RPC crossover.
do $$declare tab text;role_name text;begin
 foreach tab in array array['prativedan_assessment_sources','prativedan_draft_requests','prativedan_draft_claims','prativedan_draft_outputs','prativedan_draft_reviews'] loop
  foreach role_name in array array['anon','authenticated','service_role','human_action_writer','agent_ledger_writer'] loop
   perform pg_temp.ok(not has_table_privilege(role_name,'public.'||tab,'SELECT') and not has_table_privilege(role_name,'public.'||tab,'INSERT')
    and not has_table_privilege(role_name,'public.'||tab,'UPDATE') and not has_table_privilege(role_name,'public.'||tab,'DELETE'),'no generic journal access');
  end loop;
 end loop;
 perform pg_temp.ok(not has_function_privilege('service_role','public.request_prativedan_assessment_draft(uuid,uuid,text)','EXECUTE'),'service cannot request');
 perform pg_temp.ok(not has_function_privilege('agent_ledger_writer','public.request_prativedan_assessment_draft(uuid,uuid,text)','EXECUTE'),'agent cannot request');
 perform pg_temp.ok(not has_function_privilege('human_action_writer','public.claim_prativedan_assessment_draft(uuid,uuid,uuid,text,text)','EXECUTE'),'human cannot claim');
 perform pg_temp.ok(not has_function_privilege('agent_ledger_writer','public.review_prativedan_assessment_draft(uuid,uuid,uuid,uuid,text,text,text)','EXECUTE'),'agent cannot review');
 perform pg_temp.ok(not has_function_privilege('service_role','controller_security.prativedan123_read(uuid,uuid)','EXECUTE'),'private recovery closed');
end $$;
set local role human_action_writer;
update p123_context set preview=public.preview_prativedan_assessment_source(pg_temp.id(11),pg_temp.id(1),pg_temp.id(21),(select run_id from issued));
select pg_temp.reject(format('select public.preview_prativedan_assessment_source(%L,%L,%L,%L)',pg_temp.id(11),pg_temp.id(3),pg_temp.id(21),(select run_id from issued)));
select pg_temp.reject(format('select public.preview_prativedan_assessment_source(%L,%L,%L,%L)',pg_temp.id(91),pg_temp.id(1),pg_temp.id(21),(select run_id from issued)));
select pg_temp.reject(format('select public.preview_prativedan_assessment_source(%L,%L,%L,%L)',pg_temp.id(11),pg_temp.id(1),pg_temp.id(91),(select run_id from issued)));
reset role;
select pg_temp.ok((select count(*)=0 from public.prativedan_assessment_sources),'preview never writes');
select pg_temp.ok((select preview->>'source_sha256'=controller_security.prativedan123_hash(preview->>'source_text')
 and preview->>'publication_allowed'='false' and (preview->>'source_text')::jsonb->>'kind'='prativedan_assessment_source'
 and ((preview->>'source_text')::jsonb->>'schema_version')::integer=2
 and (preview->>'source_text')::jsonb->>'source_id'=(select run_id::text from issued) from p123_context),'explicit sourcev2/run identity and byte hash');
update p123_context set human_text=jsonb_build_object('operationKey',pg_temp.id(55),'engagementId',pg_temp.id(21),
 'assessmentRunId',(select run_id from issued),'expectedSourceSha256',preview->>'source_sha256','sourceReviewed',true)::text;
set local role human_action_writer;
select pg_temp.reject(format('select public.request_prativedan_assessment_draft(%L,%L,%L)',pg_temp.id(11),pg_temp.id(1),
 (select jsonb_set(human_text::jsonb,'{expectedSourceSha256}',to_jsonb(repeat('f',64)))::text from p123_context)));
select pg_temp.reject(format('select public.request_prativedan_assessment_draft(%L,%L,%L)',pg_temp.id(11),pg_temp.id(1),
 (select jsonb_set(human_text::jsonb,'{sourceReviewed}','false')::text from p123_context)),'22023');
select pg_temp.reject(format('select public.request_prativedan_assessment_draft(%L,%L,%L)',pg_temp.id(11),pg_temp.id(1),
 (select '{"sourceReviewed":false,'||substr(human_text,2) from p123_context)),'22023');
reset role;
create function pg_temp.fail_p123_request_append() returns trigger language plpgsql as $$
begin raise exception 'synthetic mandatory request append failure';end $$;
create trigger p123_append_failure before insert on public.audit_ledger for each row when(new.action_type::text='prativedan.draft.requested') execute function pg_temp.fail_p123_request_append();
set local role human_action_writer;
select pg_temp.reject(format('select public.request_prativedan_assessment_draft(%L,%L,%L)',pg_temp.id(11),pg_temp.id(1),(select human_text from p123_context)),'P0001');
reset role;
select pg_temp.ok((select count(*)=0 from public.prativedan_assessment_sources) and (select count(*)=0 from public.prativedan_draft_requests),'mandatory receipt failure rolls back new source and request');
drop trigger p123_append_failure on public.audit_ledger;
set local role human_action_writer;
update p123_context set reply=public.request_prativedan_assessment_draft(pg_temp.id(11),pg_temp.id(1),human_text);
select pg_temp.ok((select public.request_prativedan_assessment_draft(pg_temp.id(11),pg_temp.id(1),human_text)=reply||'{"replayed":true}'::jsonb from p123_context),'exact original request replay');
select pg_temp.reject(format('select public.request_prativedan_assessment_draft(%L,%L,%L)',pg_temp.id(11),pg_temp.id(2),(select human_text from p123_context)),'22023');
select pg_temp.reject(format('select public.request_prativedan_assessment_draft(%L,%L,%L)',pg_temp.id(11),pg_temp.id(1),(select human_text||' ' from p123_context)),'22023');
reset role;
select pg_temp.ok((select count(*)=1 from public.prativedan_assessment_sources) and (select count(*)=1 from public.prativedan_draft_requests),'single source/request');
select pg_temp.ok((select count(*)=0 from public.board_report_requests) and (select count(*)=0 from public.board_request_sources)
 and (select count(*)=0 from public.reports),'unchanged legacy board authority/state');
update p123_context set input_text=(select renderer_input_projection::text from public.prativedan_assessment_sources where tenant_id=pg_temp.id(11));
select pg_temp.ok((select input_text::jsonb#>>'{findings,0,control_id}'='WA-2' and input_text::jsonb#>>'{library_control_ids,0}'='WA-1' from p123_context),'finalized finding order preserved independently of control source order');
-- Synthetic exclusive service custody, NOT JWT-SVID/PostgREST delivery proof.
insert into controller_security.prativedan_credentials(id,tenant_id,expires_at)
 values(pg_temp.id(99),pg_temp.id(11),clock_timestamp()+interval '2 hours');
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status)
 values(pg_temp.id(98),pg_temp.id(11),'prativedan','spiffe://local.axiomproof.test/agent/prativedan','active');
insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted,activated_at)
 values(pg_temp.id(97),pg_temp.id(1),'totp','active','synthetic-nonoperational-fixture',clock_timestamp());
insert into public.mfa_session_attestations(id,user_id,session_id,factor_id,expires_at)
 values(pg_temp.id(96),pg_temp.id(1),pg_temp.id(95)::text,pg_temp.id(97),clock_timestamp()+interval '1 hour');
create function pg_temp.authority() returns jsonb language sql as $$select jsonb_build_object(
 'actor_id',pg_temp.id(1),'session_id',pg_temp.id(95),'workload_id',pg_temp.id(98),'registration_version',1,
 'subject','spiffe://local.axiomproof.test/agent/prativedan','svid_expires_at',clock_timestamp()+interval '4 minutes')$$;
-- One observed issuance instant binds both claims. Independent clock reads can
-- straddle a second and produce a forbidden 3601-second fixture credential.
create function pg_temp.controller_claims() returns text language plpgsql as $$
declare issued_epoch bigint:=floor(extract(epoch from clock_timestamp()));
begin
 return jsonb_build_object('role','axiom_prativedan_controller','sub',pg_temp.id(99),
  'tenant_id',pg_temp.id(11),'iat',issued_epoch,'exp',issued_epoch+3600)::text;
end$$;
-- Deterministic boundary regression: a second clock read advances into the
-- next second. The original helper fails both the lifetime and read-count gate.
-- Everything here is newly created inside this test's owned transaction.
savepoint controller_claim_clock_contract;
create schema p123_clock_fixture;
create sequence p123_clock_fixture.calls;
create function p123_clock_fixture.clock_timestamp() returns timestamptz language sql volatile as $$
 select to_timestamp(2000000000+case when nextval('p123_clock_fixture.calls')=1 then 0.999999 else 1.000001 end)
$$;
set local search_path=p123_clock_fixture,pg_catalog,public;
do $$declare claims jsonb:=pg_temp.controller_claims()::jsonb;begin
 if (claims->>'exp')::bigint-(claims->>'iat')::bigint<>3600
  or currval('p123_clock_fixture.calls')<>1
 then raise exception 'Controller fixture must bind claims to one issuance instant';end if;
end$$;
rollback to controller_claim_clock_contract;
select set_config('request.jwt.claims',pg_temp.controller_claims(),true);
grant select,update on p123_context to axiom_prativedan_controller;


create table if not exists auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),not_after timestamptz);
insert into auth.sessions(id,user_id,not_after) values(pg_temp.id(95),pg_temp.id(1),null);
create function pg_temp.start172(proof text default repeat('c',64)) returns jsonb language sql as $$
 select public.start_prativedan_accounted_draft(pg_temp.id(11),pg_temp.id(55),(reply->>'run_id')::uuid,
 encode(sha256(convert_to(human_text,'UTF8')),'hex'),input_text,encode(sha256(convert_to($1,'UTF8')),'hex'),pg_temp.authority()) from p123_context $$;
create function pg_temp.finish172(proof text default repeat('c',64),reason text default 'target_failed',body text default null) returns jsonb language sql as $$
 select public.finish_prativedan_accounted_draft(pg_temp.id(11),pg_temp.id(55),(reply->>'run_id')::uuid,
 encode(sha256(convert_to(human_text,'UTF8')),'hex'),$1,body,reason,25,pg_temp.authority()) from p123_context $$;
create function pg_temp.read172() returns jsonb language sql as $$
 select public.read_prativedan_accounted_draft(pg_temp.id(11),pg_temp.id(55),(reply->>'run_id')::uuid,
 encode(sha256(convert_to(human_text,'UTF8')),'hex'),pg_temp.authority()) from p123_context $$;
set local role axiom_prativedan_controller;
select pg_temp.ok(pg_temp.read172()='{"missing":true}'::jsonb,'absence is not zero');
update p123_context set claim=pg_temp.start172();
select pg_temp.ok((select claim->>'claimed'='true' and claim#>>'{accounting_dispatch,claimed}'='true' from p123_context),'atomic fresh actual accounting opening');
select pg_temp.ok(pg_temp.start172()->>'claimed'='false','replay cannot recompute');
select pg_temp.reject('select pg_temp.finish172(repeat(''d'',64))');
select pg_temp.reject(format('select public.prativedan_begin_model_accounting_call(%L,%L,%L,%L,%L,%L,%L::jsonb)',
 pg_temp.id(11),(select reply->>'run_id' from p123_context),(select encode(sha256(convert_to(human_text,'UTF8')),'hex') from p123_context),
 pg_temp.id(700),'{}',pg_temp.id(55),pg_temp.authority()));
reset role;
savepoint success_branch;
update p123_context set output_text=jsonb_build_object('title',input_text::jsonb->'title','kind','board','generated_by_agent','prativedan',
 'cited_evidence_ids','[]'::jsonb,'rendered_html','<h1>Unpublished synthetic SQL contract fixture</h1>',
 'review_required',true,'citation_verification','unverified_references','sections',jsonb_build_array(
 jsonb_build_object('type','executive_summary','title','Executive summary','body','Provisional synthetic SQL fixture; not live renderer evidence.'),
 jsonb_build_object('type','findings_table','title','Findings for review (source order)','items',
  (select jsonb_agg(x||'{"risk_points":null}'::jsonb) from jsonb_array_elements(input_text::jsonb->'findings') x)),
 jsonb_build_object('type','library','title','Control library','body','Referenced library version: prativedan-sql-v2. Draft input declares 2 controls; frozen source verification remains required.'),
 jsonb_build_object('type','attribution','title','Draft attribution and review status','body','Generated by Prativedan (v0.1.0). Pending recorded human review. Evidence references are unverified.')))::text;

set local role axiom_prativedan_controller;
update p123_context set proof=pg_temp.finish172(repeat('c',64),null,output_text);
select pg_temp.ok((select proof->>'status'='succeeded' and proof->>'cost_usd'='0.000000' from p123_context),'actual zero-only success seal');
select pg_temp.ok((select pg_temp.read172()=proof from p123_context),'lost response exact recovery');
select pg_temp.ok((select pg_temp.finish172(repeat('c',64),null,output_text)=proof from p123_context),'exact terminal replay');
select pg_temp.reject('select pg_temp.finish172()');
reset role;
set constraints all immediate;
rollback to success_branch;
update public.kill_switch_state set engaged=true where scope_key='global';
set local role axiom_prativedan_controller;
select pg_temp.reject('select pg_temp.start172()');
select pg_temp.reject('select pg_temp.read172()');
update p123_context set proof=pg_temp.finish172();
select pg_temp.ok((select proof->>'status'='failed' and proof->>'error'='target_failed' and proof->'runtime_output_text'='null'::jsonb from p123_context),'truthful terminal failure after stop');
reset role;
select pg_temp.ok((select count(*)=1 from public.prativedan_accounted_capsules),'one immutable capsule');
select pg_temp.ok((select count(*)=0 from public.model_accounting_call_starts),'zero is measured from opened/sealed empty journal');
select pg_temp.ok((select summary->>'basis'='no_model' from public.model_accounting_seals),'zero-call seal basis');
select pg_temp.reject('update public.prativedan_accounted_capsules set packet_text=packet_text||'' ''','42501');
select pg_temp.ok(not exists(select 1 from public.verify_ledger(pg_temp.id(11))),'actual ledger verifies');
set constraints all immediate;
rollback;
