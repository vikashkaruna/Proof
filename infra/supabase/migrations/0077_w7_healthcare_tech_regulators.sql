-- ─────────────────────────────────────────────────────────────────────
-- 0077_w7_healthcare_tech_regulators.sql
--
-- W7.3/W7.4 · Healthcare & Tech/E-commerce Sector Packs & Overlay Regulators
--
-- Extends public.frameworks regulator check constraint to include:
--   - NHA (National Health Authority · ABDM Health Data Management Policy)
--   - MoHFW (Ministry of Health and Family Welfare · EHR Standards)
--   - MeitY (Ministry of Electronics and Information Technology · Intermediary / SPDI Rules)
--   - CCPA (Central Consumer Protection Authority · E-Commerce Rules)
--
-- Updates publish_regulatory_framework function to accept the expanded regulator set.
-- ─────────────────────────────────────────────────────────────────────

-- 1. Alter public.frameworks constraint
alter table public.frameworks
  drop constraint if exists frameworks_regulator_check;

alter table public.frameworks
  add constraint frameworks_regulator_check
  check (regulator in ('RBI', 'SEBI', 'IRDAI', 'CERT-In', 'NHA', 'MoHFW', 'MeitY', 'CCPA'));

-- 2. Update publish_regulatory_framework function
create or replace function public.publish_regulatory_framework(
  p_code text,
  p_regulator text,
  p_title text,
  p_description text,
  p_source_url text,
  p_verified_on date,
  p_verified_by text,
  p_published_by uuid,
  p_controls jsonb
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_framework public.frameworks;
  v_item jsonb;
  v_ref text;
  v_heading text;
  v_count integer;
begin
  if p_code is null or p_code !~ '^[A-Z0-9][A-Z0-9._-]{2,63}$'
     or p_regulator not in ('RBI', 'SEBI', 'IRDAI', 'CERT-In', 'NHA', 'MoHFW', 'MeitY', 'CCPA')
     or p_title is null or length(p_title) not between 1 and 300
     or p_description is null or length(p_description) > 4000
     or p_source_url is null or length(p_source_url) not between 1 and 500
     or p_verified_on is null
     or p_verified_by is null or length(p_verified_by) not between 1 and 200
     or p_controls is null or jsonb_typeof(p_controls) <> 'array'
     or jsonb_array_length(p_controls) not between 1 and 64 then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if exists (select 1 from public.frameworks where code = p_code) then
    return jsonb_build_object('error', 'already_published');
  end if;
  if not exists (select 1 from public.users where id = p_published_by) then
    return jsonb_build_object('error', 'publisher_not_found');
  end if;

  for v_item in select * from jsonb_array_elements(p_controls) loop
    v_ref := v_item ->> 'ref';
    v_heading := v_item ->> 'heading';
    if v_ref is null or length(v_ref) not between 1 and 300
       or v_heading is null or length(v_heading) not between 1 and 500 then
      return jsonb_build_object('error', 'invalid_request');
    end if;
  end loop;

  insert into public.frameworks(code, regulator, title, description, source_url,
    verified_on, verified_by, published_by)
  values (p_code, p_regulator, p_title, p_description, p_source_url,
    p_verified_on, p_verified_by, p_published_by)
  returning * into v_framework;

  insert into public.framework_controls(framework_id, ref, heading)
  select v_framework.id, e ->> 'ref', e ->> 'heading'
  from jsonb_array_elements(p_controls) as e;
  get diagnostics v_count = row_count;

  return jsonb_build_object('framework', jsonb_build_object(
    'id', v_framework.id, 'code', v_framework.code,
    'regulator', v_framework.regulator, 'title', v_framework.title,
    'controlsCount', v_count, 'createdAt', v_framework.created_at));
exception
  when unique_violation then
    return jsonb_build_object('error', 'already_published');
end $$;

revoke all on function public.publish_regulatory_framework(text,text,text,text,text,date,text,uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.publish_regulatory_framework(text,text,text,text,text,date,text,uuid,jsonb)
  to service_role;
