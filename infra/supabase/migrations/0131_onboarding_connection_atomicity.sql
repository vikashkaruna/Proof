-- Rejected connection declarations must leave the complete wizard row unchanged.
-- CREATE OR REPLACE retains the existing owner and reviewed human-writer grants.
-- Successful declarations are persisted by the existing final versioned, audited update.
create or replace function public.advance_onboarding_wizard(
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
    -- Validate the proposed declaration against live registrations before persisting it.
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
