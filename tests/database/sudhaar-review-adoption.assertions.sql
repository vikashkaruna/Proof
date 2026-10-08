-- Appended to the real finalized-source/runtime-output fixture by the runner.
create temporary table review_fixture as select gen_random_uuid() adoption,
 'Review the declared unknown answers with supporting evidence.'::text reason;
grant select on output_fixture,review_fixture to human_action_writer;
create function pg_temp.adopt(overrides jsonb default '{}'::jsonb) returns jsonb language plpgsql as $$
declare f output_fixture; v review_fixture; d jsonb; prior text:=current_user; a uuid; reason text; body jsonb; h text;
begin
 select * into f from output_fixture; select * into v from review_fixture;
 a:=coalesce((overrides->>'adoption')::uuid,v.adoption);reason:=coalesce(overrides->>'reason',v.reason);
 body:=jsonb_build_object('tenantId',f.tenant,'actorId',f.actor,'proposalOperationKey',f.operation,'adoptionKey',a,'acknowledgeReviewOnly',true,'reason',reason);
 h:=pg_temp.hash(controller_security.canonical_questionnaire_json(body));
 set local role human_action_writer;
 d:=public.adopt_sudhaar_review(f.tenant,coalesce((overrides->>'actor')::uuid,f.actor),f.operation,a,reason,
  coalesce((overrides->>'ack')::boolean,true),h,
  coalesce(overrides->>'inputHash',pg_temp.hash(f.input)),coalesce(overrides->>'outputHash',pg_temp.hash(f.output)));
 execute format('set local role %I',prior);return d;
end $$;
-- Canonical encoder is private: compute exact body before changing SQL role.
create function pg_temp.refuse_adoption_receipt() returns trigger language plpgsql as $$begin
 if new.action_type::text='plan.review_adopted' then raise exception 'deliberate adoption receipt failure' using errcode='XX000';end if;return new;end$$;
create trigger adoption_receipt_failure before insert on public.audit_ledger for each row execute function pg_temp.refuse_adoption_receipt();
do $$begin begin perform pg_temp.adopt();raise exception 'deliberate receipt failure was ignored';exception when sqlstate 'XX000' then reset role;end;end$$;
drop trigger adoption_receipt_failure on public.audit_ledger;
select pg_temp.ok((select count(*)=0 from public.remediation_plans where purpose='source_review'),'receipt failure rolls back plan');
select pg_temp.ok((select count(*)=0 from public.plan_source_review_tasks),'receipt failure rolls back tasks');
select pg_temp.ok((select count(*)=0 from public.plan_source_review_adoptions),'receipt failure rolls back binding');
select pg_temp.ok((select count(*)=0 from public.audit_ledger where action_type='plan.review_adopted'),'receipt failure leaves no human receipt');
create temporary table adopted as select pg_temp.adopt() receipt;
set constraints all immediate;
select pg_temp.ok((select receipt->>'purpose'='source_review' and receipt->>'actionCount'='0' and receipt->>'executionAllowed'='false' from adopted),'review-only receipt');
select pg_temp.ok(pg_temp.adopt()=(select receipt from adopted),'same body/key recovers exact receipt');
select pg_temp.ok((select count(*)=1 from public.remediation_plans where purpose='source_review'),'one saved review plan');
select pg_temp.ok((select count(*)=1 from public.plan_source_review_tasks),'one actual review task');
select pg_temp.ok((select count(*)=0 from public.remediation_actions where plan_id=(select (receipt->>'planId')::uuid from adopted)),'zero remediation actions');
select pg_temp.ok((select count(*)=1 from public.audit_ledger where action_type='plan.review_adopted'),'one human adoption receipt');
select pg_temp.ok((select actor_type='human' and actor_id=(select actor::text from output_fixture) and detail->>'acknowledge_review_only'='true' and detail->>'reason'=(select reason from review_fixture) and detail->>'adoption_key'=(select adoption::text from review_fixture) and detail->>'proposal_input_hash'=pg_temp.hash((select input from output_fixture)) from public.audit_ledger where action_type='plan.review_adopted'),'actual receipt records human acknowledgment, reason and source context');
select pg_temp.ok(pg_temp.adopt(jsonb_build_object('reason','Different reasoning with supporting evidence.'))->>'error'='review_adoption_conflict','changed reason conflicts');
select pg_temp.ok(pg_temp.adopt(jsonb_build_object('adoption',gen_random_uuid()))->>'error'='review_adoption_conflict','second key cannot duplicate same proposal');
select pg_temp.ok(pg_temp.adopt(jsonb_build_object('ack',false))->>'error'='review_adoption_conflict','review acknowledgment required');
select pg_temp.ok(pg_temp.adopt(jsonb_build_object('outputHash',repeat('0',64)))->>'error'='review_source_unavailable','changed output hash refused');
select pg_temp.ok(pg_temp.adopt(jsonb_build_object('actor','99750000-0000-4000-8000-000000000002'))->>'error'='review_adoption_conflict','foreign actor cannot use original body');
savepoint downgraded_adopter;
update public.tenant_users set role='viewer' where tenant_id=(select tenant from output_fixture) and user_id=(select actor from output_fixture);
select pg_temp.ok(pg_temp.adopt()->>'error'='review_source_unavailable','replay checks current membership');
rollback to downgraded_adopter;
savepoint source_drift_adopter;
update public.findings set score=12 where id=(select (input::jsonb#>>'{findings,0,finding_id}')::uuid from output_fixture);
select pg_temp.ok(pg_temp.adopt()->>'error'='review_source_unavailable','replay checks current source');
rollback to source_drift_adopter;
do $$declare plan uuid:=(select (receipt->>'planId')::uuid from adopted);begin
 begin insert into public.remediation_actions(tenant_id,plan_id,sequence,action_type,description,risk_score,rollback_definition)
  select tenant,plan,1,'custom','Forbidden action',0,'{}'::jsonb from output_fixture;raise exception 'action attachment allowed';exception when sqlstate '42501' then if sqlerrm<>'source review cannot contain remediation actions' then raise;end if;end;
 begin insert into public.plan_source_review_tasks(tenant_id,plan_id,sequence,finding_id,task)
  select tenant,plan,2,(input::jsonb#>>'{findings,0,finding_id}')::uuid,output::jsonb#>'{review_tasks,0}' from output_fixture;raise exception 'task append allowed';exception when sqlstate '42501' then null;end;
 begin update public.remediation_plans set purpose='remediation' where id=plan;raise exception 'purpose conversion allowed';exception when sqlstate '42501' then null;end;
 begin update public.remediation_plans set status='approved' where id=plan;raise exception 'approval allowed';exception when sqlstate '42501' then null;end;
 begin update public.remediation_plans set version=2 where id=plan;raise exception 'version authority allowed';exception when sqlstate '42501' then null;end;
 begin delete from public.plan_source_review_tasks where plan_id=plan;raise exception 'task deletion allowed';exception when sqlstate '42501' then null;end;
 begin update public.plan_source_review_tasks set task='{}' where plan_id=plan;raise exception 'task mutation allowed';exception when sqlstate '42501' then null;end;
 begin truncate public.plan_source_review_tasks;raise exception 'task truncate allowed';exception when sqlstate '42501' then null;end;
 begin delete from public.plan_source_review_adoptions where plan_id=plan;raise exception 'adoption deletion allowed';exception when sqlstate '42501' then null;end;
 begin insert into public.remediation_plans(tenant_id,engagement_id,library_version,title,status,purpose)
  select tenant,engagement,input::jsonb#>>'{source,libraryVersion}','Forged review','review','source_review' from output_fixture;
  set constraints review_plan_binding immediate;raise exception 'unreceipted review allowed';exception when sqlstate '42501' then null;end;
end$$;
do $$declare role_name text;begin
 foreach role_name in array array['anon','authenticated','service_role','agent_ledger_writer','axiom_assessment_controller'] loop
  perform pg_temp.ok(not has_function_privilege(role_name,'public.adopt_sudhaar_review(uuid,uuid,uuid,uuid,text,boolean,text,text,text)','EXECUTE'),'adoption ACL '||role_name);
  perform pg_temp.ok(not has_function_privilege(role_name,'public.read_sudhaar_review_adoption_source(uuid,uuid,uuid)','EXECUTE'),'source input ACL '||role_name);
 end loop;
 foreach role_name in array array['authenticated','service_role','human_action_writer','agent_ledger_writer'] loop
  perform pg_temp.ok(not has_table_privilege(role_name,'public.plan_source_review_tasks','INSERT'),'task INSERT ACL '||role_name);
  perform pg_temp.ok(not has_table_privilege(role_name,'public.plan_source_review_adoptions','INSERT'),'adoption INSERT ACL '||role_name);
 end loop;
end$$;
do $$declare actor text; n integer; tasks integer; expected integer;begin
 foreach actor in array array['99750000-0000-4000-8000-000000000004','99750000-0000-4000-8000-000000000005'] loop
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor)::text,true);
  set local role authenticated;
  select count(*) into n from public.plan_source_review_adoptions;
  select count(*) into tasks from public.plan_source_review_tasks;
  reset role;
  expected:=case when actor='99750000-0000-4000-8000-000000000004' then 1 else 0 end;
  perform pg_temp.ok(n=expected and tasks=expected,'authenticated review read tenant boundary '||actor);
 end loop;
end$$;
do $$declare f output_fixture; p uuid:=(select (receipt->>'planId')::uuid from adopted);begin
 select * into f from output_fixture;
 begin
  set local role human_action_writer;
  perform public.append_human_ledger(f.tenant,gen_random_uuid(),'human',f.actor::text,null,null,null,'plan.review_adopted',p::text,repeat('a',64),repeat('b',64),null,null,null,null,'success','{}');
  reset role;raise exception 'generic human forged review receipt';
 exception when sqlstate '42501' then reset role; if sqlerrm<>'review adoption requires atomic resolution' then raise;end if;end;
 begin
  set local role agent_ledger_writer;
  perform public.append_agent_ledger(f.tenant,gen_random_uuid(),'agent','sudhaar','test',null,null,'plan.review_adopted',p::text,repeat('a',64),repeat('b',64),null,null,null,null,'success','{}');
  reset role;raise exception 'generic agent forged human adoption';
 exception when sqlstate '42501' then reset role; if sqlerrm<>'review adoption requires human atomic resolution' then raise;end if;end;
end$$;
select 'Sudhaar review adoption assertions: '||n from assertion_count;
