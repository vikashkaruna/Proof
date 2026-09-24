-- Reconciliation and its ledger proof are one transaction. Previously the
-- BFF appended after release and could fail with the estate retryable.
begin;

create or replace function public.reconcile_execution_dispatch(
  p_tenant_id uuid,
  p_plan_id uuid,
  p_request_key text,
  p_decision text,
  p_reason text,
  p_actor_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
  v_correlation_id uuid;
  v_action_ids uuid[];
  v_released integer := 0;
begin
  if p_decision is null or p_decision not in ('released', 'abandoned') then
    return jsonb_build_object('decision', 'invalid_decision');
  end if;
  -- A reconciliation with no stated reason is not a record of judgement.
  if p_reason is null or btrim(p_reason) = '' then
    return jsonb_build_object('decision', 'reason_required');
  end if;

  -- Same lock order as claim_plan_execution: plan first, so a reconciliation
  -- and a claim for the same plan cannot interleave.
  perform 1 from public.remediation_plans
   where id = p_plan_id and tenant_id = p_tenant_id for update;
  if not found then
    return jsonb_build_object('decision', 'plan_not_found');
  end if;

  select status, correlation_id, action_ids into v_status, v_correlation_id, v_action_ids from public.execution_dispatch_outbox
   where tenant_id = p_tenant_id and plan_id = p_plan_id and request_key = p_request_key
   for update;
  if v_status is null then
    return jsonb_build_object('decision', 'intent_not_found');
  end if;
  -- 'delivered' is excluded on purpose: the runtime took it, so releasing the
  -- actions would be inviting a second execution of work already in flight.
  -- 'abandoned' is excluded because the judgement has already been recorded.
  if v_status not in ('pending', 'failed', 'unknown') then
    return jsonb_build_object('decision', 'not_reconcilable', 'status', v_status);
  end if;

  if p_decision = 'released' then
    -- An unused token issued before this judgement is old authority too.
    -- Restoring neither the spent token nor other outstanding tokens is what
    -- enforces the founder's fresh-approval requirement.
    update public.approval_tokens set status = 'revoked', revoked_at = now()
     where tenant_id = p_tenant_id and plan_id = p_plan_id and status = 'issued'
       and action_ids && v_action_ids;
    update public.remediation_actions
       set execution_status = 'approved'::public.action_status,
           execution_request_key = null,
           dispatch_status = null,
           dispatch_error = null
     where tenant_id = p_tenant_id and plan_id = p_plan_id
       and execution_request_key = p_request_key
       and execution_status = 'executing';
    get diagnostics v_released = row_count;
    -- The approval token stays consumed. Restoring it here would turn this
    -- into the automatic redelivery the founder ruled out.
  end if;

  update public.execution_dispatch_outbox
     set status = 'abandoned',
         abandoned_at = now(),
         abandoned_reason = p_reason,
         reconciled_at = now(),
         reconciled_by = p_actor_id,
         reconciled_decision = p_decision
   where tenant_id = p_tenant_id and plan_id = p_plan_id and request_key = p_request_key;

  -- A ledger outage must roll back the release and token revocations too.
  perform public.append_ledger(p_tenant_id, v_correlation_id, 'human', p_actor_id::text,
    null, null, null, 'execution.dispatch.reconciled', p_plan_id::text,
    null, null, null, null, null, null, 'success',
    jsonb_build_object('requestKey', p_request_key, 'decision', p_decision, 'reason', p_reason,
      'releasedActionCount', v_released, 'redeliveryRequiresFreshApproval', true));

  return jsonb_build_object(
    'correlation_id', v_correlation_id,
    'decision', p_decision,
    'released_action_count', v_released,
    'previous_status', v_status);
end $$;

revoke all on function
  public.reconcile_execution_dispatch(uuid, uuid, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function
  public.reconcile_execution_dispatch(uuid, uuid, text, text, text, uuid)
  to service_role;

commit;
