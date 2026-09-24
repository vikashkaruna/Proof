-- W5 / R-04: a batch of two actions could never be executed.
--
-- `remediation_actions.idempotency_key` carried a GLOBAL unique constraint,
-- and the execute route writes the request's Idempotency-Key onto every
-- accepted action. So the second action in any batch violated it:
--
--   ERROR: duplicate key value violates unique constraint
--          "remediation_actions_idempotency_key_key"
--
-- The route consumed the approval token before that update, so the failure
-- spent a single-use token and scheduled nothing. The plan was left approved,
-- un-executable and requiring a fresh approval — the worst available outcome
-- for the one flow the product exists to make trustworthy.
--
-- The value was the wrong shape, not the constraint. Request identity belongs
-- to the request: migration 0017 already gives every mutation a durable claim
-- in `idempotency_keys`, scoped by user, tenant, path and method. What an
-- action needs is (a) a record of WHICH request claimed it, which many actions
-- in one batch legitimately share, and (b) its own execution identity, which
-- must not.
--
-- Applied forward only; do not edit the original migration history.
begin;

-- The unique constraint on `idempotency_key` is deliberately RETAINED.
--
-- The first draft of this migration dropped it. That was wrong: the constraint
-- was never the defect, the value written under it was. Once each action
-- carries its own scoped key (`<request-key>:<action-id>`, written by
-- `claim_plan_execution` below) the constraint is satisfied by construction —
-- and it becomes the guard that catches a regression. Anyone who writes a bare
-- request key across a batch again gets the duplicate-key error at the
-- database, instead of shipping a plan that cannot be executed.

alter table public.remediation_actions
  -- Request/batch identity. Deliberately not unique: a batch is precisely the
  -- case of several actions sharing one request.
  add column if not exists execution_request_key text,
  add column if not exists execution_claimed_at timestamptz,
  -- Dispatch outcome, kept separate from `execution_status`. An action that
  -- was claimed but never reached the runtime is not "executing", and
  -- reporting it as such is how a failed dispatch reads as success (R-05).
  add column if not exists dispatch_status text,
  add column if not exists dispatch_error text,
  -- The runtime's own identifier for the work, once it returns one. The
  -- durable outbox and reconciliation remain W5; this is the handle they
  -- will need.
  add column if not exists dispatch_reference text,
  add constraint remediation_actions_dispatch_status_check
    check (dispatch_status is null or dispatch_status in ('pending', 'accepted', 'failed'));

comment on column public.remediation_actions.execution_request_key is
  'The Idempotency-Key of the request that claimed this action. Shared across a batch; see idempotency_keys (0017) for request identity.';
comment on column public.remediation_actions.dispatch_status is
  'Whether the agent runtime accepted this action for execution. Separate from execution_status so a failed dispatch cannot read as running work.';

create index if not exists idx_remediation_actions_execution_request_key
  on public.remediation_actions (execution_request_key)
  where execution_request_key is not null;

-- ─── Atomic claim ────────────────────────────────────────────────────
-- Token consumption and the execution claim were two statements with a gap
-- between them. Any failure in that gap spent the token without claiming the
-- work, and a crash left the pair inconsistent with no way to tell which half
-- had happened. One transaction, one decision.
--
-- Replay is checked BEFORE the token, deliberately: a retry under the same
-- Idempotency-Key must succeed against an already-consumed token, because
-- consuming it is exactly what the first attempt did.
create function public.claim_plan_execution(
  p_tenant_id uuid,
  p_plan_id uuid,
  p_token_id uuid,
  p_action_ids uuid[],
  p_request_key text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_claimed uuid[];
  v_existing uuid[];
  v_foreign integer;
begin
  if p_request_key is null or p_request_key = '' then
    return jsonb_build_object('decision', 'missing_request_key');
  end if;

  -- Every named action must belong to this tenant and plan. Checked here as
  -- well as in the BFF because this function runs as the definer and a caller
  -- that could name another tenant's actions would be claiming them.
  select count(*) into v_foreign
  from unnest(p_action_ids) as requested(id)
  where not exists (
    select 1 from public.remediation_actions a
    where a.id = requested.id and a.tenant_id = p_tenant_id and a.plan_id = p_plan_id
  );
  if v_foreign > 0 then
    return jsonb_build_object('decision', 'actions_not_found');
  end if;

  -- Replay: this request already claimed these actions.
  select array_agg(a.id) into v_existing
  from public.remediation_actions a
  where a.tenant_id = p_tenant_id and a.plan_id = p_plan_id
    and a.id = any(p_action_ids) and a.execution_request_key = p_request_key;

  if v_existing is not null and array_length(v_existing, 1) = array_length(p_action_ids, 1) then
    return jsonb_build_object('decision', 'already_claimed', 'action_ids', to_jsonb(v_existing));
  end if;

  -- A different request is mid-flight on one of these actions.
  if exists (
    select 1 from public.remediation_actions a
    where a.tenant_id = p_tenant_id and a.plan_id = p_plan_id and a.id = any(p_action_ids)
      and a.execution_request_key is not null and a.execution_request_key <> p_request_key
      and a.execution_status = 'executing'
  ) then
    return jsonb_build_object('decision', 'already_executing');
  end if;

  -- Single-use token, consumed in the same transaction as the claim.
  update public.approval_tokens
     set status = 'consumed', consumed_at = now()
   where id = p_token_id and tenant_id = p_tenant_id and status = 'issued';
  if not found then
    return jsonb_build_object('decision', 'token_already_used');
  end if;

  update public.remediation_actions a
     set execution_status = 'executing',
         execution_request_key = p_request_key,
         execution_claimed_at = now(),
         dispatch_status = 'pending',
         dispatch_error = null,
         idempotency_key = p_request_key || ':' || a.id::text
   where a.tenant_id = p_tenant_id and a.plan_id = p_plan_id and a.id = any(p_action_ids);

  select array_agg(a.id) into v_claimed
  from public.remediation_actions a
  where a.tenant_id = p_tenant_id and a.plan_id = p_plan_id
    and a.id = any(p_action_ids) and a.execution_request_key = p_request_key;

  return jsonb_build_object('decision', 'claimed', 'action_ids', to_jsonb(v_claimed));
end $$;

-- Records what the agent runtime said. Called after dispatch, so a refusal or
-- an unreachable runtime is durable rather than a log line.
create function public.record_execution_dispatch(
  p_tenant_id uuid,
  p_plan_id uuid,
  p_request_key text,
  p_status text,
  p_reference text,
  p_error text
) returns integer language plpgsql security definer set search_path = '' as $$
declare v_rows integer;
begin
  if p_status not in ('accepted', 'failed') then
    raise exception 'dispatch status must be accepted or failed, got %', p_status;
  end if;
  update public.remediation_actions
     set dispatch_status = p_status,
         dispatch_reference = p_reference,
         dispatch_error = p_error,
         -- A dispatch the runtime never accepted is not in flight. Returning
         -- it to 'approved' keeps it retryable instead of stranding it in
         -- 'executing' forever with nothing running.
         execution_status = case when p_status = 'failed' then 'approved'::public.action_status
                                 else execution_status end,
         execution_request_key = case when p_status = 'failed' then null
                                      else execution_request_key end
   where tenant_id = p_tenant_id and plan_id = p_plan_id and execution_request_key = p_request_key;
  get diagnostics v_rows = row_count;
  return v_rows;
end $$;

revoke all on function
  public.claim_plan_execution(uuid, uuid, uuid, uuid[], text),
  public.record_execution_dispatch(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function
  public.claim_plan_execution(uuid, uuid, uuid, uuid[], text),
  public.record_execution_dispatch(uuid, uuid, text, text, text, text)
  to service_role;

commit;
