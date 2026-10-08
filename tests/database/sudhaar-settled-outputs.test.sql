-- Real PostgreSQL source, human authority, receipt and atomic Sudhaar output checks.
begin;
create temporary table assertion_count(n integer);insert into assertion_count values(0);
create function pg_temp.ok(v boolean, m text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'ASSERTION FAILED: %', m; end if;update assertion_count set n=n+1; end $$;

insert into auth.users(id, email)
  select ('99750000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'sudhaar-output-' || n || '@example.invalid'
  from generate_series(1, 5) n;

insert into public.users(id, email, full_name, is_axiom_internal)
  values
  ('99750000-0000-4000-8000-000000000001', 'sudhaar-output-1@example.invalid', 'Manager User', false),
  ('99750000-0000-4000-8000-000000000002', 'sudhaar-output-2@example.invalid', 'Internal Founder', true),
  ('99750000-0000-4000-8000-000000000003', 'sudhaar-output-3@example.invalid', 'External Founder', false),
  ('99750000-0000-4000-8000-000000000004', 'sudhaar-output-4@example.invalid', 'Viewer User', false),
  ('99750000-0000-4000-8000-000000000005', 'sudhaar-output-5@example.invalid', 'Foreign Tenant User', false);

insert into public.tenants(id, slug, name)
  values
  ('99750000-0000-4000-8000-000000000010', 'sudhaar-output-tenant-a', 'Board Tenant A'),
  ('99750000-0000-4000-8000-000000000020', 'sudhaar-output-tenant-b', 'Board Tenant B');

insert into public.tenant_users(tenant_id, user_id, role)
  values
  ('99750000-0000-4000-8000-000000000010', '99750000-0000-4000-8000-000000000001', 'admin'),
  ('99750000-0000-4000-8000-000000000010', '99750000-0000-4000-8000-000000000002', 'founder'),
  ('99750000-0000-4000-8000-000000000010', '99750000-0000-4000-8000-000000000003', 'founder'),
  ('99750000-0000-4000-8000-000000000010', '99750000-0000-4000-8000-000000000004', 'viewer'),
  ('99750000-0000-4000-8000-000000000020', '99750000-0000-4000-8000-000000000005', 'admin');

insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('sudhaar-output-test-lib', now(), 'fixture', 'synthetic', 1);

insert into public.controls(id, library_version, title, obligation, domain, severity, citations, evidence_required, assessment_questions, scoring, remediation_patterns, introduced_in_version)
  values ('BOARD-001', 'sudhaar-output-test-lib', 'Synthetic control', 'Fixture only', 'GOV', 'low', '[]', '[]', '[]', '{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":1000000}', '{}', 'sudhaar-output-test-lib');

insert into public.estates(id, tenant_id, name, slug)
  values ('99750000-0000-4000-8000-000000000050', '99750000-0000-4000-8000-000000000010', 'Board estate', 'sudhaar-output-estate');

insert into public.engagements(id, tenant_id, estate_id, library_version, title)
  values
  ('99750000-0000-4000-8000-000000000030', '99750000-0000-4000-8000-000000000010', '99750000-0000-4000-8000-000000000050', 'sudhaar-output-test-lib', 'Board Engagement');

insert into public.workload_identities(id, tenant_id, agent_name, spiffe_id, status)
  values ('99750000-0000-4000-8000-000000000041', '99750000-0000-4000-8000-000000000010', 'parikshan', 'spiffe://axiom.test/parikshan', 'active');

-- Produce an assessment through the real worker/confirmation RPC chain.
create temporary table board_issued as
select (public.delegate_workload_task(
  '99750000-0000-4000-8000-000000000010',
  '99750000-0000-4000-8000-000000000001',
  '99750000-0000-4000-8000-000000000041', 'parikshan',
  '99750000-0000-4000-8000-000000000050',
  '99750000-0000-4000-8000-000000000030', gen_random_uuid(),
  repeat('a',64), repeat('b',64),
  array['control_library.read','findings.write'], clock_timestamp()+interval '10 minutes'
)->>'run_id')::uuid run_id;
grant select on board_issued to service_role;

select public.start_workload_assessment(
  '99750000-0000-4000-8000-000000000010', (select run_id from board_issued),
  '99750000-0000-4000-8000-000000000041', repeat('b',64), repeat('a',64),
  clock_timestamp()+interval '5 minutes');
select public.complete_workload_assessment(
  '99750000-0000-4000-8000-000000000010', (select run_id from board_issued),
  '99750000-0000-4000-8000-000000000041', repeat('b',64),
  (select library_digest from public.workload_assessment_packets where run_id=(select run_id from board_issued)),
  '{"library_version":"sudhaar-output-test-lib","posture_score":85,"estimated_exposure_inr":1000000,"findings":[{"control_id":"BOARD-001","score":85,"risk_points":0,"rationale":"Synthetic fixture"}]}'::jsonb,
  clock_timestamp()+interval '5 minutes');

select pg_temp.ok(public.confirm_workload_assessment('99750000-0000-4000-8000-000000000010',(select run_id from board_issued))->>'status'='succeeded','real finalized source');
create temporary table output_fixture as select
 '99750000-0000-4000-8000-000000000010'::uuid tenant,
 '99750000-0000-4000-8000-000000000001'::uuid actor,
 '99750000-0000-4000-8000-000000000030'::uuid engagement,
 gen_random_uuid() operation,
 jsonb_build_object('tenant_id',p.tenant_id,'engagement_id',p.engagement_id,'title','Synthetic review',
 'source',jsonb_build_object('assessmentRunId',p.run_id,'libraryVersion',p.library_version,
 'libraryDigest',p.library_digest,'resultDigest',p.result_digest,'finalizedReceipt',p.finalized_receipt::text),
 'findings',jsonb_build_array(jsonb_build_object('finding_id',f.id,'control_id',f.control_id,'title','Synthetic control',
 'severity','low','score_decimal',f.score::text,'risk_points_decimal',f.risk_points::text,
 'answer_state','unavailable','applicability_state','unavailable','answer_counts',null)))::text input,
 null::text output, null::uuid run, null::text started, null::text completed
 from public.workload_assessment_packets p join public.findings f on f.tenant_id=p.tenant_id and f.engagement_id=p.engagement_id
 where p.run_id=(select run_id from board_issued);
update output_fixture set output=jsonb_build_object('schema_version',1,'kind','remediation_proposal','title','Synthetic review',
 'source',input::jsonb->'source','persistence','not_saved','review_required',true,'escalate',true,'execution_allowed',false,
 'provisional_actions','[]'::jsonb,'aggregate_records_affected',null,'aggregate_systems','[]'::jsonb,
 'review_tasks',jsonb_build_array(jsonb_build_object('sequence',1,'finding_id',input::jsonb#>>'{findings,0,finding_id}',
 'control_id','BOARD-001','title','Synthetic control','reason','provenance_unavailable',
 'instruction','Review the recorded questionnaire, applicability and supporting evidence before proposing corrective work. No finding is closed by this proposal.')))::text;
create function pg_temp.hash(t text) returns text language sql immutable as $$select encode(pg_catalog.sha256(convert_to(t,'UTF8')),'hex')$$;
create function pg_temp.start_output() returns uuid language plpgsql as $$
declare f output_fixture; d jsonb; prior text:=current_user;
begin select * into f from output_fixture; set local role human_action_writer;
 d:=public.record_generic_agent_run_start(f.tenant,f.actor,'sudhaar',f.engagement,f.operation,pg_temp.hash(f.input));
 execute format('set local role %I',prior); return (d->>'run_id')::uuid;
end$$;
update output_fixture set run=pg_temp.start_output();
create function pg_temp.output_pair() returns void language plpgsql as $$
declare f output_fixture; sid bigint; eid bigint; prior text:=current_user;
begin select * into f from output_fixture; set local role agent_ledger_writer;
 sid:=public.append_agent_ledger(f.tenant,f.operation,'agent','sudhaar','1.0.0',null,null,'plan.generated',f.engagement::text,
 pg_temp.hash(f.input),null,null,null,null,null,'pending',jsonb_build_object('phase','started','run_id',f.run,'request_hash',pg_temp.hash(f.input)));
 eid:=public.append_agent_ledger(f.tenant,f.operation,'agent','sudhaar','1.0.0',null,null,'plan.generated',f.engagement::text,
 pg_temp.hash(f.input),pg_temp.hash(f.output),null,null,null,null,'success',jsonb_build_object('phase','completed','run_id',f.run,'request_hash',pg_temp.hash(f.input),'started_entry',sid::text));
 execute format('set local role %I',prior); update output_fixture set started=sid::text,completed=eid::text;
end$$;
select pg_temp.output_pair();
create function pg_temp.capture(o jsonb default '{}') returns jsonb language plpgsql as $$
declare f output_fixture; d jsonb; prior text:=current_user; it text; ot text;
begin select * into f from output_fixture; it:=coalesce(o->>'input',f.input);ot:=coalesce(o->>'output',f.output);
 set local role human_action_writer;
 begin d:=public.settle_sudhaar_output(coalesce((o->>'tenant')::uuid,f.tenant),coalesce((o->>'actor')::uuid,f.actor),
 coalesce((o->>'run')::uuid,f.run),coalesce((o->>'engagement')::uuid,f.engagement),coalesce((o->>'operation')::uuid,f.operation),
 coalesce(o->>'inputHash',pg_temp.hash(it)),it,ot,coalesce(o->>'outputHash',pg_temp.hash(ot)),
 coalesce((o->>'latency')::integer,1),0,0,0,coalesce(o->>'started',f.started),coalesce(o->>'completed',f.completed));
 exception when others then execute format('set local role %I',prior);raise;end;
 execute format('set local role %I',prior);return d;
end$$;
create function pg_temp.recover(o jsonb default '{}') returns jsonb language plpgsql as $$
declare f output_fixture; d jsonb; prior text:=current_user;
begin select * into f from output_fixture;set local role human_action_writer;
 begin d:=public.recover_sudhaar_output(coalesce((o->>'tenant')::uuid,f.tenant),coalesce((o->>'actor')::uuid,f.actor),
 coalesce((o->>'engagement')::uuid,f.engagement),coalesce((o->>'operation')::uuid,f.operation),coalesce(o->>'input',f.input));
 exception when others then execute format('set local role %I',prior);raise;end;
 execute format('set local role %I',prior);return d;
end$$;
select pg_temp.ok(pg_temp.recover()->>'error'='output_unrecoverable','running output remains uncertain');
select pg_temp.ok(pg_temp.recover(jsonb_build_object('operation',gen_random_uuid()))->>'missing'='true','new operation has no prior run');
select pg_temp.ok(pg_temp.capture(jsonb_build_object('actor','99750000-0000-4000-8000-000000000004'))->>'error'='output_context_refused','viewer refused');
select pg_temp.ok(pg_temp.capture(jsonb_build_object('actor','99750000-0000-4000-8000-000000000002'))->>'error'='output_context_refused','other founder cannot claim output');
select pg_temp.ok(pg_temp.capture(jsonb_build_object('tenant','99750000-0000-4000-8000-000000000020'))->>'error'='output_context_refused','foreign tenant refused');
select pg_temp.ok(pg_temp.capture(jsonb_build_object('inputHash',repeat('a',64)))->>'error'='output_context_refused','wrong input hash refused');
select pg_temp.ok(pg_temp.capture(jsonb_build_object('outputHash',repeat('a',64)))->>'error'='output_context_refused','wrong output hash refused');
select pg_temp.ok(pg_temp.capture(jsonb_build_object('operation',gen_random_uuid()))->>'error'='output_context_refused','operation mismatch refused');
select pg_temp.ok(pg_temp.capture(jsonb_build_object('run',gen_random_uuid()))->>'error'='output_context_refused','run mismatch refused');
select pg_temp.ok(pg_temp.capture(jsonb_build_object('started',(select completed from output_fixture)))->>'error'='receipts_unconfirmed','swapped actual runtime receipt refused');
-- Every source mutation uses its new genuine hash. This catches trust in hash-only claims.
do $$declare f output_fixture;k text; v jsonb;begin
 select * into f from output_fixture;
 foreach k in array array['assessmentRunId','libraryVersion','libraryDigest','resultDigest','finalizedReceipt'] loop
 v:=jsonb_set(f.input::jsonb,array['source',k],to_jsonb(case k when 'assessmentRunId' then gen_random_uuid()::text when 'finalizedReceipt' then '1' else 'forged' end));
 perform pg_temp.ok(pg_temp.capture(jsonb_build_object('input',v::text))->>'error'='output_context_refused','forged source '||k);
 end loop;
 foreach k in array array['finding_id','control_id','title','severity','score_decimal','risk_points_decimal','answer_state','applicability_state','answer_counts'] loop
 v:=jsonb_set(f.input::jsonb,array['findings','0',k],case k when 'finding_id' then to_jsonb(gen_random_uuid()::text)
 when 'score_decimal' then '"33"'::jsonb when 'risk_points_decimal' then '"7"'::jsonb
 when 'answer_counts' then '{}'::jsonb else '"forged"'::jsonb end);
 perform pg_temp.ok(pg_temp.capture(jsonb_build_object('input',v::text))->>'error'='output_context_refused','forged finding '||k);
 end loop;
 foreach k in array array['source','title','kind','schema_version','persistence','review_required','escalate','execution_allowed','provisional_actions','aggregate_records_affected','aggregate_systems'] loop
 v:=jsonb_set(f.output::jsonb,array[k],'"forged"'::jsonb);
 perform pg_temp.ok(pg_temp.capture(jsonb_build_object('output',v::text))->>'error'='output_context_refused','forged output '||k);
 end loop;
 foreach k in array array['sequence','finding_id','control_id','title','reason','instruction'] loop
 v:=jsonb_set(f.output::jsonb,array['review_tasks','0',k],'"forged"'::jsonb);
 begin perform pg_temp.ok(pg_temp.capture(jsonb_build_object('output',v::text))->>'error'='output_context_refused','forged review task '||k);
 exception when invalid_text_representation then null;end;
 end loop;
end$$;
select pg_temp.ok((select status='running' from public.agent_runs where id=(select run from output_fixture)),'all refusals preserve running state');
select pg_temp.ok((select count(*)=0 from public.sudhaar_settled_outputs),'all refusals have no output');
-- Deliberate insert failure must roll back controller settlement and receipt.
create function pg_temp.refuse_capture() returns trigger language plpgsql as $$begin raise exception 'test capture failure';end$$;
create trigger test_capture_failure before insert on public.sudhaar_settled_outputs for each row execute function pg_temp.refuse_capture();
do $$begin begin perform pg_temp.capture(); raise exception 'capture failure undetected'; exception when raise_exception then
 if sqlerrm<>'test capture failure' then raise;end if;end;end$$;
drop trigger test_capture_failure on public.sudhaar_settled_outputs;
select pg_temp.ok((select status='running' from public.agent_runs where id=(select run from output_fixture)),'atomic failure rolls back run');
select pg_temp.ok(not exists(select 1 from public.audit_ledger where action_type='agent.invocation.settled' and target_ref=(select run::text from output_fixture)),'atomic failure rolls back settled receipt');
-- Semantically identical output with different wire bytes is not the runtime receipt hash.
do $$begin
 begin perform pg_temp.capture(jsonb_build_object('output',(select output||' ' from output_fixture)));
 raise exception 'wire mismatch accepted';exception when check_violation then null;end;
end$$;
select pg_temp.ok((select status='running' from public.agent_runs where id=(select run from output_fixture)),'wire hash mismatch rolls back settlement');
select pg_temp.ok(pg_temp.capture()->>'status'='succeeded','genuine atomic capture succeeds');
select pg_temp.ok(pg_temp.capture()->>'replayed'='true','same exact capture recovers');
select pg_temp.ok(pg_temp.capture(jsonb_build_object('latency',2))->>'error'='output_context_refused','changed duplicate telemetry refused');
select pg_temp.ok(pg_temp.recover()->>'output_text'=(select output from output_fixture),'exact output bytes recover');
select pg_temp.ok((select count(*)=1 from public.sudhaar_settled_outputs),'one immutable output');
select pg_temp.ok((select count(*)=1 from public.audit_ledger where action_type='agent.invocation.settled' and target_ref=(select run::text from output_fixture)),'one controller settlement');
select pg_temp.ok(pg_temp.recover(jsonb_build_object('actor','99750000-0000-4000-8000-000000000002'))->>'error'='output_context_refused','matching source does not transfer actor');
savepoint downgraded;
update public.tenant_users set role='viewer' where tenant_id=(select tenant from output_fixture) and user_id=(select actor from output_fixture);
select pg_temp.ok(pg_temp.recover()->>'error'='output_context_refused','current downgraded membership refused');
rollback to downgraded;
savepoint killed;
update public.kill_switch_state set engaged=true where scope_key='global';
select pg_temp.ok(pg_temp.recover()->>'error'='output_context_refused','current kill switch refused');
rollback to killed;
savepoint drifted;
update public.findings set score=12 where id=(select (input::jsonb#>>'{findings,0,finding_id}')::uuid from output_fixture);
select pg_temp.ok(pg_temp.recover()->>'error'='output_context_refused','current finding drift refused');
rollback to drifted;
-- Privileged fixtures cannot rewrite immutable output either.
do $$begin
 begin update public.sudhaar_settled_outputs set output_text='{}';raise exception 'update allowed';
 exception when sqlstate '42501' then null;end;
 begin delete from public.sudhaar_settled_outputs;raise exception 'delete allowed';
 exception when sqlstate '42501' then null;end;
end$$;
select pg_temp.ok(not has_table_privilege('service_role','public.sudhaar_settled_outputs','SELECT'),'service cannot read exact outputs directly');
select pg_temp.ok(not has_table_privilege('human_action_writer','public.sudhaar_settled_outputs','INSERT'),'human writer has no direct insert');
select pg_temp.ok(not has_table_privilege('agent_ledger_writer','public.sudhaar_settled_outputs','INSERT'),'runtime has no insert credential');
do $$declare role_name text;begin
 foreach role_name in array array['anon','authenticated','service_role','agent_ledger_writer','axiom_assessment_controller'] loop
 perform pg_temp.ok(not has_function_privilege(role_name,'public.settle_sudhaar_output(uuid,uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,integer,numeric,text,text)','EXECUTE'),'capture ACL '||role_name);
 perform pg_temp.ok(not has_function_privilege(role_name,'public.recover_sudhaar_output(uuid,uuid,uuid,uuid,text)','EXECUTE'),'recovery ACL '||role_name);
 perform pg_temp.ok(not has_function_privilege(role_name,'controller_security.sudhaar_output_source_valid(uuid,uuid,uuid,text)','EXECUTE'),'source alias ACL '||role_name);
 end loop;
end$$;
-- Existing terminal hash-only runs cannot be imported into exact-output history.
savepoint legacy;
update output_fixture set operation=gen_random_uuid();
update output_fixture set run=pg_temp.start_output();
select pg_temp.output_pair();
do $$declare f output_fixture;d jsonb;begin select * into f from output_fixture;set local role human_action_writer;
 d:=public.record_generic_agent_run_finish(f.tenant,f.actor,f.run,'sudhaar',f.engagement,f.operation,pg_temp.hash(f.input),
 'succeeded',null,1,0,0,0,f.started,f.completed,pg_temp.hash(f.output));reset role;
 perform pg_temp.ok(d->>'status'='succeeded','legacy settlement succeeds normally');end$$;
select pg_temp.ok(pg_temp.capture()->>'error'='output_unrecoverable','no legacy capture import');
select pg_temp.ok(pg_temp.recover()->>'error'='output_unrecoverable','no legacy output inference');
rollback to legacy;
select 'Sudhaar SQL assertions: '||n from assertion_count;
rollback;
