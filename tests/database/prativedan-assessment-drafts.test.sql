-- Disposable SQL contract fixtures, NOT live named-agent acceptance.
-- Uses actual finalized assessment/controller and append_ledger paths.
begin;
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
-- P123_CONCURRENCY_FIXTURE_END: reviewed request, no claim.
set local role agent_ledger_writer;
select pg_temp.reject(format('select public.claim_prativedan_assessment_draft(%L,%L,%L,%L,%L)',pg_temp.id(11),pg_temp.id(55),
 (select reply->>'run_id' from p123_context),repeat('f',64),(select input_text from p123_context)));
select pg_temp.reject(format('select public.claim_prativedan_assessment_draft(%L,%L,%L,%L,%L)',pg_temp.id(11),pg_temp.id(55),
 (select reply->>'run_id' from p123_context),(select encode(sha256(convert_to(human_text,'UTF8')),'hex') from p123_context),
 (select jsonb_set(input_text::jsonb,'{posture_score}','99')::text from p123_context)));
update p123_context set claim=public.claim_prativedan_assessment_draft(pg_temp.id(11),pg_temp.id(55),(reply->>'run_id')::uuid,
 encode(sha256(convert_to(human_text,'UTF8')),'hex'),input_text);
select pg_temp.ok((select claim->'claimed'='true'::jsonb and claim#>>'{readback,state}'='invocation_uncertain' from p123_context),'one-shot claim grants one invocation');
select pg_temp.ok((select public.claim_prativedan_assessment_draft(pg_temp.id(11),pg_temp.id(55),(reply->>'run_id')::uuid,
 encode(sha256(convert_to(human_text,'UTF8')),'hex'),input_text)->'claimed'='false'::jsonb from p123_context),'lost claim response/read replay never authorizes redispatch');
reset role;

-- Structural SQL fixture; actual renderer/HTML acceptance is a later codec gate.
update p123_context set output_text=jsonb_build_object('title',input_text::jsonb->'title','kind','board','generated_by_agent','prativedan',
 'cited_evidence_ids','[]'::jsonb,'rendered_html','<h1>Unpublished synthetic SQL contract fixture</h1>',
 'review_required',true,'citation_verification','unverified_references','sections',jsonb_build_array(
 jsonb_build_object('type','executive_summary','title','Executive summary','body','Provisional synthetic SQL fixture; not live renderer evidence.'),
 jsonb_build_object('type','findings_table','title','Findings for review (source order)','items',
  (select jsonb_agg(x||'{"risk_points":null}'::jsonb) from jsonb_array_elements(input_text::jsonb->'findings') x)),
 jsonb_build_object('type','library','title','Control library','body','Referenced library version: prativedan-sql-v2. Draft input declares 2 controls; frozen source verification remains required.'),
 jsonb_build_object('type','attribution','title','Draft attribution and review status','body','Generated by Prativedan (v0.1.0). Pending recorded human review. Evidence references are unverified.')))::text;
update p123_context set response_text=output_text||' ';
select pg_temp.ok(controller_security.prativedan123_output_valid((select input_text::jsonb from p123_context),
 (select jsonb_set(output_text::jsonb,'{sections,0}','{}') from p123_context)) is false,'missing summary fields must return FALSE not SQL NULL');
select pg_temp.ok(controller_security.prativedan123_output_valid((select input_text::jsonb from p123_context),
 (select jsonb_set(output_text::jsonb,'{sections,0,body}','null') from p123_context)) is false,'null summary fields must return FALSE');
-- Genuine immutable ledger rows through scoped append_agent_ledger. Synthetic
-- declarations test DB binding; they do not attest actual Python invocation.
set local role agent_ledger_writer;
update p123_context set started=public.append_agent_ledger(pg_temp.id(11),pg_temp.id(55),'agent','prativedan','0.1.0',null,null,
 'report.generated',pg_temp.id(21)::text,encode(sha256(convert_to(input_text,'UTF8')),'hex'),null,null,null,null,null,'pending',
 jsonb_build_object('phase','started','run_id',reply->>'run_id','request_hash',encode(sha256(convert_to(human_text,'UTF8')),'hex'),
 'renderer_config_version','prativedan-draft-v1','renderer_config_sha256','b6b22a3360126539085f1630cdb390396fc97ca72fc894259c7c4cb7bc3d0ba3'));
update p123_context set completed=public.append_agent_ledger(pg_temp.id(11),pg_temp.id(55),'agent','prativedan','0.1.0',null,null,
 'report.generated',pg_temp.id(21)::text,encode(sha256(convert_to(input_text,'UTF8')),'hex'),encode(sha256(convert_to(output_text,'UTF8')),'hex'),null,null,null,null,'success',
 jsonb_build_object('phase','completed','started_entry',started::text,'run_id',reply->>'run_id','request_hash',encode(sha256(convert_to(human_text,'UTF8')),'hex'),
 'renderer_config_version','prativedan-draft-v1','renderer_config_sha256','b6b22a3360126539085f1630cdb390396fc97ca72fc894259c7c4cb7bc3d0ba3'));
reset role;
create function pg_temp.settle(output_text text default null,response_text text default null,started bigint default null,completed bigint default null,config_text text default null) returns jsonb language sql as $$
 select public.settle_prativedan_assessment_draft(pg_temp.id(11),pg_temp.id(55),(x.reply->>'run_id')::uuid,
 encode(sha256(convert_to(x.human_text,'UTF8')),'hex'),encode(sha256(convert_to(x.input_text,'UTF8')),'hex'),
 coalesce($5,x.claim#>>'{readback,renderer_config_text}'),coalesce($1,x.output_text),coalesce($2,x.response_text),coalesce($3,x.started),coalesce($4,x.completed)) from p123_context x$$;
set local role agent_ledger_writer;
select pg_temp.reject('select pg_temp.settle(completed=>1)');
select pg_temp.reject('select pg_temp.settle(config_text=>''{}'')');
savepoint invalid_summary_matching_receipt;
-- This completion hash matches the malformed bytes: only the strict FALSE
-- output validator (rather than an unrelated digest mismatch) can refuse it.
update p123_context set output_text=jsonb_set(output_text::jsonb,'{sections,0}','{}')::text;
update p123_context set response_text=output_text;
update p123_context set completed=public.append_agent_ledger(pg_temp.id(11),pg_temp.id(55),'agent','prativedan','0.1.0',null,null,
 'report.generated',pg_temp.id(21)::text,encode(sha256(convert_to(input_text,'UTF8')),'hex'),encode(sha256(convert_to(output_text,'UTF8')),'hex'),null,null,null,null,'success',
 jsonb_build_object('phase','completed','started_entry',started::text,'run_id',reply->>'run_id','request_hash',encode(sha256(convert_to(human_text,'UTF8')),'hex'),
 'renderer_config_version','prativedan-draft-v1','renderer_config_sha256','b6b22a3360126539085f1630cdb390396fc97ca72fc894259c7c4cb7bc3d0ba3'));
select pg_temp.reject('select pg_temp.settle()');
rollback to invalid_summary_matching_receipt;

select pg_temp.reject(format('select pg_temp.settle(output_text=>%L,response_text=>%L)',
 (select jsonb_set(output_text::jsonb,'{sections,0}','{}')::text from p123_context),(select jsonb_set(output_text::jsonb,'{sections,0}','{}')::text from p123_context)));
select pg_temp.reject(format('select pg_temp.settle(response_text=>%L)',(select jsonb_set(output_text::jsonb,'{title}','"Wrong title"')::text from p123_context)));
reset role;
savepoint expired_claim;
-- Test-only expiry injection on this disposable transaction, never a ledger edit.
alter table public.prativedan_draft_claims disable trigger draft_immutable;
update public.prativedan_draft_claims set claimed_at=transaction_timestamp()-interval '1 second',expires_at=clock_timestamp()-interval '1 millisecond';
alter table public.prativedan_draft_claims enable trigger draft_immutable;
select pg_temp.ok(controller_security.prativedan123_runtime_valid(pg_temp.id(11),pg_temp.id(55),
 (select started from p123_context),(select completed from p123_context),(select encode(sha256(convert_to(output_text,'UTF8')),'hex') from p123_context)),
 'stale transaction-time receipts alone cannot establish unexpired completion');
set local role agent_ledger_writer;
select pg_temp.reject('select pg_temp.settle()');
reset role;
rollback to expired_claim;
set local role agent_ledger_writer;
reset role;
create function pg_temp.fail_p123_settlement_append() returns trigger language plpgsql as $$
begin raise exception 'synthetic mandatory settlement append failure';end $$;
create trigger p123_settlement_failure before insert on public.audit_ledger for each row when(new.action_type::text='prativedan.draft.settled') execute function pg_temp.fail_p123_settlement_append();
set local role agent_ledger_writer;
select pg_temp.reject('select pg_temp.settle()','P0001');
reset role;
select pg_temp.ok((select count(*)=0 from public.prativedan_draft_outputs) and (select count(*)=1 from public.prativedan_draft_claims)
 and (select count(*)=0 from public.audit_ledger where action_type::text='prativedan.draft.settled'),'mandatory settlement receipt failure preserves uncertain claim without output');
drop trigger p123_settlement_failure on public.audit_ledger;
set local role agent_ledger_writer;
update p123_context set proof=pg_temp.settle();
select pg_temp.ok((select proof->'publication_allowed'='false'::jsonb and proof->>'state'='unpublished'
 and proof->>'runtime_output_sha256'<>proof->>'response_output_sha256' from p123_context),'five raw byte domains retained independently');
select pg_temp.ok((select pg_temp.settle()=proof||'{"replayed":true}'::jsonb from p123_context),'exact settlement response-loss replay');
select pg_temp.reject(format('select pg_temp.settle(output_text=>%L)',(select output_text||' ' from p123_context)));
reset role;
set constraints all immediate;
set constraints all deferred;

-- Foreign/mutated original body cannot recover a draft by hash alone.
set local role human_action_writer;
select pg_temp.ok((select public.read_prativedan_assessment_draft(pg_temp.id(11),pg_temp.id(1),human_text)->>'runtime_output_text'=output_text from p123_context),'actual retained raw output readback');
select pg_temp.reject(format('select public.read_prativedan_assessment_draft(%L,%L,%L)',pg_temp.id(11),pg_temp.id(2),(select human_text from p123_context)));
select pg_temp.reject(format('select public.read_prativedan_assessment_draft(%L,%L,%L)',pg_temp.id(11),pg_temp.id(1),(select human_text||' ' from p123_context)));
select pg_temp.reject(format('select public.review_prativedan_assessment_draft(%L,%L,%L,%L,%L,%L,%L)',pg_temp.id(11),pg_temp.id(1),pg_temp.id(55),pg_temp.id(56),repeat('f',64),'accepted','I reviewed this exact synthetic draft.'));
select pg_temp.ok((select public.review_prativedan_assessment_draft(pg_temp.id(11),pg_temp.id(1),pg_temp.id(55),pg_temp.id(56),proof->>'response_output_sha256','accepted','I reviewed this exact synthetic draft.')->>'publication_allowed'='false' from p123_context),'human review never publishes');
select pg_temp.ok((select public.review_prativedan_assessment_draft(pg_temp.id(11),pg_temp.id(1),pg_temp.id(55),pg_temp.id(56),proof->>'response_output_sha256','accepted','I reviewed this exact synthetic draft.')->>'replayed'='true' from p123_context),'exact review replay');
select pg_temp.reject(format('select public.review_prativedan_assessment_draft(%L,%L,%L,%L,%L,%L,%L)',pg_temp.id(11),pg_temp.id(2),pg_temp.id(55),pg_temp.id(56),(select proof->>'response_output_sha256' from p123_context),'accepted','I reviewed this exact synthetic draft.'));
reset role;
set constraints all immediate;
set constraints all deferred;
select pg_temp.ok((select count(*)=0 from public.verify_ledger(pg_temp.id(11))),'real appended ledger chain verifies');
select pg_temp.ok((select count(*)=0 from public.reports) and (select count(*)=0 from public.board_report_requests),'review did not create/release a legacy report');

-- Privileged attempt to append dedicated receipt without exact journal FK,
-- including copied target/correlation of a valid run, must fail at commit.
do $$declare action text;entry public.audit_ledger;begin
 foreach action in array array['prativedan.draft.requested','prativedan.draft.claimed','prativedan.draft.settled','prativedan.draft.reviewed'] loop
  select * into entry from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type::text=action limit 1;
  begin
   perform public.append_ledger(entry.tenant_id,entry.correlation_id,entry.actor_type,entry.actor_id,entry.agent_version,entry.model_id,entry.prompt_hash,
    entry.action_type,entry.target_ref,entry.input_hash,entry.output_hash,entry.approval_token_id,entry.approver_id,entry.pre_state_ref,entry.post_state_ref,entry.result,entry.detail);
   set constraints all immediate;
   raise exception 'copied orphan dedicated event accepted';
  exception when insufficient_privilege then null;end;
 end loop;
end $$;
-- Mutations/truncation and unreceipted privileged inserts stay closed.
select pg_temp.reject('update public.prativedan_assessment_sources set source_text=source_text||'' ''');
select pg_temp.reject('delete from public.prativedan_draft_outputs');
select pg_temp.reject('truncate public.prativedan_draft_reviews');
select pg_temp.reject(format('insert into public.prativedan_draft_claims(tenant_id,operation_key,normalized_input_text,runtime_normalized_input_sha256,claimed_receipt,expires_at) values(%L,%L,%L,%L,1,clock_timestamp()+interval ''1 minute'')',
 pg_temp.id(11),pg_temp.id(91),(select input_text from p123_context),(select encode(sha256(convert_to(input_text,'UTF8')),'hex') from p123_context)),'23503');

-- Authority changes refuse new invocation, review AND privileged readback.
savepoint membership_changed;
delete from public.tenant_users where tenant_id=pg_temp.id(11) and user_id=pg_temp.id(1);
set local role agent_ledger_writer;
select pg_temp.reject(format('select public.load_prativedan_assessment_dispatch(%L,%L,%L,%L)',pg_temp.id(11),pg_temp.id(55),(select reply->>'run_id' from p123_context),(select encode(sha256(convert_to(human_text,'UTF8')),'hex') from p123_context)));
reset role;
rollback to membership_changed;
savepoint internal_changed;
update public.users set is_axiom_internal=false where id=pg_temp.id(1);
set local role human_action_writer;
select pg_temp.reject(format('select public.read_prativedan_assessment_draft(%L,%L,%L)',pg_temp.id(11),pg_temp.id(1),(select human_text from p123_context)));
reset role;
rollback to internal_changed;
savepoint kill_engaged;
update public.kill_switch_state set engaged=true where scope_key='global';
set local role human_action_writer;
select pg_temp.reject(format('select public.preview_prativedan_assessment_source(%L,%L,%L,%L)',pg_temp.id(11),pg_temp.id(1),pg_temp.id(21),(select run_id from issued)));
reset role;
rollback to kill_engaged;

-- A SECOND real worker/controller completion carries a null declaration.
-- The finalized receipt predicate is satisfied; the stricter current declaration
-- verifier itself must refuse this payload (not merely a stale digest).
create temporary table null_issued as select (public.delegate_workload_task(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),'parikshan',pg_temp.id(22),pg_temp.id(21),pg_temp.id(71),repeat('c',64),repeat('d',64),array['control_library.read','findings.write'],clock_timestamp()+interval '10 minutes')->>'run_id')::uuid run_id;
select public.start_workload_assessment(pg_temp.id(11),(select run_id from null_issued),pg_temp.id(31),repeat('d',64),repeat('c',64),clock_timestamp()+interval '5 minutes');
select public.complete_workload_assessment(pg_temp.id(11),(select run_id from null_issued),pg_temp.id(31),repeat('d',64),
 (select library_digest from public.workload_assessment_packets where run_id=(select run_id from null_issued)),
 jsonb_set(pg_temp.result(),'{questionnaire_provenance,controls,0,questions,0,declaration}','null'),clock_timestamp()+interval '5 minutes');
select public.confirm_workload_assessment(pg_temp.id(11),(select run_id from null_issued));
select pg_temp.ok(public.board_assessment_source_valid(pg_temp.id(11),(select run_id from null_issued),pg_temp.id(21)),'null-declaration case has genuine matching finalized receipt chain');
select pg_temp.reject(format('select controller_security.prativedan123_input(%L,%L,%L)',pg_temp.id(11),pg_temp.id(21),(select run_id from null_issued)));
set constraints all immediate;
rollback;
