-- 0099: a shared producer credential is neither a human session nor a ledger
-- author, and cannot start execution for a plan whose approval was spent,
-- revoked or never claimed.
begin;
create function pg_temp.ok(value boolean,message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end $$;
create function pg_temp.denied(statement text) returns void language plpgsql as $$
begin
  begin execute statement; exception when insufficient_privilege then return; end;
  raise exception 'ASSERTION FAILED: not denied: %',statement;
end $$;

-- ── privilege matrix ────────────────────────────────────────────────────
select pg_temp.ok(
  not has_function_privilege('service_role','public.append_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)','EXECUTE')
  and not has_function_privilege('anon','public.append_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)','EXECUTE')
  and not has_function_privilege('authenticated','public.append_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)','EXECUTE')
  and not has_function_privilege('human_action_writer','public.append_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)','EXECUTE')
  and not has_function_privilege('agent_ledger_writer','public.append_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)','EXECUTE'),
  'no API role may call the raw ledger append');
select pg_temp.ok(
  has_function_privilege('human_action_writer','public.append_human_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)','EXECUTE')
  and not has_function_privilege('agent_ledger_writer','public.append_human_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)','EXECUTE')
  and not has_function_privilege('service_role','public.append_human_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)','EXECUTE')
  and has_function_privilege('agent_ledger_writer','public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)','EXECUTE')
  and not has_function_privilege('human_action_writer','public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)','EXECUTE')
  and not has_function_privilege('service_role','public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)','EXECUTE'),
  'each wrapper is executable only by its own writer');
select pg_temp.ok(
  not has_function_privilege('service_role','public.start_execution_batch(uuid,uuid,text,uuid,text,text,text,integer,boolean,text,uuid[])','EXECUTE')
  and has_function_privilege('service_role','public.start_claimed_execution_batch(uuid,uuid,text,uuid,text,text,text,integer,boolean,text,uuid[])','EXECUTE')
  and not has_function_privilege('anon','public.start_claimed_execution_batch(uuid,uuid,text,uuid,text,text,text,integer,boolean,text,uuid[])','EXECUTE')
  and not has_function_privilege('authenticated','public.start_claimed_execution_batch(uuid,uuid,text,uuid,text,text,text,integer,boolean,text,uuid[])','EXECUTE'),
  'execution may only start through the claimed-batch gate');
select pg_temp.ok(not (select rolinherit or rolcanlogin or rolbypassrls from pg_roles
  where rolname='agent_ledger_writer'),'agent ledger writer is no-login, no-inherit, no-bypass');
select pg_temp.ok(pg_has_role('authenticator','agent_ledger_writer','member')
  and not pg_has_role('service_role','agent_ledger_writer','member')
  and not pg_has_role('agent_ledger_writer','human_action_writer','member')
  and not pg_has_role('human_action_writer','agent_ledger_writer','member'),
  'only PostgREST may assume the isolated agent ledger writer');
select pg_temp.ok(not has_table_privilege('service_role','public.remediation_plans','INSERT')
  and not has_table_privilege('service_role','public.remediation_plans','UPDATE')
  and not has_table_privilege('service_role','public.remediation_plans','DELETE')
  and not has_table_privilege('service_role','public.remediation_actions','INSERT')
  and not has_table_privilege('service_role','public.remediation_actions','UPDATE')
  and not has_table_privilege('service_role','public.remediation_actions','DELETE'),
  'no direct plan or action edit by the shared producer');

-- Every legacy proof RPC that appends a human-labelled event is writer-only.
do $$
declare v_name text; v_signature text;
begin
  foreach v_name in array array[
    'acknowledge_drift_event','advance_breach','advance_dsar',
    'begin_approval_proof_archive','create_standing_policy',
    'delegate_workload_task','draft_breach_notification',
    'onboard_organization','publish_assessment_dispatch_key_policy',
    'reconcile_execution_dispatch','record_approval_export','record_breach',
    'record_dsar','register_connector_tool','register_monitoring_schedule',
    'review_approval_proof_archive','review_breach_notification',
    'revoke_standing_policy','revoke_workload_task','send_breach_notification',
    'settle_approval_proof_archive','verify_dsar_identity'
  ] loop
    select p.oid::regprocedure::text into strict v_signature from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=v_name;
    perform pg_temp.ok(not has_function_privilege('service_role',v_signature,'EXECUTE')
      and not has_function_privilege('anon',v_signature,'EXECUTE')
      and not has_function_privilege('authenticated',v_signature,'EXECUTE')
      and not has_function_privilege('agent_ledger_writer',v_signature,'EXECUTE'),
      'shared or producer role retains '||v_signature);
    perform pg_temp.ok(has_function_privilege('human_action_writer',v_signature,'EXECUTE'),
      'human writer lacks '||v_signature);
    -- 0090's dedicated archive writer must not keep a parallel path to any
    -- moved RPC (begin/review/settle_approval_proof_archive, record_approval_export).
    perform pg_temp.ok(not has_function_privilege('approval_archive_writer',v_signature,'EXECUTE'),
      'archive writer retains moved '||v_signature);
  end loop;
end $$;
-- Release also writes a human-labelled event; 0100 moves it to the human writer.
select pg_temp.ok(
  not has_function_privilege('approval_archive_writer','public.release_approval_proof_archive(uuid,uuid,uuid,text,text,uuid)','EXECUTE')
  and has_function_privilege('human_action_writer','public.release_approval_proof_archive(uuid,uuid,uuid,text,text,uuid)','EXECUTE')
  and not has_function_privilege('service_role','public.release_approval_proof_archive(uuid,uuid,uuid,text,text,uuid)','EXECUTE'),
  'human writer alone can release an archive');

-- ── fixtures ────────────────────────────────────────────────────────────
insert into auth.users(id,email) values
 ('99009900-0000-4000-8000-000000000001','member@example.invalid'),
 ('99009900-0000-4000-8000-000000000002','outsider@example.invalid');
insert into public.users(id,email) values
 ('99009900-0000-4000-8000-000000000001','member@example.invalid'),
 ('99009900-0000-4000-8000-000000000002','outsider@example.invalid');
insert into public.tenants(id,slug,name) values
 ('99009900-0000-4000-8000-000000000010','ledger-src','Ledger source test');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('99009900-0000-4000-8000-000000000010','99009900-0000-4000-8000-000000000001','founder');

create function pg_temp.append(kind text,actor text,id text,act text) returns bigint language plpgsql as $$
begin
  if kind='human' then
    return public.append_human_ledger(
      '99009900-0000-4000-8000-000000000010',gen_random_uuid(),actor::public.actor_type,id,
      null,null,null,act::public.ledger_action_type,null,null,null,null,null,null,null,'success','{}');
  end if;
  return public.append_agent_ledger(
    '99009900-0000-4000-8000-000000000010',gen_random_uuid(),actor::public.actor_type,id,
    null,null,null,act::public.ledger_action_type,null,null,null,null,null,null,null,'success','{}');
end $$;

-- ── raw append and cross-writer forgery are refused ─────────────────────
set local role service_role;
select pg_temp.denied($s$select public.append_ledger(
 '99009900-0000-4000-8000-000000000010',gen_random_uuid(),'human',
 '99009900-0000-4000-8000-000000000001',null,null,null,'report.released',null,null,null,
 null,null,null,null,'success','{}')$s$);
select pg_temp.denied($s$select pg_temp.append('human','human','99009900-0000-4000-8000-000000000001','report.released')$s$);
select pg_temp.denied($s$select pg_temp.append('agent','system','scan','discovery.started')$s$);
reset role;

set local role agent_ledger_writer;
select pg_temp.denied($s$select pg_temp.append('human','human','99009900-0000-4000-8000-000000000001','report.released')$s$);
select pg_temp.ok(pg_temp.append('agent','system','scan-worker','discovery.started')>0,
  'producer writer appends a system event');
select pg_temp.ok(pg_temp.append('agent','agent','sudhaar','plan.generated')>0,
  'producer writer appends an agent event');
reset role;

-- A producer cannot label an event human, or append a human-authority event
-- under any label.
set local role agent_ledger_writer;
do $$ begin
  begin perform pg_temp.append('agent','human','99009900-0000-4000-8000-000000000001','discovery.started');
    raise exception 'ASSERTION FAILED: producer wrote a human-labelled event';
  exception when insufficient_privilege then null; end;
end $$;
do $$ declare a text; begin
  foreach a in array array['plan.rejected','plan.published','report.approved','report.rejected',
    'report.released','evidence_pack.exported','approval.exported','approval.archive.reviewed',
    'approval.archive.released','closure.pramaan.sealed','execution.kill_switch.released',
    'user.role.changed','mfa.factor.activated','mfa.factor.revoked','tenant.invitation.accepted',
    'breach.notification.reviewed','consent.withdrawn','consent.legal_hold.set'] loop
    begin perform pg_temp.append('agent','agent','sudhaar',a);
      raise exception 'ASSERTION FAILED: producer appended human-authority event %',a;
    exception when insufficient_privilege then null; end;
  end loop;
end $$;
reset role;

set local role human_action_writer;
select pg_temp.ok(pg_temp.append('human','human','99009900-0000-4000-8000-000000000001','report.released')>0,
  'human writer records a tenant member decision');
do $$ begin
  begin perform pg_temp.append('human','human','99009900-0000-4000-8000-000000000002','report.released');
    raise exception 'ASSERTION FAILED: human writer labelled a non-member';
  exception when insufficient_privilege then null; end;
  begin perform pg_temp.append('human','agent','99009900-0000-4000-8000-000000000001','report.released');
    raise exception 'ASSERTION FAILED: human writer labelled an agent event';
  exception when insufficient_privilege then null; end;
  begin perform pg_temp.append('human','human','not-a-uuid','report.released');
    raise exception 'ASSERTION FAILED: human writer accepted a non-uuid actor';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

select pg_temp.ok((select count(*)=3 from public.audit_ledger
  where tenant_id='99009900-0000-4000-8000-000000000010'),
  'exactly the three sanctioned events reached the ledger');
select pg_temp.ok((select count(*)=1 from public.audit_ledger
  where tenant_id='99009900-0000-4000-8000-000000000010' and actor_type='human'
    and action_type='report.released'),'exactly one human-labelled event');

-- ── execution gate ──────────────────────────────────────────────────────
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
  values ('test-0099',now(),'test','test',0);
insert into public.engagements(id,tenant_id,library_version,title)
  values ('99009900-0000-4000-8000-000000000020','99009900-0000-4000-8000-000000000010','test-0099','E');
insert into public.remediation_plans(id,tenant_id,engagement_id,library_version,title,status)
  values ('99009900-0000-4000-8000-000000000030','99009900-0000-4000-8000-000000000010',
   '99009900-0000-4000-8000-000000000020','test-0099','Gate plan','approved');
insert into public.remediation_actions(id,tenant_id,plan_id,sequence,action_type,description,
  risk_score,parameters,rollback_definition)
values ('99009900-0000-4000-8000-000000000041','99009900-0000-4000-8000-000000000010',
  '99009900-0000-4000-8000-000000000030',1,'data.mask','A',10,
  '{"system":"crm","fields":["phone"]}'::jsonb,'{}'::jsonb),
 ('99009900-0000-4000-8000-000000000042','99009900-0000-4000-8000-000000000010',
  '99009900-0000-4000-8000-000000000030',2,'data.mask','B',10,
  '{"system":"crm","fields":["email"]}'::jsonb,'{}'::jsonb);
insert into public.approval_tokens(id,tenant_id,plan_id,action_ids,approver_id,mode,signature,
  signed_payload,nonce,expires_at,status)
values ('99009900-0000-4000-8000-000000000051','99009900-0000-4000-8000-000000000010',
  '99009900-0000-4000-8000-000000000030',
  array['99009900-0000-4000-8000-000000000041','99009900-0000-4000-8000-000000000042']::uuid[],
  '99009900-0000-4000-8000-000000000001','batch','sig','{}'::jsonb,'nonce-0099',
  now()+interval '1 hour','consumed');
update public.approval_tokens t set signed_payload=coalesce(t.signed_payload,'{}'::jsonb)
  ||jsonb_build_object('contentDigest',
   public.action_set_content_digest(t.tenant_id,t.plan_id,t.action_ids))
  where id='99009900-0000-4000-8000-000000000051';
update public.remediation_actions set approval_status='approved',
  dry_run_status='dry_run_complete',rollback_validated=true,
  dry_run_expires_at=now()+interval '1 hour',execution_status='executing',
  execution_request_key='req-0099',dispatch_status='pending'
  where plan_id='99009900-0000-4000-8000-000000000030';
-- The outbox row the real claim writes, with the action ids in reverse order
-- to prove the gate compares the set rather than the array layout.
insert into public.execution_dispatch_outbox(tenant_id,plan_id,request_key,correlation_id,
  action_ids,payload)
select tenant_id,'99009900-0000-4000-8000-000000000030','req-0099',gen_random_uuid(),
  array['99009900-0000-4000-8000-000000000042','99009900-0000-4000-8000-000000000041']::uuid[],
  jsonb_build_object('content_digest',signed_payload->>'contentDigest')
  from public.approval_tokens where id='99009900-0000-4000-8000-000000000051';

create function pg_temp.start(key text,digest_override text default null) returns jsonb
language sql as $$
  select public.start_claimed_execution_batch(
   '99009900-0000-4000-8000-000000000010','99009900-0000-4000-8000-000000000030',key,
   gen_random_uuid(),'nonce-0099',
   coalesce(digest_override,(select signed_payload->>'contentDigest'
     from public.approval_tokens where id='99009900-0000-4000-8000-000000000051')),
   'batch',2,true,key,
   array['99009900-0000-4000-8000-000000000041','99009900-0000-4000-8000-000000000042']::uuid[]) $$;

set local role service_role;
select pg_temp.denied($s$select public.start_execution_batch(
 '99009900-0000-4000-8000-000000000010','99009900-0000-4000-8000-000000000030','req-0099',
 gen_random_uuid(),'nonce-0099','x','batch',2,true,'req-0099',
 array['99009900-0000-4000-8000-000000000041']::uuid[])$s$);
select pg_temp.ok(pg_temp.start('req-never-claimed')->>'error'='claim_not_found',
  'no claim for the request key is refused');
select pg_temp.ok(pg_temp.start('req-0099',repeat('0',64))->>'error'='claim_not_found',
  'a digest that is not the claimed one is refused');
reset role;

update public.approval_tokens set status='revoked'
  where id='99009900-0000-4000-8000-000000000051';
set local role service_role;
select pg_temp.ok(pg_temp.start('req-0099')->>'error'='token_not_consumed',
  'a revoked token cannot start execution');
reset role;
update public.approval_tokens set status='consumed'
  where id='99009900-0000-4000-8000-000000000051';

update public.remediation_plans set status='cancelled'
  where id='99009900-0000-4000-8000-000000000030';
set local role service_role;
select pg_temp.ok(pg_temp.start('req-0099')->>'error'='plan_not_executable',
  'a rejected or cancelled plan cannot start execution');
reset role;
select pg_temp.ok((select execution_batch_id is null from public.remediation_actions
  where id='99009900-0000-4000-8000-000000000041'),'refusals started nothing');
update public.remediation_plans set status='approved'
  where id='99009900-0000-4000-8000-000000000030';

set local role service_role;
select pg_temp.ok(pg_temp.start('req-0099')->>'replay'='false',
  'the claimed, consumed and approved batch starts');
select pg_temp.ok(pg_temp.start('req-0099')->>'replay'='true',
  'a redelivery replays instead of starting twice');
reset role;
select pg_temp.ok((select count(*)=1 from public.audit_ledger
  where tenant_id='99009900-0000-4000-8000-000000000010' and action_type='execution.started'),
  'exactly one execution.started event');
rollback;
