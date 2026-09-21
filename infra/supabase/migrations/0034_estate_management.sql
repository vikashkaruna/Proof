-- W3 human inventory changes, atomic with their audit entries. No external
-- connector/agent execution is authorized by these operations.
alter type public.ledger_action_type add value if not exists 'estate.created';
alter type public.ledger_action_type add value if not exists 'estate.updated';
alter type public.ledger_action_type add value if not exists 'estate.system.created';
alter type public.ledger_action_type add value if not exists 'estate.system.updated';
alter type public.ledger_action_type add value if not exists 'engagement.estate.assigned';

alter table public.estates add column version integer not null default 1 check(version>0);
alter table public.estate_systems add column version integer not null default 1 check(version>0);

alter table public.system_data_categories drop constraint system_data_categories_pkey;
alter table public.system_data_categories add primary key (tenant_id,system_id,category_key,source);

create function public.manage_estate(
  p_tenant_id uuid, p_actor_id uuid, p_operation text, p_resource_id uuid,
  p_payload jsonb, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  e public.estates; s public.estate_systems; assessment public.engagements;
  before_state jsonb; after_state jsonb; target uuid; event public.ledger_action_type;
  parent_id uuid;
begin
  -- The route capability check is repeated at the transaction boundary. Lock
  -- membership so a simultaneous demotion cannot race an accepted mutation.
  perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id
    and role in ('founder','owner','admin') for share;
  if not found then return jsonb_build_object('error','forbidden'); end if;
  if p_operation not in ('estate.create','estate.update','system.create','system.update','engagement.assign')
    or p_operation is null or jsonb_typeof(p_payload) is distinct from 'object' then
    return jsonb_build_object('error','invalid_operation');
  end if;

  if p_operation='estate.create' then
    insert into public.estates(tenant_id,slug,name,description)
      values(p_tenant_id,p_payload->>'slug',p_payload->>'name',coalesce(p_payload->>'description','')) returning * into e;
    target:=e.id; after_state:=to_jsonb(e); event:='estate.created';
  elsif p_operation='estate.update' then
    select * into e from public.estates where tenant_id=p_tenant_id and id=p_resource_id for update;
    if not found then return jsonb_build_object('error','not_found'); end if;
    if e.version is distinct from (p_payload->>'expectedVersion')::integer then return jsonb_build_object('error','version_conflict'); end if;
    if p_payload->>'status'='archived' and exists(select 1 from public.connectors c join public.estate_systems inventory
      on (inventory.tenant_id,inventory.id)=(c.tenant_id,c.system_id) where inventory.tenant_id=p_tenant_id and inventory.estate_id=e.id and c.status='active') then
      return jsonb_build_object('error','active_connectors');
    end if;
    before_state:=to_jsonb(e);
    update public.estates set name=p_payload->>'name', description=coalesce(p_payload->>'description',''),
      status=p_payload->>'status', version=version+1 where id=e.id returning * into e;
    target:=e.id; after_state:=to_jsonb(e); event:='estate.updated';
  elsif p_operation in ('system.create','system.update') then
    if p_operation='system.create' then parent_id:=p_resource_id;
    else
      select estate_id into parent_id from public.estate_systems where tenant_id=p_tenant_id and id=p_resource_id;
      if not found then return jsonb_build_object('error','not_found'); end if;
    end if;
    -- Same order as estate archival. A concurrent archive cannot admit a new system.
    select * into e from public.estates where tenant_id=p_tenant_id and id=parent_id for update;
    if not found then return jsonb_build_object('error','not_found'); end if;
    if e.status <> 'active' then return jsonb_build_object('error','estate_archived'); end if;
    if p_operation='system.create' then
      insert into public.estate_systems(tenant_id,estate_id,name,system_kind,external_ref,description)
        values(p_tenant_id,e.id,p_payload->>'name',p_payload->>'systemKind',nullif(p_payload->>'externalRef',''),coalesce(p_payload->>'description','')) returning * into s;
      event:='estate.system.created';
    else
      select * into s from public.estate_systems where tenant_id=p_tenant_id and id=p_resource_id for update;
      if s.version is distinct from (p_payload->>'expectedVersion')::integer then return jsonb_build_object('error','version_conflict'); end if;
      if p_payload->>'status'='archived' and exists(select 1 from public.connectors where tenant_id=p_tenant_id and system_id=s.id and status='active') then
        return jsonb_build_object('error','active_connectors');
      end if;
      before_state:=to_jsonb(s)||jsonb_build_object('declared_categories',coalesce((select jsonb_agg(category_key order by category_key) from public.system_data_categories where tenant_id=p_tenant_id and system_id=s.id and source='declared'),'[]'::jsonb));
      update public.estate_systems set name=p_payload->>'name', system_kind=p_payload->>'systemKind',
        external_ref=nullif(p_payload->>'externalRef',''),description=coalesce(p_payload->>'description',''),
        status=p_payload->>'status',version=version+1 where id=s.id returning * into s;
      event:='estate.system.updated';
    end if;
    -- Only operator declarations are edited here; observed scanner categories
    -- are separate provenance and must not be silently overwritten.
    if jsonb_typeof(p_payload->'dataCategories') is distinct from 'array' then raise exception 'dataCategories required' using errcode='23514'; end if;
    delete from public.system_data_categories where tenant_id=p_tenant_id and system_id=s.id and source='declared';
    insert into public.system_data_categories(tenant_id,system_id,category_key,source)
      select p_tenant_id,s.id,value,'declared' from jsonb_array_elements_text(p_payload->'dataCategories')
      on conflict (tenant_id,system_id,category_key,source) do nothing;
    target:=s.id; after_state:=to_jsonb(s)||jsonb_build_object('declared_categories',p_payload->'dataCategories');
  else
    select * into e from public.estates where tenant_id=p_tenant_id and id=(p_payload->>'estateId')::uuid for update;
    if not found then return jsonb_build_object('error','not_found'); end if;
    if e.status <> 'active' then return jsonb_build_object('error','estate_archived'); end if;
    select * into assessment from public.engagements where tenant_id=p_tenant_id and id=p_resource_id for update;
    if not found then return jsonb_build_object('error','not_found'); end if;
    if assessment.estate_id is not null then return jsonb_build_object('error','already_assigned'); end if;
    -- Do not reinterpret findings or work already performed against another scope.
    if assessment.status <> 'intake' or exists(select 1 from public.findings where engagement_id=assessment.id)
      or exists(select 1 from public.remediation_plans where engagement_id=assessment.id)
      or exists(select 1 from public.agent_runs where engagement_id=assessment.id)
      or exists(select 1 from public.evidence where engagement_id=assessment.id)
      or exists(select 1 from public.reports where engagement_id=assessment.id) then
      return jsonb_build_object('error','assessment_started');
    end if;
    if p_payload->>'confirmed' is distinct from 'true' then return jsonb_build_object('error','confirmation_required'); end if;
    before_state:=to_jsonb(assessment);
    update public.engagements set estate_id=e.id,updated_at=now() where id=assessment.id returning * into assessment;
    target:=assessment.id; after_state:=to_jsonb(assessment); event:='engagement.estate.assigned';
  end if;
  perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
    event,target::text,null,null,null,null,null,null,'success',
    jsonb_build_object('operation',p_operation,'before',before_state,'after',after_state));
  return jsonb_build_object('resource',after_state);
end;
$$;
revoke all on function public.manage_estate(uuid,uuid,text,uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.manage_estate(uuid,uuid,text,uuid,jsonb,uuid) to service_role;

-- All assessment creation paths must respect archived inventory, including the
-- pre-existing engagement POST route. The lock serializes with estate archival.
create function public.guard_engagement_estate_active() returns trigger
language plpgsql security definer set search_path='' as $$
declare lifecycle text;
begin
  if new.estate_id is null then return new; end if;
  if tg_op='UPDATE' and new.estate_id is not distinct from old.estate_id and new.tenant_id=old.tenant_id then return new; end if;
  select status into lifecycle from public.estates where tenant_id=new.tenant_id and id=new.estate_id for share;
  if not found then raise exception 'Estate not found in tenant' using errcode='23503'; end if;
  if lifecycle <> 'active' then raise exception 'Estate is archived' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.guard_engagement_estate_active() from public,anon,authenticated;
create trigger engagements_estate_active before insert or update of estate_id,tenant_id on public.engagements
  for each row execute function public.guard_engagement_estate_active();
