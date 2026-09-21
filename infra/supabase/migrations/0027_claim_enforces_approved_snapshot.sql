-- W1: the claim enforces the snapshot the approver authorised.
--
-- 0026 made issuance atomic and verified the content digest under the action
-- row locks, so a token can only be persisted carrying a digest that was true
-- when it became authority. Nothing downstream then checked it. The token
-- named which rows to execute and not what they contained.
--
-- `trg_actions_approved_immutable` (0004) freezes an approved action's type,
-- parameters, rollback definition and findings, which covers most of the gap.
-- It does NOT freeze `dry_run_result` — and the simulated outcome is precisely
-- what the approver read before agreeing. So between approval and execution
-- the diff can be replaced, and the only thing that would notice is a check
-- that compares the content against what the token says it approved.
--
-- The claim is the right place for that check: it is where actions become
-- `executing`, it already holds the row locks, and it already spends the
-- token. The digest is read from the token's persisted signed payload rather
-- than from the caller, so the caller cannot name its own expectation.
--
-- A token with no digest is refused. Failing closed costs a re-approval;
-- failing open executes content nobody agreed to.
begin;

create or replace function public.claim_plan_execution(
  p_tenant_id uuid,
  p_plan_id uuid,
  p_token_id uuid,
  p_action_ids uuid[],
  p_request_key text,
  p_correlation_id uuid default null,
  p_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_claimed uuid[];
  v_foreign integer;
  v_action_count integer;
  v_token_digest text;
  v_current_digest text;
begin
  if p_request_key is null or p_request_key = '' then
    return jsonb_build_object('decision', 'missing_request_key');
  end if;

  if coalesce(cardinality(p_action_ids), 0) = 0
     or exists (select 1 from unnest(p_action_ids) id where id is null)
     or cardinality(p_action_ids) <> (select count(distinct id) from unnest(p_action_ids) id) then
    return jsonb_build_object('decision', 'invalid_actions');
  end if;

  -- Lock BEFORE reading mutable state. Different tokens lock different rows;
  -- token consumption alone did not serialize overlapping action claims.
  perform 1 from public.remediation_plans
   where id = p_plan_id and tenant_id = p_tenant_id for update;
  if not found then
    return jsonb_build_object('decision', 'actions_not_found');
  end if;
  perform 1 from public.remediation_actions
   where tenant_id = p_tenant_id and plan_id = p_plan_id and id = any(p_action_ids)
   order by id for update;
  get diagnostics v_action_count = row_count;
  if v_action_count <> cardinality(p_action_ids) then
    return jsonb_build_object('decision', 'actions_not_found');
  end if;

  select count(*) into v_foreign
  from unnest(p_action_ids) as requested(id)
  where not exists (
    select 1 from public.remediation_actions a
    where a.id = requested.id and a.tenant_id = p_tenant_id and a.plan_id = p_plan_id
  );
  if v_foreign > 0 then
    return jsonb_build_object('decision', 'actions_not_found');
  end if;

  -- A recorded intent is never authority to dispatch again. The BFF returns
  -- a conflict for this decision; reconciliation needs a durable consumer.
  if exists (select 1 from public.execution_dispatch_outbox
      where tenant_id = p_tenant_id and plan_id = p_plan_id and request_key = p_request_key) then
    return jsonb_build_object('decision', 'already_claimed');
  end if;

  if exists (
    select 1 from public.remediation_actions a
    where a.tenant_id = p_tenant_id and a.plan_id = p_plan_id and a.id = any(p_action_ids)
      and a.execution_status = 'executing'
  ) then
    return jsonb_build_object('decision', 'already_executing');
  end if;

  -- Recheck eligibility under the action locks: BFF reads can go stale.
  if exists (select 1 from public.remediation_actions a
      where a.id = any(p_action_ids) and (
        a.approval_status <> 'approved' or a.dry_run_status <> 'dry_run_complete'
        or not a.rollback_validated or a.dry_run_expires_at is null
        or a.dry_run_expires_at <= clock_timestamp()
        or a.execution_status in ('succeeded', 'failed', 'rolled_back', 'skipped'))) then
    return jsonb_build_object('decision', 'actions_not_ready');
  end if;

  -- ─── The snapshot the approver authorised ──────────────────────────
  -- Read from the PERSISTED signed payload, not from the caller. The digest
  -- was placed there by `issue_plan_approval`, which had verified it under
  -- these same row locks, so it is what the approver agreed to and it is
  -- covered by the token's HMAC.
  select t.signed_payload->>'contentDigest' into v_token_digest
    from public.approval_tokens t
   where t.id = p_token_id and t.tenant_id = p_tenant_id and t.plan_id = p_plan_id;

  if v_token_digest is null or v_token_digest = '' then
    -- A token that names only rows authorises nothing here. Failing closed
    -- costs a re-approval; failing open executes content nobody agreed to.
    return jsonb_build_object('decision', 'token_without_snapshot');
  end if;

  v_current_digest := public.action_set_content_digest(p_tenant_id, p_plan_id, p_action_ids);
  if v_current_digest is distinct from v_token_digest then
    return jsonb_build_object('decision', 'content_changed');
  end if;

  update public.approval_tokens
     set status = 'consumed', consumed_at = now()
   where id = p_token_id and tenant_id = p_tenant_id and plan_id = p_plan_id
     and status = 'issued' and expires_at > clock_timestamp()
     and action_ids @> p_action_ids;
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

  -- The intent, in the same transaction as the token it spent.
  insert into public.execution_dispatch_outbox(
    tenant_id, plan_id, request_key, correlation_id, action_ids, payload)
  values (
    p_tenant_id, p_plan_id, p_request_key,
    coalesce(p_correlation_id, gen_random_uuid()), p_action_ids,
    coalesce(p_payload, '{}'::jsonb) || jsonb_build_object(
      'tenant_id', p_tenant_id, 'plan_id', p_plan_id, 'action_ids', p_action_ids,
      'request_key', p_request_key, 'content_digest', v_token_digest));

  select array_agg(a.id) into v_claimed
  from public.remediation_actions a
  where a.tenant_id = p_tenant_id and a.plan_id = p_plan_id
    and a.id = any(p_action_ids) and a.execution_request_key = p_request_key;

  return jsonb_build_object('decision', 'claimed', 'action_ids', to_jsonb(v_claimed),
                           'content_digest', v_token_digest);
end $$;

commit;
