-- A generic producer credential is not a human session or a ledger author.
-- Keep append_ledger itself unchanged and append-only; constrain its public
-- entry points by the service that actually observed the event.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='agent_ledger_writer') then
    create role agent_ledger_writer nologin noinherit nobypassrls;
  end if;
end $$;
alter role agent_ledger_writer nologin noinherit nobypassrls;
grant agent_ledger_writer to authenticator;
grant usage on schema public to agent_ledger_writer;

create function public.append_human_ledger(
  p_tenant_id uuid,p_correlation_id uuid,p_actor_type public.actor_type,
  p_actor_id text,p_agent_version text,p_model_id text,p_prompt_hash text,
  p_action_type public.ledger_action_type,p_target_ref text,p_input_hash text,
  p_output_hash text,p_approval_token_id uuid,p_approver_id uuid,
  p_pre_state_ref text,p_post_state_ref text,p_result public.ledger_result,
  p_detail jsonb
) returns bigint language plpgsql security definer set search_path='' as $$
declare v_actor uuid;
begin
  if p_actor_type <> 'human' or p_actor_id is null
    or p_actor_id !~ '^[0-9a-fA-F-]{36}$' then
    raise exception 'human ledger actor refused' using errcode='42501';
  end if;
  v_actor:=p_actor_id::uuid;
  if not exists(select 1 from public.tenant_users
    where tenant_id=p_tenant_id and user_id=v_actor) then
    raise exception 'human ledger membership refused' using errcode='42501';
  end if;
  return public.append_ledger(p_tenant_id,p_correlation_id,p_actor_type,p_actor_id,
    p_agent_version,p_model_id,p_prompt_hash,p_action_type,p_target_ref,
    p_input_hash,p_output_hash,p_approval_token_id,p_approver_id,
    p_pre_state_ref,p_post_state_ref,p_result,p_detail);
end $$;
revoke all on function public.append_human_ledger(uuid,uuid,public.actor_type,text,
  text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,
  public.ledger_result,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.append_human_ledger(uuid,uuid,public.actor_type,text,
  text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,
  public.ledger_result,jsonb) to human_action_writer;

create function public.append_agent_ledger(
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
revoke all on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,
  text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,
  public.ledger_result,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,
  text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,
  public.ledger_result,jsonb) to agent_ledger_writer;

revoke execute on function public.append_ledger(uuid,uuid,public.actor_type,text,
  text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,
  public.ledger_result,jsonb) from public,anon,authenticated,service_role;

-- These legacy proof RPCs append a human-labelled event. The caller must be
-- the BFF's human writer, rather than any service sharing the producer key.
do $$
declare v_name text; v_signature regprocedure; v_count integer;
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
    select count(*),min(p.oid::regprocedure::text)::regprocedure
      into v_count,v_signature from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=v_name;
    if v_count<>1 then raise exception '0099 expected one public.% function, found %',v_name,v_count; end if;
    execute format('revoke all on function %s from public,anon,authenticated,service_role',v_signature);
    execute format('grant execute on function %s to human_action_writer',v_signature);
  end loop;
end $$;

-- No direct PostgREST table edit may invent or reverse a reviewed plan/action.
revoke insert,update,delete on public.remediation_plans from service_role;
revoke insert,update,delete on public.remediation_actions from service_role;

-- The legacy batch RPC only checked the token nonce and content, so a
-- cancelled plan's revoked token could still be used by a direct producer
-- caller. Require the preceding atomic claim under the same plan lock.
create function public.start_claimed_execution_batch(
  p_tenant_id uuid,p_plan_id uuid,p_request_key text,p_correlation_id uuid,
  p_nonce text,p_content_digest text,p_mode text,p_concurrency integer,
  p_stop_on_failure boolean,p_dispatch_reference text,p_action_ids uuid[]
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_plan_status text; v_token public.approval_tokens;
  v_claim public.execution_dispatch_outbox;
begin
  select status::text into v_plan_status from public.remediation_plans
    where tenant_id=p_tenant_id and id=p_plan_id for update;
  if v_plan_status is null then return jsonb_build_object('error','plan_not_found'); end if;
  if v_plan_status not in ('approved','executing') then
    return jsonb_build_object('error','plan_not_executable');
  end if;
  select * into v_claim from public.execution_dispatch_outbox
    where tenant_id=p_tenant_id and plan_id=p_plan_id and request_key=p_request_key
    for share;
  if not found or v_claim.status not in ('pending','delivered')
    or (select array_agg(x order by x) from unnest(v_claim.action_ids) x)
       is distinct from (select array_agg(x order by x) from unnest(p_action_ids) x)
    or v_claim.payload->>'content_digest' is distinct from p_content_digest then
    return jsonb_build_object('error','claim_not_found');
  end if;
  select * into v_token from public.approval_tokens
    where tenant_id=p_tenant_id and plan_id=p_plan_id and nonce=p_nonce
    for share;
  if not found or v_token.status<>'consumed'
    or not (v_token.action_ids @> p_action_ids)
    or v_token.signed_payload->>'contentDigest' is distinct from p_content_digest then
    return jsonb_build_object('error','token_not_consumed');
  end if;
  return public.start_execution_batch(p_tenant_id,p_plan_id,p_request_key,
    p_correlation_id,p_nonce,p_content_digest,p_mode,p_concurrency,
    p_stop_on_failure,p_dispatch_reference,p_action_ids);
end $$;
revoke all on function public.start_claimed_execution_batch(uuid,uuid,text,uuid,
  text,text,text,integer,boolean,text,uuid[]) from public,anon,authenticated;
grant execute on function public.start_claimed_execution_batch(uuid,uuid,text,uuid,
  text,text,text,integer,boolean,text,uuid[]) to service_role;
revoke execute on function public.start_execution_batch(uuid,uuid,text,uuid,
  text,text,text,integer,boolean,text,uuid[]) from service_role;
