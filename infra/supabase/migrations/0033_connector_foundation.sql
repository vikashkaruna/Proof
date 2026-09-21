-- W2 connector data foundation only. No rows grant executable authority until
-- W4 authenticates workloads, checks live grants and obtains scoped credentials.
begin;

-- convert_to is catalogue-stable in PostgreSQL; fix the encoding explicitly
-- in this pure helper so generated digests do not depend on session settings.
create function public.connector_content_sha256(p_content text) returns text
language sql immutable set search_path = '' as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_content,'UTF8')),'hex')
$$;
revoke all on function public.connector_content_sha256(text) from public, anon;
grant execute on function public.connector_content_sha256(text) to authenticated, service_role;

-- Published, non-secret catalogue entries. A new version is a new row.
create table public.connector_descriptors (
  id uuid primary key default gen_random_uuid(),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug)<=80),
  version text not null check (length(btrim(version)) between 1 and 80),
  transport text not null check (transport in ('rest','sql','graphql','mcp')),
  target_binding text not null check (target_binding in ('production','sandbox','reference-mock')),
  manifest jsonb not null check (jsonb_typeof(manifest)='object'),
  -- Hash the stored JSON representation; callers read this value to pin it.
  content_sha256 text generated always as (public.connector_content_sha256(manifest::text)) stored,
  created_at timestamptz not null default now(),
  unique(slug,version,target_binding),
  unique(id,target_binding)
);

create table public.connectors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  system_id uuid not null,
  descriptor_id uuid not null,
  target_binding text not null check (target_binding in ('production','sandbox','reference-mock')),
  name text not null check(length(btrim(name)) between 1 and 200),
  -- Safe operator identifier, never a credential-bearing connection URI.
  endpoint_ref text not null check(length(btrim(endpoint_ref)) between 1 and 500),
  assurance text not null check (assurance in ('high','low')),
  status text not null default 'draft' check(status in ('draft','active','disabled','archived')),
  created_at timestamptz not null default now(),
  unique(tenant_id,id),
  foreign key(tenant_id,system_id) references public.estate_systems(tenant_id,id) on delete restrict,
  foreign key(descriptor_id,target_binding) references public.connector_descriptors(id,target_binding) on delete restrict
);
create index connectors_system on public.connectors(tenant_id,system_id);

-- Broker-private envelope storage. No access/refresh token cache in this table.
create table public.connector_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  connector_id uuid not null,
  grant_type text not null check(grant_type in ('client_credentials','token_exchange','cloud_iam','legacy_static')),
  key_ref text not null check(length(btrim(key_ref)) between 1 and 500),
  algorithm text not null check(algorithm='aes-256-gcm'),
  nonce bytea not null check(octet_length(nonce)=12),
  ciphertext bytea not null check(octet_length(ciphertext)>16),
  wrapped_data_key bytea not null check(octet_length(wrapped_data_key)>0),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  unique(tenant_id,id),
  foreign key(tenant_id,connector_id) references public.connectors(tenant_id,id) on delete restrict,
  check(expires_at is null or expires_at>created_at),
  check(revoked_at is null or revoked_at>=created_at)
);
create index connector_credentials_lookup on public.connector_credentials(tenant_id,connector_id) where revoked_at is null;

-- Registrations, not SVIDs or private keys. Runtime attestation is W4.3.
create table public.workload_identities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  agent_name text not null check(agent_name in ('drishti','vibhaag','parikshan','saakshi','sudhaar','karya','lekha','nazar','prativedan','sanket')),
  spiffe_id text not null check(spiffe_id ~ '^spiffe://[^/?#]+/[^?#]+$'),
  status text not null default 'disabled' check(status in ('active','disabled')),
  created_at timestamptz not null default now(),
  unique(tenant_id,id,agent_name),
  unique(tenant_id,spiffe_id)
);

create table public.connector_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  connector_id uuid not null,
  workload_identity_id uuid not null,
  agent_name text not null,
  internal_scope text not null check(internal_scope in ('connector.read','connector.write')),
  target_scopes text[] not null default '{}',
  -- A policy requirement, not evidence that a human approved an invocation.
  additional_confirmation_required boolean not null default true,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  unique(tenant_id,id),
  foreign key(tenant_id,connector_id) references public.connectors(tenant_id,id) on delete restrict,
  foreign key(tenant_id,workload_identity_id,agent_name) references public.workload_identities(tenant_id,id,agent_name) on delete restrict,
  -- The accepted ten-agent matrix: Drishti reads; only Karya writes.
  check((agent_name='drishti' and internal_scope='connector.read') or (agent_name='karya' and internal_scope='connector.write')),
  check(expires_at>created_at),
  check(revoked_at is null or revoked_at>=created_at),
  check(array_position(target_scopes,null) is null and array_position(target_scopes,'') is null)
);
create index connector_grants_lookup on public.connector_grants(tenant_id,connector_id,workload_identity_id,expires_at) where revoked_at is null;

-- Append-only observations. Healthy metadata does not imply a live connector.
create table public.connector_health_checks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  connector_id uuid not null,
  status text not null check(status in ('healthy','degraded','unreachable')),
  checked_at timestamptz not null default now(),
  latency_ms integer check(latency_ms>=0),
  -- Controlled diagnostic code; no raw upstream response/client values.
  error_code text check(error_code ~ '^[a-z0-9_]{1,80}$'),
  unique(tenant_id,id),
  foreign key(tenant_id,connector_id) references public.connectors(tenant_id,id) on delete restrict
);
create index connector_health_history on public.connector_health_checks(tenant_id,connector_id,checked_at desc);

-- Internal registry only; outbound MCP is optional, no inbound MCP server.
create table public.mcp_tool_registry (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  connector_id uuid not null,
  tool_name text not null check(length(btrim(tool_name)) between 1 and 200),
  tool_version text not null check(length(btrim(tool_version)) between 1 and 80),
  operation_class text not null check(operation_class in ('read','write')),
  description text not null,
  description_sha256 text generated always as (public.connector_content_sha256(description)) stored,
  input_schema jsonb not null check(jsonb_typeof(input_schema)='object'),
  created_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(tenant_id,connector_id,tool_name,tool_version),
  foreign key(tenant_id,connector_id) references public.connectors(tenant_id,id) on delete restrict
);

-- All application writes remain behind the BFF. Explicit service policies
-- work on ordinary PostgreSQL, where service_role need not have BYPASSRLS.
do $$ declare t text; begin
  foreach t in array array['connectors','connector_credentials','workload_identities','connector_grants','connector_health_checks','mcp_tool_registry'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role',t);
    execute format('grant select,insert,update,delete on public.%I to service_role',t);
    execute format('create policy bff_service_access on public.%I for all to service_role using (true) with check (true)',t);
    if t <> 'connector_credentials' then
      execute format('grant select on public.%I to authenticated',t);
      execute format('create policy tenant_member_read on public.%I for select to authenticated using(public.is_tenant_member(tenant_id))',t);
    end if;
  end loop;
end $$;
alter table public.connector_descriptors enable row level security;
revoke all on public.connector_descriptors from public, anon, authenticated, service_role;
grant select on public.connector_descriptors to authenticated;
grant select,insert on public.connector_descriptors to service_role;
create policy catalogue_read on public.connector_descriptors for select to authenticated using (true);
create policy bff_service_access on public.connector_descriptors for all to service_role using(true) with check(true);
-- A new descriptor/tool version or health observation gets a new row.
revoke update,delete on public.mcp_tool_registry,public.connector_health_checks from service_role;
commit;
