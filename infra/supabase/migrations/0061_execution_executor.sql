-- ─────────────────────────────────────────────────────────────────────
-- 0061_execution_executor.sql
--
-- W5 · M3.4 — the executor's write paths (Revision 90).
--
-- The runtime consumes the dispatch outbox through /internal/execute and
-- records what it did through exactly these functions and nothing else:
--
--   start_execution_batch   one batch per dispatch intent; enforces the two
--                           structural guarantees the whole product stands
--                           on: the executed actions are a subset of the
--                           approved token's action_ids, and the content
--                           digest is recomputed over the stored rows and
--                           matched against the token's signed snapshot.
--   mark_execution_action_started
--   settle_execution_action per-action outcome, ledgered
--   finish_execution_batch  terminal status, plan status, and the sweep
--                           that returns unsettled actions to `approved`
--                           — retryable only under a FRESH approval, per
--                           the founder's redelivery decision (0023).
--
-- Idempotency: a redelivery under the same request key replays the
-- recorded batch instead of executing again. A different payload under
-- the same key is a conflict, not a retry.
-- ─────────────────────────────────────────────────────────────────────

create function public.start_execution_batch(
  p_tenant_id uuid,
  p_plan_id uuid,
  p_request_key text,
  p_correlation_id uuid,
  p_nonce text,
  p_content_digest text,
  p_mode text,
  p_concurrency integer,
  p_stop_on_failure boolean,
  p_dispatch_reference text,
  p_action_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  t public.approval_tokens;
  b public.execution_batches;
  v_digest text;
begin
  if p_request_key is null or length(p_request_key) = 0 or length(p_request_key) > 200
     or p_concurrency is null or p_concurrency < 1 or p_concurrency > 100
     or p_mode not in ('batch', 'individual') or p_action_ids is null or array_length(p_action_ids, 1) = 0
     or p_nonce is null or length(p_nonce) = 0 or length(p_nonce) > 200 then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  -- Idempotent redelivery: the same key replays the recorded batch.
  select * into b from public.execution_batches
    where tenant_id = p_tenant_id and request_key = p_request_key;
  if found then
    if b.content_digest = p_content_digest then
      return jsonb_build_object('batch', jsonb_build_object('id', b.id, 'status', b.status), 'replay', true);
    end if;
    return jsonb_build_object('error', 'request_key_conflict');
  end if;

  -- The executed scope is structurally bounded by the approved token,
  -- resolved by the nonce inside its signed spec (unique per 0005).
  select * into t from public.approval_tokens
    where tenant_id = p_tenant_id and plan_id = p_plan_id and nonce = p_nonce;
  if not found then
    return jsonb_build_object('error', 'token_not_found');
  end if;
  if not (t.action_ids @> p_action_ids) then
    return jsonb_build_object('error', 'scope_exceeded');
  end if;
  if coalesce(t.signed_payload ->> 'contentDigest', '') <> p_content_digest then
    return jsonb_build_object('error', 'digest_mismatch');
  end if;

  -- Recompute the digest over the stored rows now: what executes must be
  -- what the approver read, not what the claim once computed.
  v_digest := public.action_set_content_digest(p_tenant_id, p_plan_id, p_action_ids);
  if v_digest is distinct from p_content_digest then
    return jsonb_build_object('error', 'digest_mismatch');
  end if;

  insert into public.execution_batches(tenant_id, plan_id, request_key, correlation_id,
    approval_token_id, content_digest, mode, concurrency, stop_on_failure, dispatch_reference, status)
  values (p_tenant_id, p_plan_id, p_request_key, p_correlation_id, t.id,
    p_content_digest, p_mode, p_concurrency, p_stop_on_failure,
    left(p_dispatch_reference, 200), 'dispatched')
  returning * into b;

  update public.remediation_actions
     set execution_batch_id = b.id
   where tenant_id = p_tenant_id and id = any(p_action_ids);

  update public.remediation_plans set status = 'executing', updated_at = now()
    where tenant_id = p_tenant_id and id = p_plan_id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'agent', 'karya', null, null, null,
    'execution.started', p_plan_id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('batch_id', b.id, 'request_key', p_request_key,
      'action_count', array_length(p_action_ids, 1), 'mode', p_mode,
      'concurrency', p_concurrency, 'stop_on_failure', p_stop_on_failure));

  return jsonb_build_object('batch', jsonb_build_object('id', b.id, 'status', b.status), 'replay', false);
end $$;
revoke all on function public.start_execution_batch(uuid,uuid,text,uuid,text,text,text,integer,boolean,text,uuid[])
  from public, anon, authenticated;
grant execute on function public.start_execution_batch(uuid,uuid,text,uuid,text,text,text,integer,boolean,text,uuid[])
  to service_role;

create function public.mark_execution_action_started(
  p_tenant_id uuid, p_action_id uuid, p_batch_id uuid, p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare a public.remediation_actions;
begin
  select * into a from public.remediation_actions
    where tenant_id = p_tenant_id and id = p_action_id for update;
  if not found or a.execution_batch_id is distinct from p_batch_id
     or a.execution_status <> 'executing' then
    return jsonb_build_object('error', 'action_not_running');
  end if;
  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'agent', 'karya', null, null, null,
    'execution.action.started', p_action_id::text, null, null, null, null, null, null, 'pending',
    jsonb_build_object('batch_id', p_batch_id));
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.mark_execution_action_started(uuid,uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.mark_execution_action_started(uuid,uuid,uuid,uuid) to service_role;

create function public.settle_execution_action(
  p_tenant_id uuid,
  p_action_id uuid,
  p_batch_id uuid,
  p_outcome text,
  p_error_code text,
  p_pre_state_ref text,
  p_post_state_ref text,
  p_detail jsonb,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare a public.remediation_actions;
begin
  if p_outcome not in ('succeeded', 'failed')
     or (p_error_code is not null and p_error_code !~ '^[a-z0-9_]{1,80}$')
     or (p_pre_state_ref is not null and (length(p_pre_state_ref) = 0 or length(p_pre_state_ref) > 512
        or p_pre_state_ref !~ '^[A-Za-z0-9._:/-]+$'))
     or (p_post_state_ref is not null and (length(p_post_state_ref) = 0 or length(p_post_state_ref) > 512
        or p_post_state_ref !~ '^[A-Za-z0-9._:/-]+$'))
     or (p_detail is not null and (jsonb_typeof(p_detail) <> 'object' or octet_length(p_detail::text) > 4096)) then
    return jsonb_build_object('error', 'invalid_record');
  end if;

  select * into a from public.remediation_actions
    where tenant_id = p_tenant_id and id = p_action_id for update;
  if not found or a.execution_batch_id is distinct from p_batch_id
     or a.execution_status <> 'executing' then
    return jsonb_build_object('error', 'action_not_running');
  end if;

  update public.remediation_actions
     set execution_status = p_outcome::public.action_status,
         final_outcome = p_outcome,
         pre_state_uri = coalesce(p_pre_state_ref, pre_state_uri),
         post_state_uri = coalesce(p_post_state_ref, post_state_uri),
         executed_by_agent = 'karya',
         executed_at = now(),
         updated_at = now()
   where tenant_id = p_tenant_id and id = p_action_id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'agent', 'karya', null, null, null,
    (case when p_outcome = 'succeeded' then 'execution.action.succeeded' else 'execution.action.failed' end)::public.ledger_action_type,
    p_action_id::text, null, null, null, null, p_pre_state_ref, p_post_state_ref,
    (case when p_outcome = 'succeeded' then 'success' else 'failure' end)::public.ledger_result,
    jsonb_build_object('batch_id', p_batch_id, 'error_code', p_error_code, 'detail', p_detail));

  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.settle_execution_action(uuid,uuid,uuid,text,text,text,text,jsonb,uuid)
  from public, anon, authenticated;
grant execute on function public.settle_execution_action(uuid,uuid,uuid,text,text,text,text,jsonb,uuid)
  to service_role;

create function public.finish_execution_batch(
  p_tenant_id uuid, p_batch_id uuid, p_status text, p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  b public.execution_batches;
  v_skipped uuid[];
  v_succeeded integer := 0;
  v_failed integer := 0;
begin
  if p_status not in ('completed', 'partial_failure', 'failed', 'halted', 'rolled_back') then
    return jsonb_build_object('error', 'invalid_status');
  end if;

  select * into b from public.execution_batches
    where tenant_id = p_tenant_id and id = p_batch_id for update;
  if not found then
    return jsonb_build_object('error', 'batch_not_found');
  end if;
  -- Idempotent finish: the first terminal status stands.
  if b.finished_at is not null then
    return jsonb_build_object('batch', jsonb_build_object('id', b.id, 'status', b.status), 'replay', true);
  end if;

  -- The sweep: actions the batch claimed but never settled return to
  -- `approved` — they remain approved work, retryable only under a fresh
  -- approval, because the token that covered them is already consumed.
  with swept as (
    update public.remediation_actions
       set execution_status = 'approved', updated_at = now()
     where tenant_id = p_tenant_id and execution_batch_id = b.id and execution_status = 'executing'
    returning id
  )
  select array_agg(id) into v_skipped from swept;

  select count(*) into v_succeeded from public.remediation_actions
    where execution_batch_id = b.id and final_outcome = 'succeeded';
  select count(*) into v_failed from public.remediation_actions
    where execution_batch_id = b.id and final_outcome = 'failed';

  update public.execution_batches
     set status = p_status, finished_at = now()
   where tenant_id = p_tenant_id and id = b.id;

  update public.remediation_plans set status = (
    case p_status
      when 'completed' then 'completed'::public.plan_status
      when 'rolled_back' then 'rolled_back'::public.plan_status
      when 'halted' then 'executing'::public.plan_status
      else 'partial_failure'::public.plan_status
    end)::public.plan_status, updated_at = now()
   where tenant_id = p_tenant_id and id = b.plan_id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'agent', 'karya', null, null, null,
    'execution.batch.completed', b.plan_id::text, null, null, null, null, null, null,
    (case when p_status = 'completed' then 'success' else 'failure' end)::public.ledger_result,
    jsonb_build_object('batch_id', b.id, 'status', p_status, 'succeeded', v_succeeded,
      'failed', v_failed, 'skipped', coalesce(array_length(v_skipped, 1), 0),
      'skipped_action_ids', to_jsonb(coalesce(v_skipped, '{}'::uuid[]))));

  return jsonb_build_object('batch', jsonb_build_object('id', b.id, 'status', p_status), 'replay', false);
end $$;
revoke all on function public.finish_execution_batch(uuid,uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.finish_execution_batch(uuid,uuid,text,uuid) to service_role;
