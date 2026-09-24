-- C-W3-5: resumable onboarding wizard for an existing tenant.
-- company profile -> estate -> inventory -> connection path -> grant review ->
-- readiness. The wizard records progress and confirmations only. It reuses the
-- audited estate/connector APIs for inventory and registration, never issues
-- connector grants or credentials, and never claims a registration is a live
-- connection. Each step is atomic with its ledger entry.
alter type public.ledger_action_type add value if not exists 'onboarding.wizard.started';
alter type public.ledger_action_type add value if not exists 'onboarding.wizard.step_completed';
alter type public.ledger_action_type add value if not exists 'onboarding.wizard.completed';

-- The statutory contact belongs to the tenant, not to one wizard run.
alter table public.tenants
  add column dpo_name text check (dpo_name is null or char_length(btrim(dpo_name)) between 1 and 200),
  add column dpo_email text check (dpo_email is null or (dpo_email = lower(dpo_email)
    and char_length(dpo_email) between 3 and 320 and dpo_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'));

create table public.tenant_onboarding_wizards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  estate_id uuid,
  status text not null default 'in_progress' check (status in ('in_progress','completed')),
  completed_steps text[] not null default '{}' check (
    completed_steps <@ array['company','estate','inventory','connectors','grants','readiness']
    and array_position(completed_steps, null) is null),
  -- Systems the operator declared as assessed without a connector (manual evidence).
  manual_system_ids uuid[] not null default '{}' check (array_position(manual_system_ids, null) is null),
  version integer not null default 1 check (version > 0),
  started_by uuid not null references public.users(id) on delete restrict,
  completed_by uuid references public.users(id) on delete restrict,
  completed_at timestamptz,
  -- Server-computed checklist at the moment of completion.
  readiness jsonb check (readiness is null or jsonb_typeof(readiness) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, estate_id) references public.estates(tenant_id, id) on delete restrict,
  constraint onboarding_wizard_completion_consistent check (
    (status = 'in_progress' and completed_by is null and completed_at is null and readiness is null)
    or (status = 'completed' and completed_by is not null and completed_at is not null
        and readiness is not null and estate_id is not null
        and completed_steps @> array['company','estate','inventory','connectors','grants','readiness']))
);
create unique index tenant_onboarding_wizards_one_open on public.tenant_onboarding_wizards(tenant_id)
  where status = 'in_progress';

-- No deletion; a completed run is a record and cannot change.
create function public.onboarding_wizard_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'Onboarding wizard runs are retained' using errcode = '42501'; end if;
  if old.status = 'completed' then raise exception 'A completed onboarding run is immutable' using errcode = '42501'; end if;
  if new.id <> old.id or new.tenant_id <> old.tenant_id or new.started_by <> old.started_by
     or new.created_at <> old.created_at then
    raise exception 'Onboarding run identity is immutable' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger onboarding_wizard_guard before update or delete on public.tenant_onboarding_wizards
  for each row execute function public.onboarding_wizard_guard();

alter table public.tenant_onboarding_wizards enable row level security;
revoke all on public.tenant_onboarding_wizards from public, anon, authenticated, service_role;
grant select, insert, update on public.tenant_onboarding_wizards to service_role;
grant select on public.tenant_onboarding_wizards to authenticated;
create policy bff_service_access on public.tenant_onboarding_wizards for all to service_role using (true) with check (true);
create policy tenant_member_read on public.tenant_onboarding_wizards for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- Live checklist. Registration is reported as registration: it is not
-- evidence that a connector has ever reached the client system.
create function public.onboarding_wizard_readiness(p_tenant_id uuid, p_wizard_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  w public.tenant_onboarding_wizards; t public.tenants; estate_status text;
  systems integer := 0; uncategorised integer := 0; unconnected integer := 0;
  registered integer := 0; read_grants integer := 0; write_grants integer := 0; manual integer := 0;
  checks jsonb;
begin
  select * into w from public.tenant_onboarding_wizards where tenant_id = p_tenant_id and id = p_wizard_id;
  if not found then return null; end if;
  select * into t from public.tenants where id = p_tenant_id;
  if w.estate_id is not null then
    select status into estate_status from public.estates where tenant_id = p_tenant_id and id = w.estate_id;
    select count(*),
           count(*) filter (where not exists (select 1 from public.system_data_categories d
             where d.tenant_id = s.tenant_id and d.system_id = s.id and d.source = 'declared')),
           count(*) filter (where not (s.id = any(w.manual_system_ids)) and not exists (
             select 1 from public.connectors c where c.tenant_id = s.tenant_id and c.system_id = s.id
               and c.status <> 'archived')),
           count(*) filter (where s.id = any(w.manual_system_ids))
      into systems, uncategorised, unconnected, manual
      from public.estate_systems s where s.tenant_id = p_tenant_id and s.estate_id = w.estate_id and s.status = 'active';
    select count(*) into registered from public.connectors c join public.estate_systems s
      on (s.tenant_id, s.id) = (c.tenant_id, c.system_id)
      where c.tenant_id = p_tenant_id and s.estate_id = w.estate_id and s.status = 'active' and c.status <> 'archived';
    select count(*) filter (where g.internal_scope = 'connector.read'),
           count(*) filter (where g.internal_scope = 'connector.write')
      into read_grants, write_grants
      from public.connector_grants g join public.connectors c on (c.tenant_id, c.id) = (g.tenant_id, g.connector_id)
      join public.estate_systems s on (s.tenant_id, s.id) = (c.tenant_id, c.system_id)
      where g.tenant_id = p_tenant_id and s.estate_id = w.estate_id and g.revoked_at is null and g.expires_at > now();
  end if;
  checks := jsonb_build_array(
    jsonb_build_object('key','company_profile','ok', 'company' = any(w.completed_steps)
      and t.dpo_name is not null and t.dpo_email is not null),
    jsonb_build_object('key','estate_active','ok', coalesce(estate_status = 'active', false)),
    jsonb_build_object('key','systems_declared','ok', systems > 0, 'count', systems),
    jsonb_build_object('key','data_categories_declared','ok', systems > 0 and uncategorised = 0, 'missing', uncategorised),
    jsonb_build_object('key','connection_path_recorded','ok', systems > 0 and unconnected = 0
      and 'connectors' = any(w.completed_steps), 'missing', unconnected),
    jsonb_build_object('key','grants_reviewed','ok', 'grants' = any(w.completed_steps)));
  return jsonb_build_object(
    'ready', not exists (select 1 from jsonb_array_elements(checks) c where (c->>'ok')::boolean is not true),
    'checks', checks,
    'counts', jsonb_build_object('systems', systems, 'registeredConnectors', registered,
      'manualSystems', manual, 'activeReadGrants', read_grants, 'activeWriteGrants', write_grants));
end $$;

create function public.start_onboarding_wizard(p_tenant_id uuid, p_actor_id uuid, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare w public.tenant_onboarding_wizards;
begin
  perform 1 from public.tenant_users where tenant_id = p_tenant_id and user_id = p_actor_id
    and role in ('founder','owner','admin') for share;
  if not found then return jsonb_build_object('error','forbidden'); end if;
  perform pg_advisory_xact_lock(hashtextextended('onboarding-wizard:' || p_tenant_id::text, 0));
  select * into w from public.tenant_onboarding_wizards where tenant_id = p_tenant_id and status = 'in_progress';
  if found then
    return jsonb_build_object('resource', to_jsonb(w), 'created', false,
      'readiness', public.onboarding_wizard_readiness(p_tenant_id, w.id));
  end if;
  insert into public.tenant_onboarding_wizards(tenant_id, started_by) values (p_tenant_id, p_actor_id) returning * into w;
  perform public.append_ledger(p_tenant_id, p_correlation_id, 'human', p_actor_id::text, null, null, null,
    'onboarding.wizard.started', w.id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('wizard_id', w.id));
  return jsonb_build_object('resource', to_jsonb(w), 'created', true,
    'readiness', public.onboarding_wizard_readiness(p_tenant_id, w.id));
end $$;

create function public.advance_onboarding_wizard(
  p_tenant_id uuid, p_actor_id uuid, p_wizard_id uuid, p_step text, p_expected_version integer,
  p_payload jsonb, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  steps constant text[] := array['company','estate','inventory','connectors','grants','readiness'];
  w public.tenant_onboarding_wizards; t public.tenants; e public.estates;
  next_step text; done text[]; manual uuid[]; checklist jsonb; summary jsonb; bad integer;
begin
  perform 1 from public.tenant_users where tenant_id = p_tenant_id and user_id = p_actor_id
    and role in ('founder','owner','admin') for share;
  if not found then return jsonb_build_object('error','forbidden'); end if;
  if p_step is null or not (p_step = any(steps)) or jsonb_typeof(p_payload) is distinct from 'object' then
    return jsonb_build_object('error','invalid_step');
  end if;
  select * into w from public.tenant_onboarding_wizards where tenant_id = p_tenant_id and id = p_wizard_id for update;
  if not found then return jsonb_build_object('error','not_found'); end if;
  if w.status <> 'in_progress' then return jsonb_build_object('error','wizard_completed'); end if;
  if w.version is distinct from p_expected_version then return jsonb_build_object('error','version_conflict'); end if;
  -- A completed step may be revisited; otherwise only the first incomplete step is open.
  select s into next_step from unnest(steps) with ordinality as x(s, n)
    where not (s = any(w.completed_steps)) order by n limit 1;
  if not (p_step = any(w.completed_steps)) and p_step is distinct from next_step then
    return jsonb_build_object('error','step_out_of_order', 'nextStep', next_step);
  end if;
  done := w.completed_steps; manual := w.manual_system_ids;

  if p_step = 'company' then
    if jsonb_typeof(p_payload->'isSdf') is distinct from 'boolean'
       or jsonb_typeof(p_payload->'processesChildrenData') is distinct from 'boolean'
       or jsonb_typeof(p_payload->'processesHealthData') is distinct from 'boolean'
       or char_length(btrim(coalesce(p_payload->>'dpoName',''))) not between 1 and 200
       or lower(btrim(coalesce(p_payload->>'dpoEmail',''))) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
       or char_length(btrim(p_payload->>'dpoEmail')) > 320 then
      return jsonb_build_object('error','invalid_payload');
    end if;
    select * into t from public.tenants where id = p_tenant_id for update;
    update public.tenants set is_sdf = (p_payload->>'isSdf')::boolean,
      processes_children_data = (p_payload->>'processesChildrenData')::boolean,
      processes_health_data = (p_payload->>'processesHealthData')::boolean,
      dpo_name = btrim(p_payload->>'dpoName'), dpo_email = lower(btrim(p_payload->>'dpoEmail')),
      updated_at = now() where id = p_tenant_id;
    summary := jsonb_build_object('before', jsonb_build_object('is_sdf', t.is_sdf,
        'processes_children_data', t.processes_children_data, 'processes_health_data', t.processes_health_data,
        'dpo_set', t.dpo_name is not null),
      'after', jsonb_build_object('is_sdf', (p_payload->>'isSdf')::boolean,
        'processes_children_data', (p_payload->>'processesChildrenData')::boolean,
        'processes_health_data', (p_payload->>'processesHealthData')::boolean, 'dpo_set', true));
  elsif p_step = 'estate' then
    if coalesce(p_payload->>'estateId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return jsonb_build_object('error','invalid_payload');
    end if;
    select * into e from public.estates where tenant_id = p_tenant_id and id = (p_payload->>'estateId')::uuid for share;
    if not found then return jsonb_build_object('error','not_found'); end if;
    if e.status <> 'active' then return jsonb_build_object('error','estate_archived'); end if;
    -- Choosing another estate invalidates everything recorded about the old one.
    if w.estate_id is distinct from e.id then
      done := array(select s from unnest(done) s where s in ('company'));
      manual := '{}';
    end if;
    update public.tenant_onboarding_wizards set estate_id = e.id where id = w.id;
    summary := jsonb_build_object('estate_id', e.id, 'previous_estate_id', w.estate_id);
  elsif p_step = 'inventory' then
    checklist := public.onboarding_wizard_readiness(p_tenant_id, w.id);
    if not exists (select 1 from jsonb_array_elements(checklist->'checks') c
        where c->>'key' = 'systems_declared' and (c->>'ok')::boolean)
       or not exists (select 1 from jsonb_array_elements(checklist->'checks') c
        where c->>'key' = 'data_categories_declared' and (c->>'ok')::boolean) then
      return jsonb_build_object('error','inventory_incomplete', 'readiness', checklist);
    end if;
    summary := jsonb_build_object('systems', checklist->'counts'->'systems');
  elsif p_step = 'connectors' then
    if jsonb_typeof(p_payload->'manualSystemIds') is distinct from 'array'
       or exists (select 1 from jsonb_array_elements(p_payload->'manualSystemIds') v
         where jsonb_typeof(v) <> 'string'
           or v#>>'{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      return jsonb_build_object('error','invalid_payload');
    end if;
    manual := array(select distinct (v#>>'{}')::uuid from jsonb_array_elements(p_payload->'manualSystemIds') v);
    select count(*) into bad from unnest(manual) m where not exists (select 1 from public.estate_systems s
      where s.tenant_id = p_tenant_id and s.id = m and s.estate_id = w.estate_id and s.status = 'active');
    if bad > 0 then return jsonb_build_object('error','not_found'); end if;
    update public.tenant_onboarding_wizards set manual_system_ids = manual where id = w.id;
    -- Checked against the live registrations, with the new declaration applied.
    select count(*) into bad from public.estate_systems s where s.tenant_id = p_tenant_id
      and s.estate_id = w.estate_id and s.status = 'active' and not (s.id = any(manual))
      and not exists (select 1 from public.connectors c where c.tenant_id = s.tenant_id and c.system_id = s.id
        and c.status <> 'archived');
    if bad > 0 then
      return jsonb_build_object('error','connection_path_missing', 'missing', bad);
    end if;
    summary := jsonb_build_object('manual_system_ids', to_jsonb(manual));
  elsif p_step = 'grants' then
    if p_payload->>'acknowledged' is distinct from 'true' then
      return jsonb_build_object('error','confirmation_required');
    end if;
    checklist := public.onboarding_wizard_readiness(p_tenant_id, w.id);
    -- The wizard issues no grants; it records what the reviewer saw.
    summary := jsonb_build_object('active_read_grants', checklist->'counts'->'activeReadGrants',
      'active_write_grants', checklist->'counts'->'activeWriteGrants');
  else
    if p_payload->>'confirmed' is distinct from 'true' then
      return jsonb_build_object('error','confirmation_required');
    end if;
  end if;

  if not (p_step = any(done)) then
    done := array(select s from unnest(steps) with ordinality as x(s, n) where s = any(done) or s = p_step order by n);
  end if;
  update public.tenant_onboarding_wizards set completed_steps = done, manual_system_ids = manual,
    version = version + 1, updated_at = now() where id = w.id returning * into w;

  if p_step = 'readiness' then
    checklist := public.onboarding_wizard_readiness(p_tenant_id, w.id);
    if (checklist->>'ready')::boolean is not true then
      -- Raising discards the step update above; the error is the only outcome.
      raise exception using errcode = 'P0001', message = 'not_ready', detail = checklist::text;
    end if;
    update public.tenant_onboarding_wizards set status = 'completed', completed_by = p_actor_id,
      completed_at = now(), readiness = checklist where id = w.id returning * into w;
    perform public.append_ledger(p_tenant_id, p_correlation_id, 'human', p_actor_id::text, null, null, null,
      'onboarding.wizard.completed', w.id::text, null, null, null, null, null, null, 'success',
      jsonb_build_object('wizard_id', w.id, 'estate_id', w.estate_id, 'readiness', checklist));
  else
    perform public.append_ledger(p_tenant_id, p_correlation_id, 'human', p_actor_id::text, null, null, null,
      'onboarding.wizard.step_completed', w.id::text, null, null, null, null, null, null, 'success',
      jsonb_build_object('wizard_id', w.id, 'step', p_step, 'summary', summary));
  end if;
  return jsonb_build_object('resource', to_jsonb(w), 'readiness', public.onboarding_wizard_readiness(p_tenant_id, w.id));
exception
  when sqlstate 'P0001' then
    if sqlerrm = 'not_ready' then
      return jsonb_build_object('error','not_ready', 'readiness', public.onboarding_wizard_readiness(p_tenant_id, p_wizard_id));
    end if;
    raise;
end $$;

revoke all on function public.onboarding_wizard_readiness(uuid,uuid) from public, anon, authenticated;
revoke all on function public.start_onboarding_wizard(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.advance_onboarding_wizard(uuid,uuid,uuid,text,integer,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.onboarding_wizard_readiness(uuid,uuid) to service_role;
grant execute on function public.start_onboarding_wizard(uuid,uuid,uuid) to service_role;
grant execute on function public.advance_onboarding_wizard(uuid,uuid,uuid,text,integer,jsonb,uuid) to service_role;
