-- ─────────────────────────────────────────────────────────────────────
-- 0076_w2_parity_tables.sql
--
-- Revision 103 · Phase 1/2 Parity Tables (W2 40/40 Complete):
--   1. ropa_records: Records of Processing Activities (DPDPA Section 8 / GDPR Art 30)
--   2. policy_drafts: Compliance policy documents, versions, and founder review gate
--   3. playbook_entries: Incident response, DSAR and continuous monitoring playbooks
--   4. classification_reviews: Human-reviewed data classification and sensitivity adjustments
--
-- All tables enforce tenant isolation, composite unique keys, RLS, and immutable audit logging.
-- ─────────────────────────────────────────────────────────────────────

alter type public.ledger_action_type add value if not exists 'ropa.recorded';
alter type public.ledger_action_type add value if not exists 'policy.drafted';
alter type public.ledger_action_type add value if not exists 'policy.reviewed';
alter type public.ledger_action_type add value if not exists 'playbook.created';
alter type public.ledger_action_type add value if not exists 'classification.reviewed';

-- ─── 1. ROPA RECORDS ─────────────────────────────────────────────────
create table public.ropa_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  estate_id uuid references public.estates(id) on delete restrict,
  engagement_id uuid references public.engagements(id) on delete restrict,
  purpose_name text not null check (length(btrim(purpose_name)) between 1 and 200),
  legal_basis text not null check (legal_basis in ('consent', 'statutory', 'contract', 'legitimate_interest', 'employment', 'vital_interest')),
  data_categories text[] not null check (cardinality(data_categories) >= 1 and cardinality(data_categories) <= 50),
  data_principals text[] not null check (cardinality(data_principals) >= 1 and cardinality(data_principals) <= 20),
  recipients text[] not null default '{}' check (cardinality(recipients) <= 50),
  cross_border_transfers boolean not null default false,
  destination_countries text[] not null default '{}' check (cardinality(destination_countries) <= 50),
  retention_period_months integer not null check (retention_period_months >= 1 and retention_period_months <= 1200),
  security_measures text not null check (length(btrim(security_measures)) between 1 and 2000),
  dpia_required boolean not null default false,
  status text not null default 'active' check (status in ('draft', 'active', 'archived', 'deprecated')),
  version integer not null default 1 check (version >= 1),
  created_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, id),
  foreign key (tenant_id, estate_id) references public.estates(tenant_id, id) on delete restrict,
  foreign key (tenant_id, engagement_id) references public.engagements(tenant_id, id) on delete restrict
);

-- ─── 2. POLICY DRAFTS ────────────────────────────────────────────────
create table public.policy_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  title text not null check (length(btrim(title)) between 1 and 300),
  category text not null check (category in ('data_protection', 'retention', 'breach_response', 'access_control', 'vendor_management', 'acceptable_use', 'privacy_notice')),
  summary text not null check (length(btrim(summary)) between 1 and 2000),
  content text not null check (octet_length(content) between 1 and 5242880),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  version integer not null default 1 check (version >= 1),
  status text not null default 'draft' check (status in ('draft', 'under_review', 'approved', 'published', 'deprecated')),
  control_citations text[] not null default '{}' check (cardinality(control_citations) <= 50),
  created_by uuid not null references public.users(id) on delete restrict,
  reviewed_by uuid references public.users(id) on delete restrict,
  reviewed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, id),
  check ((status in ('draft', 'under_review') and reviewed_at is null and reviewed_by is null) or (status in ('approved', 'published', 'deprecated') and reviewed_at is not null and reviewed_by is not null))
);

-- ─── 3. PLAYBOOK ENTRIES ──────────────────────────────────────────────
create table public.playbook_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  title text not null check (length(btrim(title)) between 1 and 300),
  kind text not null check (kind in ('incident_response', 'dsar_fulfillment', 'breach_notification', 'vendor_audit', 'consent_revocation', 'continuous_monitoring')),
  trigger_condition text not null check (length(btrim(trigger_condition)) between 1 and 1000),
  target_agent text not null check (target_agent in ('drishti', 'vibhaag', 'parikshan', 'saakshi', 'sudhaar', 'karya', 'lekha', 'nazar', 'prativedan', 'sanket')),
  steps jsonb not null check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 50),
  requires_human_approval boolean not null default true,
  version integer not null default 1 check (version >= 1),
  status text not null default 'active' check (status in ('draft', 'active', 'disabled', 'deprecated')),
  created_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, id)
);

-- ─── 4. CLASSIFICATION REVIEWS ────────────────────────────────────────
create table public.classification_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  estate_id uuid references public.estates(id) on delete restrict,
  system_id text not null check (length(btrim(system_id)) between 1 and 200),
  resource_path text not null check (length(btrim(resource_path)) between 1 and 1000),
  sensitivity_level text not null check (sensitivity_level in ('public', 'internal', 'confidential', 'restricted', 'critical_pii')),
  detected_categories text[] not null check (cardinality(detected_categories) >= 1 and cardinality(detected_categories) <= 50),
  confidence_score numeric(5,2) not null check (confidence_score >= 0 and confidence_score <= 100),
  reviewed_by uuid not null references public.users(id) on delete restrict,
  decision text not null check (decision in ('confirmed', 'adjusted', 'overridden', 'dismissed')),
  adjusted_sensitivity text check (adjusted_sensitivity in ('public', 'internal', 'confidential', 'restricted', 'critical_pii')),
  justification text not null check (length(btrim(justification)) between 1 and 2000),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, id),
  foreign key (tenant_id, estate_id) references public.estates(tenant_id, id) on delete restrict,
  check ((decision in ('adjusted', 'overridden') and adjusted_sensitivity is not null) or (decision in ('confirmed', 'dismissed') and adjusted_sensitivity is null))
);

-- ─── ROW LEVEL SECURITY ───────────────────────────────────────────────
alter table public.ropa_records enable row level security;
alter table public.policy_drafts enable row level security;
alter table public.playbook_entries enable row level security;
alter table public.classification_reviews enable row level security;

revoke all on public.ropa_records from public, anon, authenticated, service_role;
revoke all on public.policy_drafts from public, anon, authenticated, service_role;
revoke all on public.playbook_entries from public, anon, authenticated, service_role;
revoke all on public.classification_reviews from public, anon, authenticated, service_role;

grant select on public.ropa_records to service_role, authenticated;
grant select on public.policy_drafts to service_role, authenticated;
grant select on public.playbook_entries to service_role, authenticated;
grant select on public.classification_reviews to service_role, authenticated;

create policy ropa_records_tenant_read on public.ropa_records
  for select to authenticated
  using (
    tenant_id in (select tenant_id from public.tenant_users where user_id = auth.uid())
    or exists (select 1 from public.users where id = auth.uid() and is_axiom_internal)
  );

create policy ropa_records_service_read on public.ropa_records
  for select to service_role using (true);

create policy policy_drafts_tenant_read on public.policy_drafts
  for select to authenticated
  using (
    tenant_id in (select tenant_id from public.tenant_users where user_id = auth.uid())
    or exists (select 1 from public.users where id = auth.uid() and is_axiom_internal)
  );

create policy policy_drafts_service_read on public.policy_drafts
  for select to service_role using (true);

create policy playbook_entries_tenant_read on public.playbook_entries
  for select to authenticated
  using (
    tenant_id in (select tenant_id from public.tenant_users where user_id = auth.uid())
    or exists (select 1 from public.users where id = auth.uid() and is_axiom_internal)
  );

create policy playbook_entries_service_read on public.playbook_entries
  for select to service_role using (true);

create policy classification_reviews_tenant_read on public.classification_reviews
  for select to authenticated
  using (
    tenant_id in (select tenant_id from public.tenant_users where user_id = auth.uid())
    or exists (select 1 from public.users where id = auth.uid() and is_axiom_internal)
  );

create policy classification_reviews_service_read on public.classification_reviews
  for select to service_role using (true);

-- ─── STORED PROCEDURES ───────────────────────────────────────────────

-- Create ROPA Record
create function public.create_ropa_record(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_estate_id uuid,
  p_engagement_id uuid,
  p_purpose_name text,
  p_legal_basis text,
  p_data_categories text[],
  p_data_principals text[],
  p_recipients text[],
  p_cross_border boolean,
  p_destination_countries text[],
  p_retention_months integer,
  p_security_measures text,
  p_dpia_required boolean,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_role text;
  v_rec public.ropa_records;
begin
  select role into v_role from public.tenant_users where tenant_id = p_tenant_id and user_id = p_actor_id;
  if v_role not in ('owner', 'admin', 'founder') and not exists (select 1 from public.users where id = p_actor_id and is_axiom_internal) then
    return jsonb_build_object('error', 'forbidden');
  end if;

  if p_purpose_name is null or length(btrim(p_purpose_name)) not between 1 and 200
     or p_legal_basis is null or p_legal_basis not in ('consent', 'statutory', 'contract', 'legitimate_interest', 'employment', 'vital_interest')
     or p_data_categories is null or cardinality(p_data_categories) not between 1 and 50
     or p_data_principals is null or cardinality(p_data_principals) not between 1 and 20
     or p_retention_months is null or p_retention_months not between 1 and 1200
     or p_security_measures is null or length(btrim(p_security_measures)) not between 1 and 2000
     or p_correlation_id is null then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  if p_estate_id is not null and not exists (select 1 from public.estates where tenant_id = p_tenant_id and id = p_estate_id) then
    return jsonb_build_object('error', 'estate_not_found');
  end if;

  if p_engagement_id is not null and not exists (select 1 from public.engagements where tenant_id = p_tenant_id and id = p_engagement_id) then
    return jsonb_build_object('error', 'engagement_not_found');
  end if;

  insert into public.ropa_records (
    tenant_id, estate_id, engagement_id, purpose_name, legal_basis,
    data_categories, data_principals, recipients, cross_border_transfers,
    destination_countries, retention_period_months, security_measures,
    dpia_required, created_by
  ) values (
    p_tenant_id, p_estate_id, p_engagement_id, p_purpose_name, p_legal_basis,
    p_data_categories, p_data_principals, coalesce(p_recipients, '{}'), coalesce(p_cross_border, false),
    coalesce(p_destination_countries, '{}'), p_retention_months, p_security_measures,
    coalesce(p_dpia_required, false), p_actor_id
  ) returning * into v_rec;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_actor_id::text, null, null, null,
    'ropa.recorded'::public.ledger_action_type, v_rec.id::text,
    null, null, null, null, null, null, 'success',
    jsonb_build_object(
      'purpose_name', v_rec.purpose_name,
      'legal_basis', v_rec.legal_basis,
      'retention_months', v_rec.retention_period_months
    )
  );

  return jsonb_build_object(
    'recordId', v_rec.id,
    'status', v_rec.status,
    'purposeName', v_rec.purpose_name,
    'version', v_rec.version
  );
end $$;

-- Create Policy Draft
create function public.create_policy_draft(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_title text,
  p_category text,
  p_summary text,
  p_content text,
  p_citations text[],
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_role text;
  v_hash text;
  v_draft public.policy_drafts;
begin
  select role into v_role from public.tenant_users where tenant_id = p_tenant_id and user_id = p_actor_id;
  if v_role not in ('owner', 'admin', 'founder') and not exists (select 1 from public.users where id = p_actor_id and is_axiom_internal) then
    return jsonb_build_object('error', 'forbidden');
  end if;

  if p_title is null or length(btrim(p_title)) not between 1 and 300
     or p_category is null or p_category not in ('data_protection', 'retention', 'breach_response', 'access_control', 'vendor_management', 'acceptable_use', 'privacy_notice')
     or p_summary is null or length(btrim(p_summary)) not between 1 and 2000
     or p_content is null or octet_length(p_content) not between 1 and 5242880
     or p_correlation_id is null then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  v_hash := encode(sha256(convert_to(p_content, 'UTF8')), 'hex');

  insert into public.policy_drafts (
    tenant_id, title, category, summary, content, content_sha256,
    control_citations, created_by
  ) values (
    p_tenant_id, p_title, p_category, p_summary, p_content, v_hash,
    coalesce(p_citations, '{}'), p_actor_id
  ) returning * into v_draft;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_actor_id::text, null, null, null,
    'policy.drafted'::public.ledger_action_type, v_draft.id::text,
    null, null, null, null, null, null, 'success',
    jsonb_build_object(
      'title', v_draft.title,
      'category', v_draft.category,
      'content_hash', v_hash
    )
  );

  return jsonb_build_object(
    'draftId', v_draft.id,
    'status', v_draft.status,
    'contentHash', v_hash,
    'version', v_draft.version
  );
end $$;

-- Review Policy Draft (Founder only)
create function public.review_policy_draft(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_draft_id uuid,
  p_decision text,
  p_expected_hash text,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_draft public.policy_drafts;
  v_new_status text;
begin
  if not public.report_founder_allowed(p_tenant_id, p_actor_id) then
    return jsonb_build_object('error', 'founder_authority_required');
  end if;

  if p_draft_id is null or p_decision not in ('approved', 'rejected') or p_expected_hash is null or p_correlation_id is null then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  select * into v_draft from public.policy_drafts
   where tenant_id = p_tenant_id and id = p_draft_id for update;

  if not found then
    return jsonb_build_object('error', 'draft_not_found');
  end if;

  if v_draft.content_sha256 is distinct from p_expected_hash then
    return jsonb_build_object('error', 'digest_mismatch');
  end if;

  if v_draft.status not in ('draft', 'under_review') then
    return jsonb_build_object('error', 'invalid_draft_state');
  end if;

  v_new_status := case when p_decision = 'approved' then 'approved' else 'deprecated' end;

  update public.policy_drafts
     set status = v_new_status,
         reviewed_by = p_actor_id,
         reviewed_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where tenant_id = p_tenant_id and id = v_draft.id
   returning * into v_draft;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_actor_id::text, null, null, null,
    'policy.reviewed'::public.ledger_action_type, v_draft.id::text,
    null, null, null, null, null, null, 'success',
    jsonb_build_object(
      'decision', p_decision,
      'status', v_new_status,
      'content_hash', v_draft.content_sha256
    )
  );

  return jsonb_build_object(
    'draftId', v_draft.id,
    'status', v_draft.status,
    'reviewedAt', v_draft.reviewed_at
  );
end $$;

-- Create Playbook Entry
create function public.create_playbook_entry(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_title text,
  p_kind text,
  p_trigger text,
  p_target_agent text,
  p_steps jsonb,
  p_requires_approval boolean,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_role text;
  v_entry public.playbook_entries;
begin
  select role into v_role from public.tenant_users where tenant_id = p_tenant_id and user_id = p_actor_id;
  if v_role not in ('owner', 'admin', 'founder') and not exists (select 1 from public.users where id = p_actor_id and is_axiom_internal) then
    return jsonb_build_object('error', 'forbidden');
  end if;

  if p_title is null or length(btrim(p_title)) not between 1 and 300
     or p_kind is null or p_kind not in ('incident_response', 'dsar_fulfillment', 'breach_notification', 'vendor_audit', 'consent_revocation', 'continuous_monitoring')
     or p_trigger is null or length(btrim(p_trigger)) not between 1 and 1000
     or p_target_agent is null or p_target_agent not in ('drishti', 'vibhaag', 'parikshan', 'saakshi', 'sudhaar', 'karya', 'lekha', 'nazar', 'prativedan', 'sanket')
     or p_steps is null or jsonb_typeof(p_steps) is distinct from 'array' or jsonb_array_length(p_steps) not between 1 and 50
     or p_correlation_id is null then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  insert into public.playbook_entries (
    tenant_id, title, kind, trigger_condition, target_agent, steps,
    requires_human_approval, created_by
  ) values (
    p_tenant_id, p_title, p_kind, p_trigger, p_target_agent, p_steps,
    coalesce(p_requires_approval, true), p_actor_id
  ) returning * into v_entry;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_actor_id::text, null, null, null,
    'playbook.created'::public.ledger_action_type, v_entry.id::text,
    null, null, null, null, null, null, 'success',
    jsonb_build_object(
      'title', v_entry.title,
      'kind', v_entry.kind,
      'target_agent', v_entry.target_agent
    )
  );

  return jsonb_build_object(
    'playbookId', v_entry.id,
    'status', v_entry.status,
    'title', v_entry.title,
    'version', v_entry.version
  );
end $$;

-- Submit Classification Review
create function public.submit_classification_review(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_estate_id uuid,
  p_system_id text,
  p_resource_path text,
  p_sensitivity_level text,
  p_categories text[],
  p_confidence numeric,
  p_decision text,
  p_adjusted_sensitivity text,
  p_justification text,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_role text;
  v_rev public.classification_reviews;
begin
  select role into v_role from public.tenant_users where tenant_id = p_tenant_id and user_id = p_actor_id;
  if v_role not in ('owner', 'admin', 'founder', 'reviewer', 'axiom_analyst') and not exists (select 1 from public.users where id = p_actor_id and is_axiom_internal) then
    return jsonb_build_object('error', 'forbidden');
  end if;

  if p_system_id is null or length(btrim(p_system_id)) not between 1 and 200
     or p_resource_path is null or length(btrim(p_resource_path)) not between 1 and 1000
     or p_sensitivity_level is null or p_sensitivity_level not in ('public', 'internal', 'confidential', 'restricted', 'critical_pii')
     or p_categories is null or cardinality(p_categories) not between 1 and 50
     or p_confidence is null or p_confidence not between 0 and 100
     or p_decision is null or p_decision not in ('confirmed', 'adjusted', 'overridden', 'dismissed')
     or (p_decision in ('adjusted', 'overridden') and (p_adjusted_sensitivity is null or p_adjusted_sensitivity not in ('public', 'internal', 'confidential', 'restricted', 'critical_pii')))
     or (p_decision in ('confirmed', 'dismissed') and p_adjusted_sensitivity is not null)
     or p_justification is null or length(btrim(p_justification)) not between 1 and 2000
     or p_correlation_id is null then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  if p_estate_id is not null and not exists (select 1 from public.estates where tenant_id = p_tenant_id and id = p_estate_id) then
    return jsonb_build_object('error', 'estate_not_found');
  end if;

  insert into public.classification_reviews (
    tenant_id, estate_id, system_id, resource_path, sensitivity_level,
    detected_categories, confidence_score, reviewed_by, decision,
    adjusted_sensitivity, justification
  ) values (
    p_tenant_id, p_estate_id, p_system_id, p_resource_path, p_sensitivity_level,
    p_categories, p_confidence, p_actor_id, p_decision,
    p_adjusted_sensitivity, p_justification
  ) returning * into v_rev;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_actor_id::text, null, null, null,
    'classification.reviewed'::public.ledger_action_type, v_rev.id::text,
    null, null, null, null, null, null, 'success',
    jsonb_build_object(
      'system_id', v_rev.system_id,
      'resource_path', v_rev.resource_path,
      'decision', v_rev.decision,
      'final_sensitivity', coalesce(v_rev.adjusted_sensitivity, v_rev.sensitivity_level)
    )
  );

  return jsonb_build_object(
    'reviewId', v_rev.id,
    'decision', v_rev.decision,
    'finalSensitivity', coalesce(v_rev.adjusted_sensitivity, v_rev.sensitivity_level)
  );
end $$;

revoke all on function public.create_ropa_record(uuid, uuid, uuid, uuid, text, text, text[], text[], text[], boolean, text[], integer, text, boolean, uuid) from public, anon, authenticated;
revoke all on function public.create_policy_draft(uuid, uuid, text, text, text, text, text[], uuid) from public, anon, authenticated;
revoke all on function public.review_policy_draft(uuid, uuid, uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.create_playbook_entry(uuid, uuid, text, text, text, text, jsonb, boolean, uuid) from public, anon, authenticated;
revoke all on function public.submit_classification_review(uuid, uuid, uuid, text, text, text, text[], numeric, text, text, text, uuid) from public, anon, authenticated;

grant execute on function public.create_ropa_record(uuid, uuid, uuid, uuid, text, text, text[], text[], text[], boolean, text[], integer, text, boolean, uuid) to service_role;
grant execute on function public.create_policy_draft(uuid, uuid, text, text, text, text, text[], uuid) to service_role;
grant execute on function public.review_policy_draft(uuid, uuid, uuid, text, text, uuid) to service_role;
grant execute on function public.create_playbook_entry(uuid, uuid, text, text, text, text, jsonb, boolean, uuid) to service_role;
grant execute on function public.submit_classification_review(uuid, uuid, uuid, text, text, text, text[], numeric, text, text, text, uuid) to service_role;
