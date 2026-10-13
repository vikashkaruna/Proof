-- Disposable SQL contract fixtures, NOT live named-agent acceptance.
-- Uses actual finalized assessment/controller and append_ledger paths.
begin;
-- Disposable fixture custody only; rolled back here or destroyed with the owned container.
-- No SVID/PostgREST/private-channel identity proof is inferred from SET ROLE.
create function pg_temp.id(n int) returns uuid language sql immutable as $$select ('51230000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m; end if; end$$;
create function pg_temp.reject(q text,code text default '42501') returns void language plpgsql as $$begin begin execute q; execute 'set constraints all immediate'; exception when others then if sqlstate=code then return; end if; raise; end; raise exception 'Unexpected success'; end$$;
-- Exercise the actual migration predicate with rollback-isolated grants.
select pg_temp.ok(controller_security.prativedan126_role_safe(),'exclusive initial controller role');
grant axiom_prativedan_controller to authenticator with admin false,inherit false,set true;
select pg_temp.ok(not controller_security.prativedan126_role_safe(),'preexisting inbound SET rejected');
revoke axiom_prativedan_controller from authenticator;
grant axiom_prativedan_controller to agent_ledger_writer with admin false,inherit true,set false;
select pg_temp.ok(not controller_security.prativedan126_role_safe(),'preexisting inbound INHERIT rejected');
revoke axiom_prativedan_controller from agent_ledger_writer;
grant axiom_prativedan_controller to service_role with admin true,inherit false,set false;
select pg_temp.ok(not controller_security.prativedan126_role_safe(),'foreign ADMIN-only custody rejected');
revoke axiom_prativedan_controller from service_role;
select pg_temp.ok(exists(select 1 from pg_catalog.pg_auth_members m
 join pg_catalog.pg_roles r on r.oid=m.roleid join pg_catalog.pg_roles creator on creator.oid=m.member
 where r.rolname='axiom_prativedan_controller' and creator.rolname=current_user
 and m.admin_option and not m.inherit_option and not m.set_option),'actual creator ADMIN-only membership');
select pg_temp.ok(controller_security.prativedan126_role_safe(),'migration creator ADMIN-only allowed');
grant agent_ledger_writer to axiom_prativedan_controller with admin false,inherit false,set false;
select pg_temp.ok(not controller_security.prativedan126_role_safe(),'outbound privilege rejected');
revoke agent_ledger_writer from axiom_prativedan_controller;
alter role axiom_prativedan_controller login;
select pg_temp.ok(not controller_security.prativedan126_role_safe(),'unsafe role attribute rejected');
alter role axiom_prativedan_controller nologin;
select pg_temp.ok(controller_security.prativedan126_role_safe(),'safe custody restored');
-- Explicit owned fixture provision follows the guard checks, never production.
grant axiom_prativedan_controller to postgres with set true;
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
select set_config('request.jwt.claims',jsonb_build_object('role','axiom_prativedan_controller','sub',pg_temp.id(99),
 'tenant_id',pg_temp.id(11),'iat',floor(extract(epoch from clock_timestamp())),
 'exp',floor(extract(epoch from clock_timestamp()))+3600)::text,true);
grant select,update on p123_context to axiom_prativedan_controller;

-- No shared-role bypass, even with copied controller JWT metadata.
set local role agent_ledger_writer;
select pg_temp.reject(format('select public.load_prativedan_assessment_dispatch(%L,%L,%L,%L)',
 pg_temp.id(11),pg_temp.id(55),(select reply->>'run_id' from p123_context),(select encode(sha256(convert_to(human_text,'UTF8')),'hex') from p123_context)));
select pg_temp.reject(format('select public.claim_prativedan_assessment_draft(%L,%L,%L,%L,%L,%L::jsonb)',
 pg_temp.id(11),pg_temp.id(55),(select reply->>'run_id' from p123_context),(select encode(sha256(convert_to(human_text,'UTF8')),'hex') from p123_context),
 (select input_text from p123_context),pg_temp.authority()));
select pg_temp.reject(format('select public.append_agent_ledger(%L,%L,%L,%L,%L,null,null,%L,%L,%L,null,null,null,null,null,%L,%L::jsonb)',
 pg_temp.id(11),pg_temp.id(55),'agent','prativedan','0.1.0','report.generated',pg_temp.id(21),repeat('a',64),'pending',
 jsonb_build_object('phase','started','run_id',(select reply->>'run_id' from p123_context))));
reset role;
select pg_temp.ok(not has_function_privilege('axiom_prativedan_controller',
 'public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)','EXECUTE'),'exclusive controller cannot arbitrary append');
do $$declare role_name text;begin
 foreach role_name in array array['authenticator','agent_ledger_writer','service_role','human_action_writer','axiom_assessment_controller'] loop
  perform pg_temp.ok(not pg_has_role(role_name,'axiom_prativedan_controller','MEMBER'),'no authenticator/shared/worker controller membership provisioned');
 end loop;
end $$;
do $$declare f record;role_name text;begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
  and p.proname in ('load_prativedan_assessment_dispatch','claim_prativedan_assessment_draft',
   'read_prativedan_assessment_runtime_receipts','settle_prativedan_assessment_draft','record_prativedan_assessment_phase') loop
  foreach role_name in array array['anon','authenticated','service_role','human_action_writer','agent_ledger_writer','axiom_assessment_controller'] loop
   perform pg_temp.ok(not has_function_privilege(role_name,f.oid,'EXECUTE'),'all shared/human dedicated-runtime overloads revoked');
  end loop;
 end loop;
end $$;
set local role axiom_prativedan_controller;
select pg_temp.reject(format('select public.claim_prativedan_assessment_draft(%L,%L,%L,%L,%L,%L::jsonb)',
 pg_temp.id(11),pg_temp.id(55),(select reply->>'run_id' from p123_context),(select encode(sha256(convert_to(human_text,'UTF8')),'hex') from p123_context),
 (select input_text from p123_context),jsonb_set(pg_temp.authority(),'{registration_version}','2')));
reset role;
savepoint revoked_attestation;
update public.mfa_session_attestations set revoked_at=clock_timestamp() where id=pg_temp.id(96);
set local role axiom_prativedan_controller;
select pg_temp.reject(format('select public.claim_prativedan_assessment_draft(%L,%L,%L,%L,%L,%L::jsonb)',
 pg_temp.id(11),pg_temp.id(55),(select reply->>'run_id' from p123_context),(select encode(sha256(convert_to(human_text,'UTF8')),'hex') from p123_context),
 (select input_text from p123_context),pg_temp.authority()));
reset role;
rollback to revoked_attestation;
reset role;
savepoint revoked_factor;
update public.user_mfa_factors set status='revoked',revoked_at=clock_timestamp() where id=pg_temp.id(97);
set local role axiom_prativedan_controller;
select pg_temp.reject(format('select public.claim_prativedan_assessment_draft(%L,%L,%L,%L,%L,%L::jsonb)',
 pg_temp.id(11),pg_temp.id(55),(select reply->>'run_id' from p123_context),(select encode(sha256(convert_to(human_text,'UTF8')),'hex') from p123_context),
 (select input_text from p123_context),pg_temp.authority()));
reset role;
rollback to revoked_factor;
reset role;
savepoint revoked_credential;
update controller_security.prativedan_credentials set revoked_at=clock_timestamp() where id=pg_temp.id(99);
set local role axiom_prativedan_controller;
select pg_temp.reject(format('select public.claim_prativedan_assessment_draft(%L,%L,%L,%L,%L,%L::jsonb)',
 pg_temp.id(11),pg_temp.id(55),(select reply->>'run_id' from p123_context),(select encode(sha256(convert_to(human_text,'UTF8')),'hex') from p123_context),
 (select input_text from p123_context),pg_temp.authority()));
reset role;
rollback to revoked_credential;
reset role;
savepoint founder_demoted;
update public.tenant_users set role='owner' where tenant_id=pg_temp.id(11) and user_id=pg_temp.id(1);
set local role axiom_prativedan_controller;
select pg_temp.reject(format('select public.claim_prativedan_assessment_draft(%L,%L,%L,%L,%L,%L::jsonb)',
 pg_temp.id(11),pg_temp.id(55),(select reply->>'run_id' from p123_context),(select encode(sha256(convert_to(human_text,'UTF8')),'hex') from p123_context),
 (select input_text from p123_context),pg_temp.authority()));
reset role;
rollback to founder_demoted;
reset role;
savepoint internal_removed;
update public.users set is_axiom_internal=false where id=pg_temp.id(1);
set local role axiom_prativedan_controller;
select pg_temp.reject(format('select public.claim_prativedan_assessment_draft(%L,%L,%L,%L,%L,%L::jsonb)',
 pg_temp.id(11),pg_temp.id(55),(select reply->>'run_id' from p123_context),(select encode(sha256(convert_to(human_text,'UTF8')),'hex') from p123_context),
 (select input_text from p123_context),pg_temp.authority()));
reset role;
rollback to internal_removed;
reset role;
savepoint killed;
update public.kill_switch_state set engaged=true where scope_key='global';
set local role axiom_prativedan_controller;
select pg_temp.reject(format('select public.claim_prativedan_assessment_draft(%L,%L,%L,%L,%L,%L::jsonb)',
 pg_temp.id(11),pg_temp.id(55),(select reply->>'run_id' from p123_context),(select encode(sha256(convert_to(human_text,'UTF8')),'hex') from p123_context),
 (select input_text from p123_context),pg_temp.authority()));
reset role;
rollback to killed;
reset role;
savepoint registration_retired;
update public.workload_identities set status='disabled',version=version+1 where id=pg_temp.id(98);
set local role axiom_prativedan_controller;
select pg_temp.reject(format('select public.claim_prativedan_assessment_draft(%L,%L,%L,%L,%L,%L::jsonb)',
 pg_temp.id(11),pg_temp.id(55),(select reply->>'run_id' from p123_context),(select encode(sha256(convert_to(human_text,'UTF8')),'hex') from p123_context),
 (select input_text from p123_context),pg_temp.authority()));
reset role;
rollback to registration_retired;
reset role;
savepoint registration_aba;
update public.workload_identities set version=version+2 where id=pg_temp.id(98);
set local role axiom_prativedan_controller;
select pg_temp.reject(format('select public.claim_prativedan_assessment_draft(%L,%L,%L,%L,%L,%L::jsonb)',
 pg_temp.id(11),pg_temp.id(55),(select reply->>'run_id' from p123_context),(select encode(sha256(convert_to(human_text,'UTF8')),'hex') from p123_context),
 (select input_text from p123_context),pg_temp.authority()));
reset role;
rollback to registration_aba;
set local role axiom_prativedan_controller;
select pg_temp.reject(format('select public.record_prativedan_assessment_phase(%L,%L,%L,%L,%L,%L,%L::jsonb)',
 pg_temp.id(11),pg_temp.id(55),(select reply->>'run_id' from p123_context),(select encode(sha256(convert_to(human_text,'UTF8')),'hex') from p123_context),
 'completed',repeat('a',64),pg_temp.authority()));
update p123_context set claim=public.claim_prativedan_assessment_draft(pg_temp.id(11),pg_temp.id(55),(reply->>'run_id')::uuid,
 encode(sha256(convert_to(human_text,'UTF8')),'hex'),input_text,pg_temp.authority());
select pg_temp.ok((select claim->>'claimed'='true' from p123_context),'exclusive first claim');
select pg_temp.ok((select public.claim_prativedan_assessment_draft(pg_temp.id(11),pg_temp.id(55),(reply->>'run_id')::uuid,
 encode(sha256(convert_to(human_text,'UTF8')),'hex'),input_text,pg_temp.authority())->>'claimed'='false' from p123_context),'one shot replay cannot reinvoke');
set local role axiom_prativedan_controller;
select pg_temp.reject(format('select public.record_prativedan_assessment_phase(%L,%L,%L,%L,%L,%L,%L::jsonb)',
 pg_temp.id(11),pg_temp.id(55),(select reply->>'run_id' from p123_context),(select encode(sha256(convert_to(human_text,'UTF8')),'hex') from p123_context),
 'completed',repeat('a',64),pg_temp.authority()));
update p123_context set started=(public.record_prativedan_assessment_phase(pg_temp.id(11),pg_temp.id(55),(reply->>'run_id')::uuid,
 encode(sha256(convert_to(human_text,'UTF8')),'hex'),'started',null,pg_temp.authority())->>'id')::bigint;
select pg_temp.ok((select public.record_prativedan_assessment_phase(pg_temp.id(11),pg_temp.id(55),(reply->>'run_id')::uuid,
 encode(sha256(convert_to(human_text,'UTF8')),'hex'),'started',null,pg_temp.authority())->>'id'=started::text from p123_context),'phase replay retains exact receipt');
select pg_temp.reject(format('select public.record_prativedan_assessment_phase(%L,%L,%L,%L,%L,%L,%L::jsonb)',
 pg_temp.id(11),pg_temp.id(55),(select reply->>'run_id' from p123_context),(select encode(sha256(convert_to(human_text,'UTF8')),'hex') from p123_context),
 'started',repeat('a',64),pg_temp.authority()));
update p123_context set completed=(public.record_prativedan_assessment_phase(pg_temp.id(11),pg_temp.id(55),(reply->>'run_id')::uuid,
 encode(sha256(convert_to(human_text,'UTF8')),'hex'),'completed',repeat('a',64),pg_temp.authority())->>'id')::bigint;
select pg_temp.ok((select public.read_prativedan_assessment_runtime_receipts(pg_temp.id(11),pg_temp.id(55),(reply->>'run_id')::uuid,
 encode(sha256(convert_to(human_text,'UTF8')),'hex'),started,completed,pg_temp.authority())->>'runtime_output_sha256'=repeat('a',64)
 from p123_context),'actual fixed receipts independently read committed output hash');
select pg_temp.reject(format('select public.record_prativedan_assessment_phase(%L,%L,%L,%L,%L,%L,%L::jsonb)',
 pg_temp.id(11),pg_temp.id(55),(select reply->>'run_id' from p123_context),(select encode(sha256(convert_to(human_text,'UTF8')),'hex') from p123_context),
 'completed',repeat('b',64),pg_temp.authority()));
reset role;
select pg_temp.ok((select count(*)=1 from public.prativedan_controller_admissions),'one immutable admission');
select pg_temp.ok((select count(*)=2 from public.prativedan_controller_phases),'two fixed phases; no arbitrary metadata');
select pg_temp.ok(not exists(select 1 from public.verify_ledger(pg_temp.id(11))),'real ledger verifies');
set constraints all immediate;
rollback;
