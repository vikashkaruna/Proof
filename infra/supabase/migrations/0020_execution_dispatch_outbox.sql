-- W5: a durable record of work we promised to dispatch.
--
-- 0019 made the claim atomic and made a refused dispatch visible. What it did
-- not do is survive the BFF dying between the two. Claim and dispatch are
-- separate operations against separate systems, so there is a window where the
-- token is spent, the actions are claimed, and the process disappears before
-- the runtime hears anything. Nothing then holds the intent: the actions sit
-- in `executing` with no work behind them and no record of what should have
-- been sent.
--
-- The outbox row is written in the SAME transaction as the claim, which is the
-- only arrangement where "we took the token" and "we owe a dispatch" cannot
-- disagree. Delivery is recorded separately, because delivery is the part that
-- can fail.
--
-- This is the storage and the reconciliation query. The worker that drains it
-- is still W5 work; until it exists an operator runs
-- `select * from public.pending_execution_dispatches` and decides. That is
-- deliberately better than an automatic retry nobody has designed yet: the
-- actions carry an approval token that was already consumed, so re-dispatching
-- is a decision about a client's production estate, not a cron job.
begin;

create table public.execution_dispatch_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  plan_id uuid not null references public.remediation_plans(id) on delete cascade,

  -- The batch's Idempotency-Key. One outbox row per request, matching the
  -- claim it was written with.
  request_key text not null,
  correlation_id uuid not null,
  action_ids uuid[] not null,

  -- What the runtime was promised, so a reconciler can send exactly what the
  -- approver authorised rather than rebuilding it from current state, which
  -- may have moved on.
  payload jsonb not null default '{}'::jsonb,

  status text not null default 'pending',
  attempts integer not null default 0,
  last_error text,

  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  -- Set when an operator or a future worker decides this intent is closed
  -- without delivery. Never deleted: the row is the evidence that a token was
  -- spent on work that did not run.
  abandoned_at timestamptz,
  abandoned_reason text,

  constraint execution_dispatch_outbox_status_check
    check (status in ('pending', 'delivered', 'failed', 'abandoned')),
  -- One intent per request, which is what makes a redelivery idempotent.
  constraint execution_dispatch_outbox_request_unique unique (tenant_id, plan_id, request_key)
);

comment on table public.execution_dispatch_outbox is
  'Durable intent to dispatch an approved batch, written in the same transaction as the execution claim (W5).';

create index execution_dispatch_outbox_pending_idx
  on public.execution_dispatch_outbox (created_at)
  where status = 'pending';

alter table public.execution_dispatch_outbox enable row level security;
revoke all on public.execution_dispatch_outbox from public, anon, authenticated;
create policy execution_dispatch_outbox_no_client on public.execution_dispatch_outbox
  for all using (false) with check (false);

-- What an operator reads. A pending row older than a few minutes means a
-- dispatch was promised and never confirmed — the crash window above.
create view public.pending_execution_dispatches as
  select id, tenant_id, plan_id, request_key, correlation_id, action_ids,
         attempts, last_error, created_at,
         now() - created_at as pending_for
    from public.execution_dispatch_outbox
   where status = 'pending'
   order by created_at;

revoke all on public.pending_execution_dispatches from public, anon, authenticated;

-- ─── Claim, now with the intent attached ─────────────────────────────
-- Replaces 0019's version. Same decisions, same order, plus the outbox row
-- written inside the same transaction as the token consumption.
--
-- The old signature is DROPPED rather than replaced. `create or replace` with
-- extra defaulted parameters creates an overload, and a five-argument call
-- would then be ambiguous between the two — Postgres refuses it outright, so
-- the execute path would break on the first request rather than quietly using
-- the version without an outbox.
drop function if exists public.claim_plan_execution(uuid, uuid, uuid, uuid[], text);

create function public.claim_plan_execution(
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
  v_existing uuid[];
  v_foreign integer;
begin
  if p_request_key is null or p_request_key = '' then
    return jsonb_build_object('decision', 'missing_request_key');
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

  select array_agg(a.id) into v_existing
  from public.remediation_actions a
  where a.tenant_id = p_tenant_id and a.plan_id = p_plan_id
    and a.id = any(p_action_ids) and a.execution_request_key = p_request_key;

  if v_existing is not null and array_length(v_existing, 1) = array_length(p_action_ids, 1) then
    return jsonb_build_object('decision', 'already_claimed', 'action_ids', to_jsonb(v_existing));
  end if;

  if exists (
    select 1 from public.remediation_actions a
    where a.tenant_id = p_tenant_id and a.plan_id = p_plan_id and a.id = any(p_action_ids)
      and a.execution_request_key is not null and a.execution_request_key <> p_request_key
      and a.execution_status = 'executing'
  ) then
    return jsonb_build_object('decision', 'already_executing');
  end if;

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

  -- The intent, in the same transaction as the token it spent.
  insert into public.execution_dispatch_outbox(
    tenant_id, plan_id, request_key, correlation_id, action_ids, payload)
  values (
    p_tenant_id, p_plan_id, p_request_key,
    coalesce(p_correlation_id, gen_random_uuid()), p_action_ids, coalesce(p_payload, '{}'::jsonb))
  on conflict (tenant_id, plan_id, request_key) do nothing;

  select array_agg(a.id) into v_claimed
  from public.remediation_actions a
  where a.tenant_id = p_tenant_id and a.plan_id = p_plan_id
    and a.id = any(p_action_ids) and a.execution_request_key = p_request_key;

  return jsonb_build_object('decision', 'claimed', 'action_ids', to_jsonb(v_claimed));
end $$;

-- Delivery outcome. Separate from the claim because this is the half that can
-- fail, and a failure has to leave the row readable rather than remove it.
create function public.settle_execution_dispatch(
  p_tenant_id uuid,
  p_plan_id uuid,
  p_request_key text,
  p_status text,
  p_error text
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('delivered', 'failed') then
    raise exception 'dispatch settlement must be delivered or failed, got %', p_status;
  end if;
  update public.execution_dispatch_outbox
     set status = p_status,
         attempts = attempts + 1,
         last_error = p_error,
         delivered_at = case when p_status = 'delivered' then now() else delivered_at end
   where tenant_id = p_tenant_id and plan_id = p_plan_id and request_key = p_request_key
     and status <> 'delivered';
  return found;
end $$;

revoke all on function
  public.claim_plan_execution(uuid, uuid, uuid, uuid[], text, uuid, jsonb),
  public.settle_execution_dispatch(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function
  public.claim_plan_execution(uuid, uuid, uuid, uuid[], text, uuid, jsonb),
  public.settle_execution_dispatch(uuid, uuid, text, text, text)
  to service_role;
grant select on public.pending_execution_dispatches to service_role;

commit;
