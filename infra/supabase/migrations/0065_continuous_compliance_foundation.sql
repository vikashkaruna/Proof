-- ─────────────────────────────────────────────────────────────────────
-- 0065_continuous_compliance_foundation.sql
--
-- W6 · Continuous compliance, foundation slice (Revision 94): the four
-- monitoring/policy tables Doc 11 (W2) lists as missing.
--
--   monitoring_schedules      cron-style schedules per estate driving
--                             re-discovery, re-assessment and drift
--                             checks; managed by estate managers.
--   drift_events              append-only detections against the last
--                             sealed baseline, with severity and
--                             acknowledgement.
--   standing_approval_policies human-authored, scope-bounded, expiring
--                             policies (M4.1). They REUSE the token
--                             gate — a policy never bypasses BR-1/BR-2;
--                             its evaluation issues a scoped token
--                             through the existing engine or escalates.
--   policy_evaluations        append-only record of what a policy did.
--
-- The scheduler, drift checks and the policy engine land in the slices
-- that consume these tables; this migration closes the W2 table gap and
-- gives the schedules a managed write path.
-- ─────────────────────────────────────────────────────────────────────

alter type public.ledger_action_type add value if not exists 'monitoring.schedule.registered';

create table public.monitoring_schedules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  estate_id uuid not null,
  name text not null check (name ~ '^[A-Za-z0-9_. -]{1,120}$'),
  kind text not null check (kind in ('rediscovery', 'reassessment', 'drift_check')),
  -- A 5-field cron expression in the estate's timezone; validated for
  -- shape here and by the scheduler that consumes it.
  cadence text not null check (cadence ~ '^[0-9*,/-]+ [0-9*,/-]+ [0-9*,/-]+ [0-9*,/-]+ [0-9*,/-]+$'),
  status text not null default 'active' check (status in ('active', 'paused', 'retired')),
  created_by uuid not null references public.users(id),
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, estate_id) references public.estates(tenant_id, id) on delete restrict
);
-- One ACTIVE schedule of a kind per estate: a duplicate is a
-- configuration error, not a second opinion. Retired schedules are
-- history and may repeat.
create unique index monitoring_schedules_one_active_per_kind
  on public.monitoring_schedules(tenant_id, estate_id, kind) where status = 'active';
create index monitoring_schedules_due on public.monitoring_schedules(tenant_id, status, next_run_at);
alter table public.monitoring_schedules enable row level security;
revoke all on public.monitoring_schedules from public, anon, authenticated, service_role;
grant select on public.monitoring_schedules to service_role, authenticated;
create policy bff_service_read on public.monitoring_schedules for select to service_role using (true);
create policy tenant_member_read on public.monitoring_schedules for select to authenticated
  using (public.is_tenant_member(tenant_id));

create table public.drift_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  estate_id uuid not null,
  kind text not null check (kind in (
    'system_added', 'system_removed', 'system_changed', 'connection_lost', 'control_drift')),
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  -- Bounded, identifier-shaped summary: what changed, by name — the
  -- details live in the records the drift was detected against.
  summary text not null check (length(summary) between 1 and 300),
  source_ref text check (source_ref is null or (length(source_ref) <= 200
    and source_ref ~ '^[A-Za-z0-9._:/-]+$')),
  detected_at timestamptz not null default now(),
  acknowledged_by uuid references public.users(id),
  acknowledged_at timestamptz,
  constraint drift_events_ack_shape check (
    (acknowledged_by is null) = (acknowledged_at is null)
  ),
  unique (tenant_id, id),
  foreign key (tenant_id, estate_id) references public.estates(tenant_id, id) on delete restrict
);
create index drift_events_estate_latest on public.drift_events(tenant_id, estate_id, detected_at desc);
alter table public.drift_events enable row level security;
revoke all on public.drift_events from public, anon, authenticated, service_role;
grant select on public.drift_events to service_role, authenticated;
create policy bff_service_read on public.drift_events for select to service_role using (true);
create policy tenant_member_read on public.drift_events for select to authenticated
  using (public.is_tenant_member(tenant_id));

create table public.standing_approval_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  name text not null check (name ~ '^[A-Za-z0-9_. -]{1,120}$'),
  version integer not null default 1,
  -- The bounded scope the policy may auto-approve: action types, a
  -- maximum blast radius and the environments it reaches. The policy
  -- engine evaluates against this scope and issues a scoped approval
  -- token THROUGH the existing engine, or escalates — it never executes.
  scope jsonb not null check (
    jsonb_typeof(scope) = 'object' and octet_length(scope::text) <= 16384
    and scope ? 'action_types' and jsonb_typeof(scope->'action_types') = 'array'
  ),
  status text not null default 'active' check (status in ('active', 'expired', 'revoked')),
  -- A policy is human-authored and human-approved; the columns are
  -- mandatory because an orphan policy is an unaccountable one.
  created_by uuid not null references public.users(id),
  approved_by uuid not null references public.users(id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create index standing_policies_active on public.standing_approval_policies(tenant_id, status, expires_at);
alter table public.standing_approval_policies enable row level security;
revoke all on public.standing_approval_policies from public, anon, authenticated, service_role;
grant select on public.standing_approval_policies to service_role, authenticated;
create policy bff_service_read on public.standing_approval_policies for select to service_role using (true);
create policy tenant_member_read on public.standing_approval_policies for select to authenticated
  using (public.is_tenant_member(tenant_id));

create table public.policy_evaluations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  policy_id uuid not null,
  plan_id uuid,
  decision text not null check (decision in ('within_policy', 'escalated', 'expired', 'revoked')),
  -- What matched and what would have been issued; metadata only.
  matched_scope jsonb check (matched_scope is null or octet_length(matched_scope::text) <= 16384),
  correlation_id uuid not null,
  evaluated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, policy_id)
    references public.standing_approval_policies(tenant_id, id) on delete restrict
);
create index policy_evaluations_policy_latest on public.policy_evaluations(tenant_id, policy_id, evaluated_at desc);
alter table public.policy_evaluations enable row level security;
revoke all on public.policy_evaluations from public, anon, authenticated, service_role;
grant select on public.policy_evaluations to service_role, authenticated;
create policy bff_service_read on public.policy_evaluations for select to service_role using (true);
create policy tenant_member_read on public.policy_evaluations for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- ─────────────────────────────────────────────────────────────────────
-- register_monitoring_schedule — the estate manager's write path.
-- Owner/admin only is enforced by the BFF capability gate; the function
-- itself enforces tenancy, estate membership and the one-active-per-kind
-- rule (a re-registration under the same key retires the previous one).
-- ─────────────────────────────────────────────────────────────────────
create function public.register_monitoring_schedule(
  p_tenant_id uuid,
  p_estate_id uuid,
  p_name text,
  p_kind text,
  p_cadence text,
  p_next_run_at timestamptz,
  p_created_by uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  r public.monitoring_schedules;
begin
  if p_name is null or p_name !~ '^[A-Za-z0-9_. -]{1,120}$'
     or p_kind not in ('rediscovery', 'reassessment', 'drift_check')
     or p_cadence is null
     or p_cadence !~ '^[0-9*,/-]+ [0-9*,/-]+ [0-9*,/-]+ [0-9*,/-]+ [0-9*,/-]+$'
     or p_next_run_at is null or p_next_run_at <= now() then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if not exists (select 1 from public.estates
                  where tenant_id = p_tenant_id and id = p_estate_id) then
    return jsonb_build_object('error', 'estate_not_found');
  end if;
  if not exists (select 1 from public.users where id = p_created_by) then
    return jsonb_build_object('error', 'creator_not_found');
  end if;

  -- Retire any previous active schedule of this kind for the estate: the
  -- new registration replaces it, audited, rather than doubling it.
  update public.monitoring_schedules
     set status = 'retired', updated_at = now()
   where tenant_id = p_tenant_id and estate_id = p_estate_id and kind = p_kind
     and status = 'active';

  insert into public.monitoring_schedules(tenant_id, estate_id, name, kind, cadence,
    status, created_by, next_run_at)
  values (p_tenant_id, p_estate_id, p_name, p_kind, p_cadence, 'active', p_created_by,
    p_next_run_at)
  returning * into r;

  perform public.append_ledger(
    p_tenant_id, gen_random_uuid(), 'human', p_created_by::text, null, null, null,
    'monitoring.schedule.registered', r.id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('schedule_id', r.id, 'estate_id', p_estate_id, 'kind', p_kind,
      'cadence', p_cadence, 'next_run_at', r.next_run_at));

  return jsonb_build_object('schedule', jsonb_build_object(
    'id', r.id, 'kind', r.kind, 'cadence', r.cadence, 'status', r.status,
    'nextRunAt', r.next_run_at, 'createdAt', r.created_at));
end $$;
revoke all on function public.register_monitoring_schedule(uuid,uuid,text,text,text,timestamptz,uuid)
  from public, anon, authenticated;
grant execute on function public.register_monitoring_schedule(uuid,uuid,text,text,text,timestamptz,uuid)
  to service_role;
