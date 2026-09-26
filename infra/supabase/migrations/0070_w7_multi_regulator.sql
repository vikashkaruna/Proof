-- ─────────────────────────────────────────────────────────────────────
-- 0070_w7_multi_regulator.sql
--
-- W7.3/W7.4 · Multi-regulator control reuse and sector packs (M4.2/M4.8):
-- the four tables Doc 11 (W2) lists as missing:
--
--   frameworks         the regulator-side overlay catalogue (M4.2):
--                      RBI, SEBI, IRDAI, CERT-In — the regulators the
--                      docs name for multi-regulator reuse.
--   framework_controls addressable units inside a framework (a Master
--                      Direction paragraph, a guideline clause), the
--                      counterpart of regulatory_provisions (W7.0).
--   control_mappings   the DPDPA control <- framework control link,
--                      with an explicit mapping_strength so an
--                      indicative mapping can never pass as an
--                      equivalent one.
--   sector_packs       pack = control subset + overlay frameworks +
--                      sector-specific evidence requirements +
--                      remediation patterns (M4.8). Pack #1 is BFSI.
--
-- One evidence artifact satisfies N controls across M frameworks:
-- an assessment seals evidence against a DPDPA control once, and the
-- coverage map joins through control_mappings to every framework that
-- control partially or fully addresses.
--
-- These are GLOBAL catalogue tables, not tenant data — the same shape
-- as the W7.0 regulatory baseline (0011): every authenticated user can
-- read the rulebook their report is computed against; writes go only
-- through SECURITY DEFINER publication paths granted to the service
-- role. Publication rows are append-only: there is no UPDATE or DELETE
-- grant on any of these tables, to any role — a correction is a new
-- publication, never a silent edit of the rulebook.
--
-- No audit_ledger rows are written here. The ledger is strictly
-- tenant-scoped (audit_ledger.tenant_id is not null), and catalogue
-- publication is a platform event — the same reason the control
-- library itself publishes without ledger rows. Provenance lives on
-- the rows: published_by, verified_on, verified_by.
-- ─────────────────────────────────────────────────────────────────────

-- ─── The regulator-side overlay catalogue (M4.2) ─────────────────────
create table public.frameworks (
  id uuid primary key default gen_random_uuid(),
  -- Stable short code, e.g. 'RBI-MD-ITG', 'CERT-IN-2022-DIRECTIONS'.
  code text not null unique
    check (code ~ '^[A-Z0-9][A-Z0-9._-]{2,63}$'),
  jurisdiction text not null default 'IN',
  -- The overlay regulators the docs name for multi-regulator reuse
  -- (M4.2). A new regulator is a new migration altering this check,
  -- not a free-text value smuggled past review.
  regulator text not null check (regulator in ('RBI', 'SEBI', 'IRDAI', 'CERT-In')),
  title text not null check (length(title) between 1 and 300),
  description text not null default '' check (length(description) <= 4000),
  source_url text not null check (length(source_url) between 1 and 500),
  -- Provenance of the RECORD (0011 pattern): who last checked this
  -- row against the regulator's own publication, and when. An
  -- unverified framework row is visible as such.
  verified_on date not null,
  verified_by text not null,
  published_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

comment on table public.frameworks is
  'Regulator-side overlay catalogue (M4.2): the non-DPDPA frameworks whose requirements map onto the DPDPA control set (W7.3).';

-- ─── Addressable units inside a framework ────────────────────────────
create table public.framework_controls (
  id uuid primary key default gen_random_uuid(),
  framework_id uuid not null references public.frameworks(id) on delete restrict,
  -- 'Chapter 3 · Para 12', 'Annex I · 4.2' — exactly as the framework
  -- prints it, the counterpart of regulatory_provisions.provision_ref.
  ref text not null check (length(ref) between 1 and 300),
  heading text not null check (length(heading) between 1 and 500),
  text_sha256 text,
  created_at timestamptz not null default now(),
  unique (framework_id, ref)
);

create index framework_controls_framework_idx
  on public.framework_controls (framework_id);

comment on table public.framework_controls is
  'Addressable requirement units within a regulatory framework (W7.3).';

-- ─── The DPDPA control <- framework control link (M4.2) ──────────────
create table public.control_mappings (
  id uuid primary key default gen_random_uuid(),
  control_id text not null,
  library_version text not null references public.control_libraries(version) on delete cascade,
  framework_control_id uuid not null references public.framework_controls(id) on delete restrict,
  -- M4.2: an explicit strength, with indicative mappings labelled as
  -- such. 'equivalent' asserts the two requirements test the same
  -- thing; 'partial' asserts overlap; 'indicative' asserts the
  -- mapping is a starting point for a human reviewer, not a claim.
  mapping_strength text not null
    check (mapping_strength in ('equivalent', 'partial', 'indicative')),
  -- Honest provenance: 'reference' = derived from the regulator's
  -- public text; 'mapped' = checked against a client engagement's
  -- controls in place. 'vendor-verified' is deliberately absent from
  -- this constraint: it requires client tenants, and nothing in the
  -- platform can honestly assert it yet.
  provenance text not null default 'reference'
    check (provenance in ('reference', 'mapped')),
  -- Why this mapping exists — the basis is mandatory, because an
  -- unexplained cross-walk is how CTL-1-class drift hides.
  note text not null check (length(note) between 1 and 2000),
  recorded_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (control_id, library_version)
    references public.controls(id, library_version) on delete cascade,
  unique (control_id, library_version, framework_control_id)
);

create index control_mappings_control_idx
  on public.control_mappings (library_version, control_id);
create index control_mappings_framework_control_idx
  on public.control_mappings (framework_control_id);

comment on table public.control_mappings is
  'Maps each DPDPA control onto framework_controls in other regulators'' frameworks, with an explicit, honest mapping_strength (M4.2, W7.3).';

-- ─── Sector packs (M4.8) ─────────────────────────────────────────────
create table public.sector_packs (
  id uuid primary key default gen_random_uuid(),
  -- Stable pack code, e.g. 'BFSI-1'; a superseding pack publishes a
  -- new code rather than editing this row.
  code text not null unique
    check (code ~ '^[A-Z0-9][A-Z0-9._-]{2,63}$'),
  name text not null check (length(name) between 1 and 200),
  -- The pack sectors the plan names: M4.8 offers Healthcare or BFSI
  -- as pack #1; the operator decision (2026-09-26) orders BFSI first,
  -- then Healthcare, then Tech/E-commerce.
  sector text not null check (sector in ('BFSI', 'Healthcare', 'Tech/E-commerce')),
  description text not null default '' check (length(description) <= 4000),
  -- The library version the control subset is drawn from. Engagements
  -- pin a library version; a pack pins one too, so a control id in
  -- the subset always resolves to a published control row.
  library_version text not null references public.control_libraries(version) on delete restrict,
  -- The control subset, every id validated against controls for the
  -- pinned library version at publication time.
  control_ids text[] not null default '{}',
  -- The overlay frameworks the pack draws mappings from (M4.8:
  -- "overlay mappings"); at least one, resolved against frameworks.code.
  framework_codes text[] not null default '{}',
  -- Sector-specific evidence requirements and remediation patterns
  -- (M4.8), bounded like every free-form payload the BFF stores.
  evidence_requirements jsonb not null default '[]'
    check (jsonb_typeof(evidence_requirements) = 'array'
      and octet_length(evidence_requirements::text) <= 16384),
  remediation_patterns jsonb not null default '[]'
    check (jsonb_typeof(remediation_patterns) = 'array'
      and octet_length(remediation_patterns::text) <= 16384),
  content_sha256 text,
  published_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index sector_packs_sector_idx on public.sector_packs (sector);

comment on table public.sector_packs is
  'A sector pack: a DPDPA control subset plus overlay frameworks plus sector-specific evidence requirements and remediation patterns (M4.8, W7.4).';

-- ─── RLS and the privilege wall ──────────────────────────────────────
-- Catalogue tables: readable by every authenticated user and the BFF
-- service; writable by nobody through the tables themselves. The
-- SECURITY DEFINER publication functions below are the only write
-- path, granted to service_role only.
alter table public.frameworks enable row level security;
alter table public.framework_controls enable row level security;
alter table public.control_mappings enable row level security;
alter table public.sector_packs enable row level security;

revoke all on public.frameworks from public, anon, authenticated, service_role;
revoke all on public.framework_controls from public, anon, authenticated, service_role;
revoke all on public.control_mappings from public, anon, authenticated, service_role;
revoke all on public.sector_packs from public, anon, authenticated, service_role;

grant select on public.frameworks to service_role, authenticated;
grant select on public.framework_controls to service_role, authenticated;
grant select on public.control_mappings to service_role, authenticated;
grant select on public.sector_packs to service_role, authenticated;

create policy bff_service_read on public.frameworks
  for select to service_role using (true);
create policy catalogue_read on public.frameworks
  for select to authenticated using (true);
create policy bff_service_read on public.framework_controls
  for select to service_role using (true);
create policy catalogue_read on public.framework_controls
  for select to authenticated using (true);
create policy bff_service_read on public.control_mappings
  for select to service_role using (true);
create policy catalogue_read on public.control_mappings
  for select to authenticated using (true);
create policy bff_service_read on public.sector_packs
  for select to service_role using (true);
create policy catalogue_read on public.sector_packs
  for select to authenticated using (true);

-- ─────────────────────────────────────────────────────────────────────
-- publish_regulatory_framework — the librarian's write path for a
-- framework and its addressable controls, atomic. Shape rules live in
-- both the column checks and here, because a refused publication
-- returns a reason instead of an opaque constraint violation.
-- ─────────────────────────────────────────────────────────────────────
create function public.publish_regulatory_framework(
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
     or p_regulator not in ('RBI', 'SEBI', 'IRDAI', 'CERT-In')
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

  -- Every declared control must be shaped; a framework with an
  -- unaddressable requirement is worse than no framework.
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
    -- Two racing publications of the same code: the loser reports a
    -- reason instead of a constraint error.
    return jsonb_build_object('error', 'already_published');
end $$;
revoke all on function public.publish_regulatory_framework(text,text,text,text,text,date,text,uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.publish_regulatory_framework(text,text,text,text,text,date,text,uuid,jsonb)
  to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- record_control_mapping — records one DPDPA control <- framework
-- control cross-walk. Append-only: a duplicate (control, version,
-- framework control) triple is refused, not upserted.
-- ─────────────────────────────────────────────────────────────────────
create function public.record_control_mapping(
  p_framework_code text,
  p_framework_ref text,
  p_control_id text,
  p_library_version text,
  p_strength text,
  p_provenance text,
  p_note text,
  p_recorded_by uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_framework_control_id uuid;
  v_mapping public.control_mappings;
begin
  if p_strength not in ('equivalent', 'partial', 'indicative')
     or p_provenance not in ('reference', 'mapped')
     -- M4.2: an equivalence claim is a verified claim. A mapping derived
     -- from the regulator's public text alone ('reference') may be
     -- partial or indicative, never equivalent.
     or (p_strength = 'equivalent' and p_provenance = 'reference')
     or p_note is null or length(p_note) not between 1 and 2000
     or p_control_id is null or p_control_id !~ '^DPDPA-[A-Z]+-[0-9]{3}$'
     or p_library_version is null
     or p_framework_ref is null or length(p_framework_ref) not between 1 and 300 then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if not exists (select 1 from public.users where id = p_recorded_by) then
    return jsonb_build_object('error', 'recorder_not_found');
  end if;
  if not exists (select 1 from public.control_libraries where version = p_library_version) then
    return jsonb_build_object('error', 'library_version_not_found');
  end if;
  select fc.id into v_framework_control_id
    from public.framework_controls fc
    join public.frameworks f on f.id = fc.framework_id
   where f.code = p_framework_code and fc.ref = p_framework_ref;
  if v_framework_control_id is null then
    return jsonb_build_object('error', 'framework_control_not_found');
  end if;
  if not exists (
    select 1 from public.controls
     where id = p_control_id and library_version = p_library_version
  ) then
    return jsonb_build_object('error', 'control_not_found');
  end if;

  insert into public.control_mappings(control_id, library_version, framework_control_id,
    mapping_strength, provenance, note, recorded_by)
  values (p_control_id, p_library_version, v_framework_control_id,
    p_strength, p_provenance, p_note, p_recorded_by)
  returning * into v_mapping;

  return jsonb_build_object('mapping', jsonb_build_object(
    'id', v_mapping.id, 'controlId', v_mapping.control_id,
    'libraryVersion', v_mapping.library_version,
    'frameworkControlId', v_mapping.framework_control_id,
    'strength', v_mapping.mapping_strength,
    'provenance', v_mapping.provenance,
    'createdAt', v_mapping.created_at));
exception
  when unique_violation then
    -- Append-only: the same cross-walk is refused, not upserted.
    return jsonb_build_object('error', 'already_mapped');
end $$;
revoke all on function public.record_control_mapping(text,text,text,text,text,text,text,uuid)
  from public, anon, authenticated;
grant execute on function public.record_control_mapping(text,text,text,text,text,text,text,uuid)
  to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- publish_sector_pack — publishes a pack (M4.8): control subset +
-- overlay frameworks + sector evidence requirements + remediation
-- patterns, with every reference resolved before the row lands.
-- ─────────────────────────────────────────────────────────────────────
create function public.publish_sector_pack(
  p_code text,
  p_name text,
  p_sector text,
  p_description text,
  p_library_version text,
  p_control_ids text[],
  p_framework_codes text[],
  p_evidence_requirements jsonb,
  p_remediation_patterns jsonb,
  p_content_sha256 text,
  p_published_by uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_pack public.sector_packs;
  v_control_id text;
  v_framework_code text;
begin
  if p_code is null or p_code !~ '^[A-Z0-9][A-Z0-9._-]{2,63}$'
     or p_name is null or length(p_name) not between 1 and 200
     or p_sector not in ('BFSI', 'Healthcare', 'Tech/E-commerce')
     or p_description is null or length(p_description) > 4000
     or p_library_version is null
     or p_control_ids is null or cardinality(p_control_ids) not between 1 and 256
     or p_framework_codes is null or cardinality(p_framework_codes) not between 1 and 16
     or p_evidence_requirements is null
        or jsonb_typeof(p_evidence_requirements) <> 'array'
        or octet_length(p_evidence_requirements::text) > 16384
     or p_remediation_patterns is null
        or jsonb_typeof(p_remediation_patterns) <> 'array'
        or octet_length(p_remediation_patterns::text) > 16384
     or p_content_sha256 is not null and p_content_sha256 !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if exists (select 1 from public.sector_packs where code = p_code) then
    return jsonb_build_object('error', 'already_published');
  end if;
  if not exists (select 1 from public.users where id = p_published_by) then
    return jsonb_build_object('error', 'publisher_not_found');
  end if;
  if not exists (select 1 from public.control_libraries where version = p_library_version) then
    return jsonb_build_object('error', 'library_version_not_found');
  end if;
  -- Every control id must be a shaped DPDPA control id that exists in
  -- the pinned library version — a pack naming a phantom control is a
  -- coverage map that lies.
  foreach v_control_id in array p_control_ids loop
    if v_control_id !~ '^DPDPA-[A-Z]+-[0-9]{3}$' then
      return jsonb_build_object('error', 'invalid_request');
    end if;
    if not exists (
      select 1 from public.controls
       where id = v_control_id and library_version = p_library_version
    ) then
      return jsonb_build_object('error', 'control_not_found');
    end if;
  end loop;
  -- cardinality bounds proven above; 256 x (exists lookup) is bounded work.
  if (select count(distinct unnest) from unnest(p_control_ids)) <> cardinality(p_control_ids) then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  foreach v_framework_code in array p_framework_codes loop
    if not exists (select 1 from public.frameworks where code = v_framework_code) then
      return jsonb_build_object('error', 'framework_not_found');
    end if;
  end loop;

  insert into public.sector_packs(code, name, sector, description, library_version,
    control_ids, framework_codes, evidence_requirements, remediation_patterns,
    content_sha256, published_by)
  values (p_code, p_name, p_sector, p_description, p_library_version,
    p_control_ids, p_framework_codes, p_evidence_requirements,
    p_remediation_patterns, p_content_sha256, p_published_by)
  returning * into v_pack;

  return jsonb_build_object('pack', jsonb_build_object(
    'id', v_pack.id, 'code', v_pack.code, 'name', v_pack.name,
    'sector', v_pack.sector, 'libraryVersion', v_pack.library_version,
    'controlsCount', cardinality(v_pack.control_ids),
    'frameworks', v_pack.framework_codes,
    'createdAt', v_pack.created_at));
exception
  when unique_violation then
    return jsonb_build_object('error', 'already_published');
end $$;
revoke all on function
  public.publish_sector_pack(text,text,text,text,text,text[],text[],jsonb,jsonb,text,uuid)
  from public, anon, authenticated;
grant execute on function
  public.publish_sector_pack(text,text,text,text,text,text[],text[],jsonb,jsonb,text,uuid)
  to service_role;
