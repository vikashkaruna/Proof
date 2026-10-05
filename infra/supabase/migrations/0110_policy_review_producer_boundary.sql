-- A policy review is a recorded human founder decision, never a producer event.
-- Preserve the 0108 wrapper ownership/grants and add only this reserved action.
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
    'public_source.bound','agent.invocation.requested','agent.invocation.settled',
    'classification.reviewed','policy.reviewed',
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
