-- W2 estate foundation. No inferred estate assignment for existing assessments.
-- Metadata only: these rows do not grant connector access or execute scans.
begin;

create table public.estates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  name text not null check (length(btrim(name)) between 1 and 200),
  description text not null default '',
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, slug)
);

create table public.estate_systems (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  estate_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 200),
  system_kind text not null check (system_kind in ('database','application','storage','identity','saas','other')),
  -- An operator's identifier, NOT an endpoint or credential.
  external_ref text,
  description text not null default '',
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, estate_id) references public.estates(tenant_id, id) on delete restrict
);
create index estate_systems_estate on public.estate_systems(tenant_id, estate_id);
create unique index estate_systems_external_ref on public.estate_systems(tenant_id, estate_id, external_ref)
  where external_ref is not null;

create table public.system_data_categories (
  tenant_id uuid not null,
  system_id uuid not null,
  category_key text not null check (category_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(category_key) <= 80),
  -- Declaration is not discovery evidence; verification comes from scans.
  source text not null default 'declared' check (source in ('declared','observed')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, system_id, category_key),
  foreign key (tenant_id, system_id) references public.estate_systems(tenant_id, id) on delete restrict
);

create table public.estate_scans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  estate_id uuid not null,
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','cancelled')),
  started_at timestamptz,
  completed_at timestamptz,
  summary jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, estate_id) references public.estates(tenant_id, id) on delete restrict,
  check (completed_at is null or (started_at is not null and completed_at >= started_at)),
  check ((status = 'queued' and started_at is null and completed_at is null)
      or (status = 'running' and started_at is not null and completed_at is null)
      or (status in ('succeeded','failed') and started_at is not null and completed_at is not null)
      or status = 'cancelled')
);
create index estate_scans_history on public.estate_scans(tenant_id, estate_id, created_at desc);

-- An old engagement remains explicitly unassigned until a human chooses scope.
-- Composite FK protects tenant integrity even for privileged API writes.
alter table public.engagements add column estate_id uuid;
alter table public.engagements add constraint engagements_estate_tenant_fk
 foreign key (tenant_id, estate_id) references public.estates(tenant_id, id) on delete restrict;
create index engagements_estate on public.engagements(tenant_id, estate_id) where estate_id is not null;

-- RLS is a second boundary, not a substitute for write privileges. Service
-- policies are explicit because higher environments do not have BYPASSRLS.
do $$ declare t text; begin
  foreach t in array array['estates','estate_systems','system_data_categories','estate_scans'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('create policy tenant_member_read on public.%I for select to authenticated using (public.is_tenant_member(tenant_id))', t);
    execute format('create policy bff_service_access on public.%I for all to service_role using (true) with check (true)', t);
  end loop;
end $$;
commit;
