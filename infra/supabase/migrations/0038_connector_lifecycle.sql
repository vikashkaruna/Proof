-- W4.1 human registration lifecycle, not execution authority.
alter type public.ledger_action_type add value if not exists 'connector.registered';
alter type public.ledger_action_type add value if not exists 'connector.updated';
alter table public.connectors add column version integer not null default 1 check(version>0);
alter table public.connectors add column updated_at timestamptz not null default now();

create function public.manage_connector(
  p_tenant_id uuid, p_actor_id uuid, p_operation text, p_resource_id uuid,
  p_payload jsonb, p_descriptor jsonb, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  e public.estates; s public.estate_systems; c public.connectors; d public.connector_descriptors;
  parent_id uuid; system_id uuid; before_state jsonb; event public.ledger_action_type;
  new_status text; grants_revoked integer:=0; credentials_revoked integer:=0;
begin
  perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id
    and role in ('founder','owner','admin') for share;
  if not found then return jsonb_build_object('error','forbidden'); end if;
  if p_operation not in ('create','edit','transition') or p_operation is null
    or jsonb_typeof(p_payload) is distinct from 'object' then
    return jsonb_build_object('error','invalid_operation');
  end if;
  if p_operation in ('create','edit') and (
    coalesce(p_payload->>'endpointRef','') !~ '^[a-z][a-z0-9_-]{0,79}$'
    or length(btrim(coalesce(p_payload->>'name',''))) not between 1 and 200
  ) then return jsonb_build_object('error','invalid_operation'); end if;
  if p_operation='create' then system_id:=(p_payload->>'systemId')::uuid;
  else
    select inventory.system_id into system_id from public.connectors inventory where tenant_id=p_tenant_id and id=p_resource_id;
    if not found then return jsonb_build_object('error','not_found'); end if;
  end if;
  select estate_id into parent_id from public.estate_systems where tenant_id=p_tenant_id and id=system_id;
  if not found then return jsonb_build_object('error','not_found'); end if;
  -- Same order as manage_estate: estate -> system -> connector. Concurrent
  -- activation/archival cannot both succeed based on an old parent state.
  select * into e from public.estates where tenant_id=p_tenant_id and id=parent_id for update;
  select * into s from public.estate_systems where tenant_id=p_tenant_id and id=system_id for update;
  if not found then return jsonb_build_object('error','not_found'); end if;
  if p_operation='create' then
    if e.status<>'active' or s.status<>'active' then return jsonb_build_object('error','parent_archived'); end if;
    if p_descriptor is null or p_descriptor->>'id' is distinct from p_payload->>'descriptorId'
      or p_descriptor->>'schemaVersion' is distinct from '1' then return jsonb_build_object('error','descriptor_conflict'); end if;
    -- Only the BFF's reviewed, schema-validated catalogue reaches this service-only RPC.
    insert into public.connector_descriptors(id,slug,version,transport,target_binding,manifest)
      values((p_descriptor->>'id')::uuid,p_descriptor->>'target',p_descriptor->>'version',
        p_descriptor->>'transport',p_descriptor->>'targetBinding',p_descriptor)
      on conflict do nothing;
    select * into d from public.connector_descriptors where id=(p_descriptor->>'id')::uuid;
    if not found or d.manifest is distinct from p_descriptor or d.slug is distinct from p_descriptor->>'target'
      or d.version is distinct from p_descriptor->>'version' or d.transport is distinct from p_descriptor->>'transport'
      or d.target_binding is distinct from p_descriptor->>'targetBinding' then
      return jsonb_build_object('error','descriptor_conflict');
    end if;
    insert into public.connectors(tenant_id,system_id,descriptor_id,target_binding,name,endpoint_ref,assurance)
      values(p_tenant_id,s.id,d.id,d.target_binding,btrim(p_payload->>'name'),p_payload->>'endpointRef',p_descriptor->>'assurance') returning * into c;
    event:='connector.registered';
  else
    select * into c from public.connectors where tenant_id=p_tenant_id and id=p_resource_id for update;
    if not found then return jsonb_build_object('error','not_found'); end if;
    if c.version is distinct from (p_payload->>'expectedVersion')::integer then return jsonb_build_object('error','version_conflict'); end if;
    if c.status='archived' then return jsonb_build_object('error','invalid_transition'); end if;
    before_state:=to_jsonb(c);
    if p_operation='edit' then
      if c.status='active' then return jsonb_build_object('error','disable_before_edit'); end if;
      if e.status<>'active' or s.status<>'active' then return jsonb_build_object('error','parent_archived'); end if;
      update public.connectors set name=btrim(p_payload->>'name'), endpoint_ref=p_payload->>'endpointRef',
        version=version+1,updated_at=now() where id=c.id returning * into c;
    else
      new_status:=p_payload->>'status';
      if new_status is null or new_status not in ('active','disabled','archived') or new_status=c.status
        or (c.status='active' and new_status='archived') then return jsonb_build_object('error','invalid_transition'); end if;
      if new_status='active' then
        if e.status<>'active' or s.status<>'active' then return jsonb_build_object('error','parent_archived'); end if;
        select * into d from public.connector_descriptors where id=c.descriptor_id;
        if p_descriptor is null or d.manifest is distinct from p_descriptor or d.id::text is distinct from p_descriptor->>'id'
          or d.target_binding is distinct from p_descriptor->>'targetBinding' or c.assurance is distinct from p_descriptor->>'assurance'
          or c.endpoint_ref !~ '^[a-z][a-z0-9_-]{0,79}$' then return jsonb_build_object('error','descriptor_conflict'); end if;
      end if;
      -- Re-enabling must never resurrect a previously granted authority.
      if new_status in ('disabled','archived') then
        update public.connector_grants set revoked_at=clock_timestamp() where tenant_id=p_tenant_id and connector_id=c.id and revoked_at is null;
        get diagnostics grants_revoked = row_count;
      end if;
      if new_status='archived' then
        update public.connector_credentials set revoked_at=clock_timestamp() where tenant_id=p_tenant_id and connector_id=c.id and revoked_at is null;
        get diagnostics credentials_revoked = row_count;
      end if;
      update public.connectors set status=new_status,version=version+1,updated_at=now() where id=c.id returning * into c;
    end if;
    event:='connector.updated';
  end if;
  perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
    event,c.id::text,null,null,null,null,null,null,'success',
    jsonb_build_object('operation',p_operation,'before',before_state,'after',to_jsonb(c),
      'grants_revoked',grants_revoked,'credentials_revoked',credentials_revoked));
  return jsonb_build_object('resource',to_jsonb(c));
end $$;
revoke all on function public.manage_connector(uuid,uuid,text,uuid,jsonb,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.manage_connector(uuid,uuid,text,uuid,jsonb,jsonb,uuid) to service_role;
