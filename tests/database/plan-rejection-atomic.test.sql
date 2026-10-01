-- A reject is one scoped human transaction: plan, actions, outstanding tokens,
-- and ledger either all commit or all roll back.
begin;
create function pg_temp.ok(value boolean,message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end $$;
create function pg_temp.denied(statement text) returns void language plpgsql as $$
begin
  begin execute statement; exception when insufficient_privilege then return; end;
  raise exception 'ASSERTION FAILED: generic service rejected a plan';
end $$;
insert into auth.users(id,email) values
 ('99009810-0000-4000-8000-000000000001','reject-founder@example.invalid');
insert into public.users(id,email,is_axiom_internal) values
 ('99009810-0000-4000-8000-000000000001','reject-founder@example.invalid',true);
insert into public.tenants(id,slug,name) values
 ('99009810-0000-4000-8000-000000000010','reject-plan-test','Reject plan test');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('99009810-0000-4000-8000-000000000010','99009810-0000-4000-8000-000000000001','founder');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('reject-plan-lib',now(),'fixture','synthetic',0);
insert into public.engagements(id,tenant_id,library_version,title)
 values('99009810-0000-4000-8000-000000000020',
  '99009810-0000-4000-8000-000000000010','reject-plan-lib','Synthetic engagement');
insert into public.remediation_plans(id,tenant_id,engagement_id,library_version,title,status)
 values('99009810-0000-4000-8000-000000000030',
  '99009810-0000-4000-8000-000000000010',
  '99009810-0000-4000-8000-000000000020','reject-plan-lib','Synthetic plan','approved');
insert into public.remediation_actions(id,tenant_id,plan_id,sequence,action_type,
 description,risk_score,rollback_definition,approval_status)
 values('99009810-0000-4000-8000-000000000040',
  '99009810-0000-4000-8000-000000000010',
  '99009810-0000-4000-8000-000000000030',1,'data.mask',
  'Synthetic action',10,'{"restore":"snapshot"}','approved');
insert into public.approval_tokens(id,tenant_id,plan_id,action_ids,approver_id,mode,
 signature,signed_payload,nonce,expires_at,status)
 values('99009810-0000-4000-8000-000000000050',
  '99009810-0000-4000-8000-000000000010',
  '99009810-0000-4000-8000-000000000030',
  array['99009810-0000-4000-8000-000000000040']::uuid[],
  '99009810-0000-4000-8000-000000000001','individual',repeat('a',64),
  '{}'::jsonb,'reject-plan-token',now()+interval '1 hour','issued');
select pg_temp.ok(not has_function_privilege('service_role',
 'public.reject_remediation_plan(uuid,uuid,uuid,uuid)','EXECUTE')
 and has_function_privilege('human_action_writer',
 'public.reject_remediation_plan(uuid,uuid,uuid,uuid)','EXECUTE'),
 'only human writer can reject');
set local role service_role;
select pg_temp.denied($s$select public.reject_remediation_plan(
 '99009810-0000-4000-8000-000000000010',
 '99009810-0000-4000-8000-000000000030',
 '99009810-0000-4000-8000-000000000001',gen_random_uuid())$s$);
reset role;

create function pg_temp.refuse_reject_audit() returns trigger language plpgsql as $$
begin
  if new.action_type='plan.rejected' then
    raise exception 'synthetic ledger outage' using errcode='23514';
  end if;
  return new;
end $$;
create trigger refuse_reject_audit before insert on public.audit_ledger
  for each row execute function pg_temp.refuse_reject_audit();
set local role human_action_writer;
do $$ begin
  begin
    perform public.reject_remediation_plan(
      '99009810-0000-4000-8000-000000000010',
      '99009810-0000-4000-8000-000000000030',
      '99009810-0000-4000-8000-000000000001',gen_random_uuid());
    raise exception 'ASSERTION FAILED: rejection committed without ledger';
  exception when check_violation then null; end;
end $$;
reset role;
select pg_temp.ok((select status='approved' and version=1 from public.remediation_plans
 where id='99009810-0000-4000-8000-000000000030')
 and (select approval_status='approved' and final_outcome is null from public.remediation_actions
 where id='99009810-0000-4000-8000-000000000040')
 and (select status='issued' from public.approval_tokens
 where id='99009810-0000-4000-8000-000000000050'),
 'ledger outage rolled back plan, action and token');
drop trigger refuse_reject_audit on public.audit_ledger;

set local role human_action_writer;
select pg_temp.ok(public.reject_remediation_plan(
 '99009810-0000-4000-8000-000000000010',
 '99009810-0000-4000-8000-000000000030',
 '99009810-0000-4000-8000-000000000001',gen_random_uuid())
 = '{"status":"cancelled","skippedActions":1,"revokedTokens":1}'::jsonb,
 'valid founder atomically rejects and revokes');
select pg_temp.ok(public.reject_remediation_plan(
 '99009810-0000-4000-8000-000000000010',
 '99009810-0000-4000-8000-000000000030',
 '99009810-0000-4000-8000-000000000001',gen_random_uuid())->>'error'
 = 'plan_not_rejectable','repeat cannot forge another success');
reset role;
select pg_temp.ok((select status='cancelled' and version=2 from public.remediation_plans
 where id='99009810-0000-4000-8000-000000000030')
 and (select approval_status='skipped' and execution_status='skipped'
   and final_outcome='skipped' from public.remediation_actions
   where id='99009810-0000-4000-8000-000000000040')
 and (select status='revoked' and revoked_at is not null from public.approval_tokens
   where id='99009810-0000-4000-8000-000000000050')
 and (select count(*)=1 from public.audit_ledger
   where tenant_id='99009810-0000-4000-8000-000000000010'
   and action_type='plan.rejected'),
 'one coherent rejection proof');
rollback;
