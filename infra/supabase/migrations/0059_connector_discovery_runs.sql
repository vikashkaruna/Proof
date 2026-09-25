-- W4.6/W4.7 discovery persistence. A Drishti discovery run through the SQL,
-- REST or GraphQL adapters is recorded append-only with its live grant, the
-- verified workload and a metadata-only result (resources, field names and
-- value-shape counts). Raw values are never accepted: the result is bounded
-- and its leaves may only be names, booleans or integers.
alter type public.ledger_action_type add value if not exists 'connector.discovery.completed';

create table public.connector_discovery_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  connector_id uuid not null,
  grant_id uuid not null,
  spiffe_id text not null check (length(spiffe_id) <= 2048),
  operation text not null check (operation in ('enumerate', 'sample')),
  resource text check (resource is null or resource ~ '^[A-Za-z0-9_.$-]{1,200}$'),
  record_count integer not null check (record_count between 0 and 1000),
  result jsonb not null check (jsonb_typeof(result) = 'array' and octet_length(result::text) <= 262144),
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, connector_id) references public.connectors(tenant_id, id) on delete restrict,
  foreign key (tenant_id, grant_id) references public.connector_grants(tenant_id, id) on delete restrict
);
create index connector_discovery_runs_latest on public.connector_discovery_runs(tenant_id, connector_id, created_at desc);
alter table public.connector_discovery_runs enable row level security;
revoke all on public.connector_discovery_runs from public, anon, authenticated, service_role;
grant select on public.connector_discovery_runs to service_role, authenticated;
create policy bff_service_read on public.connector_discovery_runs for select to service_role using (true);
create policy tenant_member_read on public.connector_discovery_runs for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- True when every string leaf is a short identifier-like token. Sampled text
-- values (emails, names, free text) contain characters this rejects.
create function public.discovery_result_is_metadata(p_value jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select not exists (
    select 1 from jsonb_path_query(p_value, 'strict $.**') leaf
    where jsonb_typeof(leaf) = 'string' and (leaf #>> '{}') !~ '^[A-Za-z0-9_.$ ()\[\],:-]{0,200}$'
       or jsonb_typeof(leaf) = 'number' and (leaf::text !~ '^-?[0-9]{1,12}$')
  )
$$;
revoke all on function public.discovery_result_is_metadata(jsonb) from public, anon, authenticated;

create function public.record_connector_discovery(
  p_tenant_id uuid, p_connector_id uuid, p_grant_id uuid, p_spiffe_id text, p_operation text,
  p_resource text, p_result jsonb, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare g public.connector_grants; w public.workload_identities; r public.connector_discovery_runs;
begin
  select * into g from public.connector_grants where tenant_id = p_tenant_id and id = p_grant_id
    and connector_id = p_connector_id for share;
  if not found or g.agent_name <> 'drishti' or g.internal_scope <> 'connector.read'
     or g.revoked_at is not null or g.expires_at <= now() then
    return jsonb_build_object('error', 'grant_inactive');
  end if;
  select * into w from public.workload_identities where tenant_id = p_tenant_id and id = g.workload_identity_id;
  if not found or w.spiffe_id is distinct from p_spiffe_id or w.status <> 'active' then
    return jsonb_build_object('error', 'workload_mismatch');
  end if;
  if p_operation is null or p_operation not in ('enumerate', 'sample')
     or (p_operation = 'sample') <> (p_resource is not null)
     or p_result is null or jsonb_typeof(p_result) <> 'array' or jsonb_array_length(p_result) > 1000
     or octet_length(p_result::text) > 262144 or not public.discovery_result_is_metadata(p_result) then
    return jsonb_build_object('error', 'invalid_result');
  end if;
  insert into public.connector_discovery_runs(tenant_id, connector_id, grant_id, spiffe_id, operation, resource,
    record_count, result, correlation_id)
  values (p_tenant_id, p_connector_id, g.id, w.spiffe_id, p_operation, p_resource, jsonb_array_length(p_result),
    p_result, p_correlation_id)
  returning * into r;
  perform public.append_ledger(p_tenant_id, p_correlation_id, 'agent', 'drishti', null, null, null,
    'connector.discovery.completed', r.id::text, null, encode(sha256(convert_to(p_result::text, 'UTF8')), 'hex'),
    null, null, null, null, 'success',
    jsonb_build_object('connector_id', p_connector_id, 'grant_id', g.id, 'spiffe_id', w.spiffe_id,
      'operation', p_operation, 'resource', p_resource, 'record_count', r.record_count));
  return jsonb_build_object('run', jsonb_build_object('id', r.id, 'createdAt', r.created_at, 'recordCount', r.record_count));
end $$;
revoke all on function public.record_connector_discovery(uuid,uuid,uuid,text,text,text,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.record_connector_discovery(uuid,uuid,uuid,text,text,text,jsonb,uuid) to service_role;
