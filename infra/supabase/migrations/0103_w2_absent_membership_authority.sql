-- Reject absent tenant membership explicitly: SQL NULL must not skip the
-- refusal branch. Keep the existing explicit internal-authority exception and
-- the scoped human_action_writer EXECUTE grants introduced by 0098.
-- Existing migration files and retained rows remain unchanged.

create or replace function public.create_ropa_record(
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
  if (v_role is null or v_role not in ('owner', 'admin', 'founder')) and not exists (select 1 from public.users where id = p_actor_id and is_axiom_internal) then
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

create or replace function public.create_policy_draft(
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
  if (v_role is null or v_role not in ('owner', 'admin', 'founder')) and not exists (select 1 from public.users where id = p_actor_id and is_axiom_internal) then
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

create or replace function public.create_playbook_entry(
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
  if (v_role is null or v_role not in ('owner', 'admin', 'founder')) and not exists (select 1 from public.users where id = p_actor_id and is_axiom_internal) then
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

create or replace function public.submit_classification_review(
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
  if (v_role is null or v_role not in ('owner', 'admin', 'founder', 'reviewer', 'axiom_analyst')) and not exists (select 1 from public.users where id = p_actor_id and is_axiom_internal) then
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
