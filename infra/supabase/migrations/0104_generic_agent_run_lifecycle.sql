-- Generic invocation telemetry is not a delegated assessment, execution or
-- evidence artifact. Keep 0064's table write revocations and dedicated RPCs.
alter type public.ledger_action_type add value if not exists 'agent.invocation.requested';
alter type public.ledger_action_type add value if not exists 'agent.invocation.settled';

revoke insert,update,delete on public.agent_runs from anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
create unique index generic_agent_run_dispatch_unique
 on public.agent_runs(tenant_id,agent,correlation_id)
 where metadata->>'lifecycle_writer'='generic_agent_rpc_v1';

create function public.record_generic_agent_run_start(
 p_tenant_id uuid,p_actor_id uuid,p_agent text,p_engagement_id uuid,
 p_correlation_id uuid,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_role public.user_role; v_internal boolean; v_run public.agent_runs; v_receipt bigint;
begin
 if p_tenant_id is null or p_actor_id is null or p_correlation_id is null
  or p_agent is null or p_agent not in ('drishti','vibhaag','parikshan','saakshi','sudhaar','lekha','nazar','sanket')
  or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
 then return jsonb_build_object('error','invalid_record'); end if;
 -- Lock authority before context and run, matching existing task issuance.
 select role into v_role from public.tenant_users
  where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 if v_role is null or v_role not in ('owner','admin','founder','axiom_analyst')
  or (p_agent in ('lekha','nazar','sanket') and v_role not in ('founder','axiom_analyst'))
 then return jsonb_build_object('error','forbidden'); end if;
 select is_axiom_internal into v_internal from public.users where id=p_actor_id for share;
 if not found or (v_role in ('founder','axiom_analyst') and v_internal is distinct from true)
 then return jsonb_build_object('error','forbidden'); end if;
 if p_engagement_id is not null then
  perform 1 from public.engagements where tenant_id=p_tenant_id and id=p_engagement_id
   and status<>'cancelled' for share;
  if not found then return jsonb_build_object('error','context_refused'); end if;
 end if;
 insert into public.agent_runs(tenant_id,agent,engagement_id,correlation_id,status,
  input_redacted_hash,metadata)
 values(p_tenant_id,p_agent,p_engagement_id,p_correlation_id,'running',p_request_hash,
  jsonb_build_object('lifecycle_writer','generic_agent_rpc_v1','requested_by',p_actor_id,
   'request_input_hash',p_request_hash))
 on conflict(tenant_id,agent,correlation_id)
  where metadata->>'lifecycle_writer'='generic_agent_rpc_v1' do nothing returning * into v_run;
 if not found then
  select * into v_run from public.agent_runs where tenant_id=p_tenant_id and agent=p_agent
   and correlation_id=p_correlation_id and metadata->>'lifecycle_writer'='generic_agent_rpc_v1' for update;
  if v_run.metadata->>'requested_by' is distinct from p_actor_id::text
   or v_run.input_redacted_hash is distinct from p_request_hash
   or v_run.engagement_id is distinct from p_engagement_id
  then return jsonb_build_object('error','dispatch_conflict'); end if;
  -- Even a matching replay cannot invoke the external runtime a second time.
  return jsonb_build_object('run_id',v_run.id,'created',false,'status',v_run.status);
 end if;
 v_receipt:=public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,
  null,null,null,'agent.invocation.requested',v_run.id::text,p_request_hash,null,
  null,null,null,null,'pending',jsonb_build_object('agent',p_agent,'engagement_id',p_engagement_id));
 update public.agent_runs set metadata=metadata||jsonb_build_object('request_receipt',v_receipt::text)
  where id=v_run.id;
 return jsonb_build_object('run_id',v_run.id,'created',true,'status','running');
end $$;
revoke all on function public.record_generic_agent_run_start(uuid,uuid,text,uuid,uuid,text)
 from public,anon,authenticated,service_role,agent_ledger_writer;
grant execute on function public.record_generic_agent_run_start(uuid,uuid,text,uuid,uuid,text) to human_action_writer;

create function public.record_generic_agent_run_finish(
 p_tenant_id uuid,p_actor_id uuid,p_run_id uuid,p_agent text,p_engagement_id uuid,
 p_correlation_id uuid,p_request_hash text,p_status text,p_error_code text,
 p_latency_ms integer,p_input_tokens integer,p_output_tokens integer,p_cost_usd numeric,
 p_started_receipt text,p_completed_receipt text,p_response_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_run public.agent_runs; v_start public.audit_ledger; v_end public.audit_ledger;
 v_request public.audit_ledger; v_action text; v_settlement jsonb; v_receipt bigint;
 v_outcome text; v_runtime_input text; v_runtime_output text;
begin
 if p_tenant_id is null or p_actor_id is null or p_run_id is null
  or p_correlation_id is null or p_agent is null or p_request_hash is null
  or p_request_hash !~ '^[a-f0-9]{64}$' or p_status is null or p_status not in ('succeeded','failed')
  or (p_latency_ms is not null and p_latency_ms<0)
  or (p_input_tokens is not null and p_input_tokens<0)
  or (p_output_tokens is not null and p_output_tokens<0)
  or coalesce(p_input_tokens,0)::bigint+coalesce(p_output_tokens,0)::bigint>2147483647
  or (p_cost_usd is not null and (p_cost_usd<0 or p_cost_usd>9999.999999 or p_cost_usd::text in ('NaN','Infinity','-Infinity')))
  or (p_response_hash is not null and p_response_hash !~ '^[a-f0-9]{64}$')
  or (p_status='succeeded' and (p_error_code is not null or p_response_hash is null
   or p_latency_ms is null or p_input_tokens is null or p_output_tokens is null or p_cost_usd is null))
  or (p_status='failed' and (p_error_code is null or p_error_code not in ('agent_invocation_failed','agent_reported_failure') or p_response_hash is not null))
 then return jsonb_build_object('error','invalid_record'); end if;
 -- Confirmation records the originally authorized attempt; revoked membership
 -- cannot erase its observed outcome. It never authorizes another dispatch.
 select * into v_run from public.agent_runs where tenant_id=p_tenant_id and id=p_run_id for update;
 if not found or v_run.agent is distinct from p_agent
  or v_run.engagement_id is distinct from p_engagement_id
  or v_run.correlation_id is distinct from p_correlation_id
  or v_run.metadata->>'lifecycle_writer' is distinct from 'generic_agent_rpc_v1'
  or v_run.metadata->>'requested_by' is distinct from p_actor_id::text
  or v_run.input_redacted_hash is distinct from p_request_hash
 then return jsonb_build_object('error','run_context_conflict'); end if;
 select * into v_request from public.audit_ledger where tenant_id=p_tenant_id
  and id::text=v_run.metadata->>'request_receipt';
 if v_request.id is null or v_request.actor_type<>'human' or v_request.actor_id<>p_actor_id::text
  or v_request.action_type<>'agent.invocation.requested' or v_request.target_ref is distinct from p_run_id::text
  or v_request.correlation_id<>p_correlation_id or v_request.input_hash is distinct from p_request_hash
  or v_request.result<>'pending' or v_request.detail->>'agent' is distinct from p_agent
  or v_request.detail->>'engagement_id' is distinct from p_engagement_id::text
 then return jsonb_build_object('error','request_unconfirmed'); end if;
 v_settlement:=jsonb_build_object('status',p_status,'error',p_error_code,'latency_ms',p_latency_ms,
  'input_tokens',p_input_tokens,'output_tokens',p_output_tokens,'cost_usd',p_cost_usd,
  'started_receipt',p_started_receipt,'completed_receipt',p_completed_receipt,'response_hash',p_response_hash);
 if v_run.status<>'running' or v_run.completed_at is not null then
  if v_run.metadata->'settlement' is not distinct from v_settlement then
   return jsonb_build_object('run_id',v_run.id,'status',v_run.status,'replayed',true);
  end if;
  return jsonb_build_object('error','terminal_conflict');
 end if;
 v_outcome:='unconfirmed';
 if p_status='succeeded' then
  -- IDs are actual persisted bigint receipts, never in-memory IDs or artifacts.
  if p_started_receipt is null or p_completed_receipt is null
   or p_started_receipt !~ '^[1-9][0-9]{0,18}$' or p_completed_receipt !~ '^[1-9][0-9]{0,18}$'
   or p_started_receipt::numeric>9223372036854775807 or p_completed_receipt::numeric>9223372036854775807
  then return jsonb_build_object('error','receipts_unconfirmed'); end if;
  select * into v_start from public.audit_ledger where tenant_id=p_tenant_id and id=p_started_receipt::bigint;
  select * into v_end from public.audit_ledger where tenant_id=p_tenant_id and id=p_completed_receipt::bigint;
  v_action:=case p_agent when 'drishti' then 'discovery.started' when 'vibhaag' then 'classification.started'
   when 'parikshan' then 'assessment.started' when 'saakshi' then 'evidence.collected'
   when 'sudhaar' then 'plan.generated' when 'lekha' then 'execution.started' else 'report.generated' end;
  if v_start.id is null or v_end.id is null or v_start.sequence_no>=v_end.sequence_no
   or v_start.sequence_no<=v_request.sequence_no
   or v_start.actor_type<>'agent' or v_end.actor_type<>'agent'
   or v_start.actor_id<>p_agent or v_end.actor_id<>p_agent
   or v_start.action_type::text<>v_action or v_end.action_type::text<>v_action
   or v_start.result<>'pending' or v_end.result<>'success'
   or v_start.correlation_id<>p_correlation_id or v_end.correlation_id<>p_correlation_id
   or v_start.target_ref is distinct from p_engagement_id::text or v_end.target_ref is distinct from p_engagement_id::text
   or v_start.agent_version is null or v_start.agent_version is distinct from v_end.agent_version
   or v_start.input_hash is null or v_start.input_hash !~ '^[a-f0-9]{64}$'
   or v_start.input_hash is distinct from v_end.input_hash
   or v_end.output_hash is null or v_end.output_hash !~ '^[a-f0-9]{64}$'
   or v_start.detail->>'phase' is distinct from 'started' or v_end.detail->>'phase' is distinct from 'completed'
   or v_start.detail->>'run_id' is distinct from p_run_id::text or v_end.detail->>'run_id' is distinct from p_run_id::text
   or v_start.detail->>'request_hash' is distinct from p_request_hash or v_end.detail->>'request_hash' is distinct from p_request_hash
   or v_end.detail->>'started_entry' is distinct from p_started_receipt
  then return jsonb_build_object('error','receipts_unconfirmed'); end if;
  v_outcome:='receipt_confirmed'; v_runtime_input:=v_start.input_hash; v_runtime_output:=v_end.output_hash;
 elsif p_error_code='agent_reported_failure' then
  v_outcome:='runtime_reported_failure';
 end if;
 v_receipt:=public.append_ledger(p_tenant_id,p_correlation_id,'system','bff-generic-agent-controller',
  null,null,null,'agent.invocation.settled',p_run_id::text,p_request_hash,v_runtime_output,
  null,null,null,null,case when p_status='succeeded' then 'success'::public.ledger_result else 'failure'::public.ledger_result end,
  jsonb_build_object('requested_by',p_actor_id,'agent',p_agent,'runtime_outcome',v_outcome,
   'started_receipt',p_started_receipt,'completed_receipt',p_completed_receipt));
 update public.agent_runs set status=p_status,completed_at=clock_timestamp(),latency_ms=p_latency_ms,
  input_tokens=p_input_tokens,output_tokens=p_output_tokens,
  total_tokens=case when p_input_tokens is null or p_output_tokens is null then null else p_input_tokens+p_output_tokens end,
  cost_usd=p_cost_usd,error=p_error_code,output_redacted_hash=v_runtime_output,
  metadata=metadata||jsonb_build_object('settlement',v_settlement,'settlement_receipt',v_receipt::text,
   'runtime_outcome',v_outcome,'runtime_normalized_input_hash',v_runtime_input,
   'runtime_output_hash',v_runtime_output,'response_output_hash',p_response_hash)
 where id=p_run_id;
 return jsonb_build_object('run_id',p_run_id,'status',p_status,'replayed',false);
end $$;
revoke all on function public.record_generic_agent_run_finish(uuid,uuid,uuid,text,uuid,uuid,text,text,text,integer,integer,integer,numeric,text,text,text)
 from public,anon,authenticated,service_role,agent_ledger_writer;
grant execute on function public.record_generic_agent_run_finish(uuid,uuid,uuid,text,uuid,uuid,text,text,text,integer,integer,integer,numeric,text,text,text) to human_action_writer;

-- Producers cannot forge human requests or controller confirmations.
create or replace function public.append_agent_ledger(
  p_tenant_id uuid,p_correlation_id uuid,p_actor_type public.actor_type,
  p_actor_id text,p_agent_version text,p_model_id text,p_prompt_hash text,
  p_action_type public.ledger_action_type,p_target_ref text,p_input_hash text,
  p_output_hash text,p_approval_token_id uuid,p_approver_id uuid,
  p_pre_state_ref text,p_post_state_ref text,p_result public.ledger_result,
  p_detail jsonb
) returns bigint language plpgsql security definer set search_path='' as $$
begin
  if p_actor_type not in ('agent','system') or p_actor_id is null
    or btrim(p_actor_id)='' then
    raise exception 'producer ledger actor refused' using errcode='42501';
  end if;
  -- Only a recorded human may decide, release or seal. A leaked producer key
  -- must not be able to append these under an agent or system label either.
  if p_action_type::text = any(array[
    'agent.invocation.requested','agent.invocation.settled',
    'plan.rejected','plan.published','report.approved','report.rejected',
    'report.released','evidence_pack.exported','approval.exported',
    'approval.archive.reviewed','approval.archive.released',
    'closure.pramaan.sealed','execution.kill_switch.released',
    'user.role.changed','mfa.factor.activated','mfa.factor.revoked',
    'tenant.invitation.accepted','breach.notification.reviewed',
    'consent.withdrawn','consent.legal_hold.set'
  ]) then
    raise exception 'human-authority ledger event refused for producer'
      using errcode='42501';
  end if;
  return public.append_ledger(p_tenant_id,p_correlation_id,p_actor_type,p_actor_id,
    p_agent_version,p_model_id,p_prompt_hash,p_action_type,p_target_ref,
    p_input_hash,p_output_hash,p_approval_token_id,p_approver_id,
    p_pre_state_ref,p_post_state_ref,p_result,p_detail);
end $$;

-- The dedicated Karya writer must not be an escape into generic telemetry.
create or replace function public.record_karya_run_finish(
  p_tenant_id uuid,
  p_run_id uuid,
  p_status text,
  p_error_code text,
  p_latency_ms integer,
  p_output_redacted_hash text
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare r public.agent_runs;
begin
  if p_status not in ('succeeded', 'failed', 'cancelled')
     or (p_error_code is not null and p_error_code !~ '^[a-z0-9_]{1,80}$')
     or (p_latency_ms is not null and p_latency_ms < 0)
     or (p_output_redacted_hash is not null and p_output_redacted_hash !~ '^[0-9a-f]{64}$') then
    return jsonb_build_object('error', 'invalid_record');
  end if;
  update public.agent_runs set
      status = p_status,
      completed_at = now(),
      latency_ms = p_latency_ms,
      error = p_error_code,
      output_redacted_hash = coalesce(p_output_redacted_hash, output_redacted_hash)
    where tenant_id = p_tenant_id and id = p_run_id and status = 'running' and agent = 'karya'
      and metadata->>'lifecycle_writer' is distinct from 'generic_agent_rpc_v1'
    returning * into r;
  if not found then
    return jsonb_build_object('error', 'run_not_running');
  end if;
  return jsonb_build_object('ok', true);
end $$;
