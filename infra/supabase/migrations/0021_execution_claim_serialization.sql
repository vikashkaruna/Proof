-- Forward-only correction to 0019/0020: overlapping claims must serialize,
-- and a lost acknowledgement must not release possibly running actions.
begin;

alter table public.remediation_actions drop constraint remediation_actions_dispatch_status_check;
alter table public.remediation_actions add constraint remediation_actions_dispatch_status_check
  check (dispatch_status is null or dispatch_status in ('pending', 'accepted', 'failed', 'unknown'));
alter table public.execution_dispatch_outbox drop constraint execution_dispatch_outbox_status_check;
alter table public.execution_dispatch_outbox add constraint execution_dispatch_outbox_status_check
  check (status in ('pending', 'delivered', 'failed', 'unknown', 'abandoned'));

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
      'request_key', p_request_key));

  select array_agg(a.id) into v_claimed
  from public.remediation_actions a
  where a.tenant_id = p_tenant_id and a.plan_id = p_plan_id
    and a.id = any(p_action_ids) and a.execution_request_key = p_request_key;

  return jsonb_build_object('decision', 'claimed', 'action_ids', to_jsonb(v_claimed));
end $$;

-- Settle both records in one transaction; never downgrade a delivered or
-- abandoned intent based on a delayed response. Unknown remains claimed.
create function public.finish_execution_dispatch(
  p_tenant_id uuid, p_plan_id uuid, p_request_key text,
  p_status text, p_reference text, p_error text
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_status is null or p_status not in ('accepted', 'failed', 'unknown') then
    raise exception 'invalid dispatch outcome';
  end if;
  perform 1 from public.remediation_plans
    where id = p_plan_id and tenant_id = p_tenant_id for update;
  perform 1 from public.execution_dispatch_outbox
    where tenant_id = p_tenant_id and plan_id = p_plan_id and request_key = p_request_key
      and status in ('pending', 'unknown') for update;
  if not found then return false; end if;

  update public.remediation_actions
     set dispatch_status = p_status, dispatch_reference = p_reference, dispatch_error = p_error,
         execution_status = case when p_status = 'failed' then 'approved'::public.action_status
                                 else execution_status end,
         execution_request_key = case when p_status = 'failed' then null else execution_request_key end
   where tenant_id = p_tenant_id and plan_id = p_plan_id and execution_request_key = p_request_key;
  update public.execution_dispatch_outbox
     set status = case when p_status = 'accepted' then 'delivered' else p_status end,
         attempts = attempts + 1, last_error = p_error,
         delivered_at = case when p_status = 'accepted' then now() else delivered_at end
   where tenant_id = p_tenant_id and plan_id = p_plan_id and request_key = p_request_key;
  return true;
end $$;
revoke all on function public.finish_execution_dispatch(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.finish_execution_dispatch(uuid, uuid, text, text, text, text)
  to service_role;

-- Keep failed and ambiguous deliveries visible until explicitly reconciled.
create or replace view public.pending_execution_dispatches as
  select id, tenant_id, plan_id, request_key, correlation_id, action_ids,
         attempts, last_error, created_at, now() - created_at as pending_for,
         status
    from public.execution_dispatch_outbox
   where status in ('pending', 'failed', 'unknown')
   order by created_at;
revoke all on public.pending_execution_dispatches from public, anon, authenticated;
grant select on public.pending_execution_dispatches to service_role;
commit;
