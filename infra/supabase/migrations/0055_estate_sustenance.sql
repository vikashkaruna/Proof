-- C-W3-6 sustenance: what a completed onboarding attested, drift from that
-- baseline, and periodic human re-attestation of agent access grants.
-- Nothing here issues a grant; revocation is the only authority change.
alter type public.ledger_action_type add value if not exists 'connector.grant.attested';
alter type public.ledger_action_type add value if not exists 'connector.grant.revoked';

-- Immutable baseline written once, when a wizard run completes.
create table public.onboarding_attested_systems (
  tenant_id uuid not null,
  wizard_id uuid not null,
  system_id uuid not null,
  system_version integer not null check (system_version > 0),
  declared_categories text[] not null,
  manual boolean not null,
  connector_registered boolean not null,
  primary key (wizard_id, system_id),
  foreign key (tenant_id, wizard_id) references public.tenant_onboarding_wizards(tenant_id, id) on delete restrict,
  foreign key (tenant_id, system_id) references public.estate_systems(tenant_id, id) on delete restrict
);
alter table public.onboarding_attested_systems enable row level security;
revoke all on public.onboarding_attested_systems from public, anon, authenticated, service_role;
grant select on public.onboarding_attested_systems to service_role, authenticated;
create policy bff_service_read on public.onboarding_attested_systems for select to service_role using (true);
create policy tenant_member_read on public.onboarding_attested_systems for select to authenticated
  using (public.is_tenant_member(tenant_id));

create function public.snapshot_onboarding_attestation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'completed' and old.status = 'in_progress' then
    insert into public.onboarding_attested_systems(tenant_id, wizard_id, system_id, system_version,
      declared_categories, manual, connector_registered)
    select s.tenant_id, new.id, s.id, s.version,
      coalesce((select array_agg(d.category_key order by d.category_key) from public.system_data_categories d
        where d.tenant_id = s.tenant_id and d.system_id = s.id and d.source = 'declared'), '{}'),
      s.id = any(new.manual_system_ids),
      exists (select 1 from public.connectors c where c.tenant_id = s.tenant_id and c.system_id = s.id
        and c.status <> 'archived')
    from public.estate_systems s
    where s.tenant_id = new.tenant_id and s.estate_id = new.estate_id and s.status = 'active';
  end if;
  return new;
end $$;
revoke all on function public.snapshot_onboarding_attestation() from public, anon, authenticated;
create trigger onboarding_attestation_snapshot after update of status on public.tenant_onboarding_wizards
  for each row execute function public.snapshot_onboarding_attestation();

-- Drift from the latest completed onboarding of an estate. Runs completed
-- before this migration have no baseline and say so.
create function public.onboarding_estate_drift(p_tenant_id uuid, p_estate_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare w public.tenant_onboarding_wizards; added jsonb; removed jsonb; changed jsonb; lost jsonb;
begin
  if not exists (select 1 from public.estates where tenant_id = p_tenant_id and id = p_estate_id) then
    return jsonb_build_object('error', 'not_found');
  end if;
  select * into w from public.tenant_onboarding_wizards where tenant_id = p_tenant_id and estate_id = p_estate_id
    and status = 'completed' order by completed_at desc limit 1;
  if not found then return jsonb_build_object('status', 'not_onboarded'); end if;
  if not exists (select 1 from public.onboarding_attested_systems where wizard_id = w.id) then
    return jsonb_build_object('status', 'no_baseline', 'baselineWizardId', w.id, 'completedAt', w.completed_at);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.name), '[]') into added
    from public.estate_systems s where s.tenant_id = p_tenant_id and s.estate_id = p_estate_id and s.status = 'active'
      and not exists (select 1 from public.onboarding_attested_systems a where a.wizard_id = w.id and a.system_id = s.id);
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.name), '[]') into removed
    from public.onboarding_attested_systems a join public.estate_systems s on (s.tenant_id, s.id) = (a.tenant_id, a.system_id)
    where a.wizard_id = w.id and (s.status <> 'active' or s.estate_id <> p_estate_id);
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.name), '[]') into changed
    from public.onboarding_attested_systems a join public.estate_systems s on (s.tenant_id, s.id) = (a.tenant_id, a.system_id)
    where a.wizard_id = w.id and s.status = 'active' and s.estate_id = p_estate_id and (s.version <> a.system_version
      or a.declared_categories is distinct from coalesce((select array_agg(d.category_key order by d.category_key)
        from public.system_data_categories d where d.tenant_id = s.tenant_id and d.system_id = s.id and d.source = 'declared'), '{}'));
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.name), '[]') into lost
    from public.onboarding_attested_systems a join public.estate_systems s on (s.tenant_id, s.id) = (a.tenant_id, a.system_id)
    where a.wizard_id = w.id and s.status = 'active' and not a.manual and not exists (select 1 from public.connectors c
      where c.tenant_id = s.tenant_id and c.system_id = s.id and c.status <> 'archived');
  return jsonb_build_object(
    'status', case when added = '[]' and removed = '[]' and changed = '[]' and lost = '[]' then 'current' else 'drifted' end,
    'baselineWizardId', w.id, 'completedAt', w.completed_at,
    'added', added, 'removed', removed, 'changed', changed, 'connectionLost', lost);
end $$;

-- Append-only human decisions about agent grants.
create table public.connector_grant_attestations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  grant_id uuid not null,
  decision text not null check (decision in ('keep', 'revoke')),
  attested_by uuid not null references public.users(id) on delete restrict,
  attested_at timestamptz not null default now(),
  next_due_at timestamptz,
  check ((decision = 'keep') = (next_due_at is not null)),
  foreign key (tenant_id, grant_id) references public.connector_grants(tenant_id, id) on delete restrict
);
create index connector_grant_attestations_latest on public.connector_grant_attestations(tenant_id, grant_id, attested_at desc);
alter table public.connector_grant_attestations enable row level security;
revoke all on public.connector_grant_attestations from public, anon, authenticated, service_role;
grant select on public.connector_grant_attestations to service_role, authenticated;
create policy bff_service_read on public.connector_grant_attestations for select to service_role using (true);
create policy tenant_member_read on public.connector_grant_attestations for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- Active grants with their review due date: the last "keep" decision's due
-- date, or 90 days after issue when never reviewed.
create function public.connector_grant_review_queue(p_tenant_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(item order by (item->>'dueAt')::timestamptz, item->>'id'), '[]')
  from (
    select jsonb_build_object('id', g.id, 'connectorId', g.connector_id, 'connectorName', c.name,
      'agentName', g.agent_name, 'scope', g.internal_scope, 'targetScopes', to_jsonb(g.target_scopes),
      'expiresAt', g.expires_at, 'lastAttestedAt', last.attested_at,
      'dueAt', coalesce(last.next_due_at, g.created_at + interval '90 days'),
      'overdue', coalesce(last.next_due_at, g.created_at + interval '90 days') <= now()) as item
    from public.connector_grants g
    join public.connectors c on (c.tenant_id, c.id) = (g.tenant_id, g.connector_id)
    left join lateral (select a.attested_at, a.next_due_at from public.connector_grant_attestations a
      where a.tenant_id = g.tenant_id and a.grant_id = g.id order by a.attested_at desc limit 1) last on true
    where g.tenant_id = p_tenant_id and g.revoked_at is null and g.expires_at > now()
  ) queue
$$;

create function public.attest_connector_grant(
  p_tenant_id uuid, p_actor_id uuid, p_grant_id uuid, p_decision text, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare g public.connector_grants; a public.connector_grant_attestations;
begin
  perform 1 from public.tenant_users where tenant_id = p_tenant_id and user_id = p_actor_id
    and role in ('founder','owner','admin') for share;
  if not found then return jsonb_build_object('error','forbidden'); end if;
  if p_decision is null or p_decision not in ('keep','revoke') then return jsonb_build_object('error','invalid_decision'); end if;
  select * into g from public.connector_grants where tenant_id = p_tenant_id and id = p_grant_id for update;
  if not found then return jsonb_build_object('error','not_found'); end if;
  if g.revoked_at is not null or g.expires_at <= now() then return jsonb_build_object('error','not_active'); end if;
  insert into public.connector_grant_attestations(tenant_id, grant_id, decision, attested_by, next_due_at)
    values (p_tenant_id, g.id, p_decision, p_actor_id, case when p_decision = 'keep' then now() + interval '90 days' end)
    returning * into a;
  if p_decision = 'revoke' then
    update public.connector_grants set revoked_at = clock_timestamp() where id = g.id;
  end if;
  perform public.append_ledger(p_tenant_id, p_correlation_id, 'human', p_actor_id::text, null, null, null,
    case when p_decision = 'keep' then 'connector.grant.attested' else 'connector.grant.revoked' end::public.ledger_action_type,
    g.id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('connector_id', g.connector_id, 'agent_name', g.agent_name, 'scope', g.internal_scope,
      'decision', p_decision, 'next_due_at', a.next_due_at));
  return jsonb_build_object('attestation', to_jsonb(a));
end $$;

revoke all on function public.onboarding_estate_drift(uuid,uuid) from public, anon, authenticated;
revoke all on function public.connector_grant_review_queue(uuid) from public, anon, authenticated;
revoke all on function public.attest_connector_grant(uuid,uuid,uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.onboarding_estate_drift(uuid,uuid) to service_role;
grant execute on function public.connector_grant_review_queue(uuid) to service_role;
grant execute on function public.attest_connector_grant(uuid,uuid,uuid,text,uuid) to service_role;
