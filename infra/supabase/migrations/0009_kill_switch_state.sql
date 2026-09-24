-- ─────────────────────────────────────────────────────────────────────
-- 0009_kill_switch_state.sql
-- Shared kill-switch state (SEC-4 · FR-8.6).
--
-- The kill switch was a process-local object, acknowledged as
-- single-replica-only in its own docstring. The deployment target is
-- Cloud Run / EKS with multiple replicas, so engaging it halted exactly
-- one instance while every other replica carried on executing against a
-- client estate. FR-8.6 requires the halt to be "immediately effective".
--
-- State moves here so every replica reads the same answer. Postgres
-- rather than Redis: it is the trust anchor for approval tokens already,
-- it exists in every environment including the self-contained onprem
-- stack (W10), and no new infrastructure has to be provisioned for
-- staging to become correct. Replicas hold a short TTL cache in front of
-- this, so propagation is bounded by the TTL rather than by a fan-out.
-- ─────────────────────────────────────────────────────────────────────

create table public.kill_switch_state (
  -- A single global row plus at most one row per tenant. `scope_key` is
  -- the literal 'global' or the tenant UUID as text, so the primary key
  -- enforces "one state per scope" without a partial unique index.
  scope_key text primary key,
  scope text not null check (scope in ('global', 'tenant')),
  tenant_id uuid references public.tenants(id) on delete cascade,
  engaged boolean not null default false,
  reason text not null default '',
  -- The human who engaged it. Retained after release so the ledger and
  -- this table agree on who did what.
  engaged_by uuid references public.users(id) on delete set null,
  engaged_at timestamptz,
  released_by uuid references public.users(id) on delete set null,
  released_at timestamptz,
  updated_at timestamptz not null default now(),

  -- A tenant-scoped row must name its tenant; the global row must not.
  constraint kill_switch_scope_consistent check (
    (scope = 'global' and tenant_id is null and scope_key = 'global')
    or (scope = 'tenant' and tenant_id is not null and scope_key = tenant_id::text)
  )
);

comment on table public.kill_switch_state is
  'Shared kill-switch state. Read by every BFF replica through a short TTL cache (SEC-4, FR-8.6).';

-- Engaged rows are the hot read path.
create index kill_switch_state_engaged_idx
  on public.kill_switch_state (scope_key)
  where engaged;

-- The global row always exists, so a release can never be an insert race.
insert into public.kill_switch_state (scope_key, scope, engaged)
values ('global', 'global', false)
on conflict (scope_key) do nothing;

-- ─── RLS ─────────────────────────────────────────────────────────────
alter table public.kill_switch_state enable row level security;

-- Members of a tenant may see the global state and their own tenant's.
-- They may not see another tenant's, which would disclose that the other
-- tenant is halted.
create policy kill_switch_state_select on public.kill_switch_state
  for select
  using (
    scope = 'global'
    or tenant_id in (select tenant_id from public.tenant_users where user_id = auth.uid())
  );

-- Writes go through the BFF with the service-role key, after it has
-- checked the caller's role. No direct client write path.
create policy kill_switch_state_no_client_write on public.kill_switch_state
  for all
  using (false)
  with check (false);
