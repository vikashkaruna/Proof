-- W5: what a human is allowed to do about a dispatch that never confirmed.
--
-- 0021 established that only an EXPLICIT refusal releases a claim. An
-- unreachable runtime or a lost acknowledgement leaves the row `unknown` and
-- the actions `executing`, because from here those are indistinguishable from
-- work that is running on a client's estate right now. That is the correct
-- default and it is also a dead end: nothing in the system can ever clear it,
-- so the intent sits in `pending_execution_dispatches` forever.
--
-- The founder's decision is that redelivery always requires a FRESH approval.
-- The worker never re-dispatches on its own. So reconciliation is not a retry
-- mechanism, it is a way to record a human's judgement and, where that
-- judgement is "this did not run", to return the actions to a state where
-- somebody can approve them again.
--
-- Two decisions, and the difference between them matters:
--
--   released   an operator asserts the work did NOT run. The actions go back
--              to 'approved' and can be approved again. The consumed approval
--              token is deliberately NOT restored — that is what makes a
--              redelivery need a fresh approval rather than reusing the one
--              already spent.
--
--   abandoned  the operator cannot establish whether it ran, or knows it did.
--              The intent is closed and the actions are LEFT ALONE. This is
--              the honest outcome for a batch nobody can account for: it
--              stops the row nagging an operator without pretending the
--              actions are safe to run again.
--
-- A delivered intent is not reconcilable by either. The runtime accepted it;
-- releasing it would invite a second execution of work already in flight.
begin;

-- The judgement belongs in the tamper-evident chain, not only in the row: an
-- operator who can edit application logs cannot edit this.
alter type ledger_action_type add value if not exists 'execution.dispatch.reconciled';

alter table public.execution_dispatch_outbox
  add column reconciled_at timestamptz,
  add column reconciled_by uuid references public.users(id),
  add column reconciled_decision text
    check (reconciled_decision is null or reconciled_decision in ('released', 'abandoned'));

comment on column public.execution_dispatch_outbox.reconciled_decision is
  'released = an operator asserted the work did not run; abandoned = closed without that assertion (W5).';

create function public.reconcile_execution_dispatch(
  p_tenant_id uuid,
  p_plan_id uuid,
  p_request_key text,
  p_decision text,
  p_reason text,
  p_actor_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
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

  select status into v_status from public.execution_dispatch_outbox
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

  return jsonb_build_object(
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
