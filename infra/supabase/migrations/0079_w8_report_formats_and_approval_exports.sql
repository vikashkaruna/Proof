-- ─────────────────────────────────────────────────────────────────────
-- 0079_w8_report_formats_and_approval_exports.sql
--
-- W8 · Statutory report formats & approval exports (Revision 106).
--
-- 1. Adds ledger action types: 'approval.exported' and 'report.exported'.
-- 2. Creates public.approval_exports table with strict RLS and composite FKs.
-- 3. Creates public.statutory_report_artifacts supporting all 4 DPDPA report
--    formats (board, auditor, dpb, technical) with exact sha256 tracking.
-- 4. SECURITY DEFINER RPCs:
--      - record_approval_export
--      - record_statutory_report_draft
--      - attach_statutory_report_pdf
-- ─────────────────────────────────────────────────────────────────────

alter type public.ledger_action_type add value if not exists 'approval.exported';
alter type public.ledger_action_type add value if not exists 'report.exported';

-- ─── 1. Approval Exports Table ───────────────────────────────────────

create table if not exists public.approval_exports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  exported_by uuid not null references public.users(id) on delete restrict,
  plan_id uuid,
  format text not null check (format in ('json', 'html', 'pdf', 'csv')),
  filter_params jsonb not null default '{}'::jsonb check (jsonb_typeof(filter_params) = 'object'),
  summary jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  artifact_sha256 text not null check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_bytes bigint not null check (artifact_bytes between 1 and 67108864),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, id),
  foreign key (tenant_id, plan_id) references public.remediation_plans(tenant_id, id) on delete set null
);

create index if not exists idx_approval_exports_tenant on public.approval_exports(tenant_id, created_at desc);
create index if not exists idx_approval_exports_plan on public.approval_exports(tenant_id, plan_id);

alter table public.approval_exports enable row level security;
revoke all on public.approval_exports from public, anon, authenticated, service_role;
grant select, insert on public.approval_exports to service_role;
grant select on public.approval_exports to authenticated;

create policy approval_exports_tenant_select on public.approval_exports
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
  );

create policy approval_exports_service_all on public.approval_exports
  for all to service_role using (true) with check (true);

-- ─── 2. Statutory Report Artifacts Table ─────────────────────────────

create table if not exists public.statutory_report_artifacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  report_id uuid not null unique,
  kind public.report_kind not null,
  source_json_sha256 text not null check (source_json_sha256 ~ '^[0-9a-f]{64}$'),
  source_json_bytes bigint not null check (source_json_bytes between 1 and 10485760),
  html_sha256 text not null check (html_sha256 ~ '^[0-9a-f]{64}$'),
  html_bytes bigint not null check (html_bytes between 1 and 10485760),
  pdf_sha256 text check (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  pdf_bytes bigint check (pdf_bytes between 1 and 67108864),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, id),
  foreign key (tenant_id, report_id) references public.reports(tenant_id, id) on delete cascade
);

create index if not exists idx_statutory_artifacts_tenant on public.statutory_report_artifacts(tenant_id, created_at desc);

alter table public.statutory_report_artifacts enable row level security;
revoke all on public.statutory_report_artifacts from public, anon, authenticated, service_role;
grant select, insert, update on public.statutory_report_artifacts to service_role;
grant select on public.statutory_report_artifacts to authenticated;

create policy statutory_artifacts_tenant_select on public.statutory_report_artifacts
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
  );

create policy statutory_artifacts_service_all on public.statutory_report_artifacts
  for all to service_role using (true) with check (true);

-- ─── 3. RPC: record_approval_export ──────────────────────────────────

create or replace function public.record_approval_export(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_plan_id uuid,
  p_format text,
  p_filter_params jsonb,
  p_summary jsonb,
  p_artifact_sha256 text,
  p_artifact_bytes bigint,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_export public.approval_exports;
begin
  if not exists (select 1 from public.tenants where id = p_tenant_id) then
    return jsonb_build_object('error', 'tenant_not_found');
  end if;

  if not exists (
    select 1 from public.tenant_users
     where tenant_id = p_tenant_id and user_id = p_actor_id
  ) then
    return jsonb_build_object('error', 'forbidden');
  end if;

  if p_plan_id is not null and not exists (
    select 1 from public.remediation_plans
     where tenant_id = p_tenant_id and id = p_plan_id
  ) then
    return jsonb_build_object('error', 'plan_not_found');
  end if;

  if p_format not in ('json', 'html', 'pdf', 'csv') then
    return jsonb_build_object('error', 'invalid_format');
  end if;

  if p_artifact_sha256 is null or p_artifact_sha256 !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('error', 'invalid_artifact_hash');
  end if;

  if p_artifact_bytes is null or p_artifact_bytes < 1 or p_artifact_bytes > 67108864 then
    return jsonb_build_object('error', 'invalid_artifact_size');
  end if;

  insert into public.approval_exports (
    tenant_id, exported_by, plan_id, format, filter_params, summary,
    artifact_sha256, artifact_bytes
  ) values (
    p_tenant_id, p_actor_id, p_plan_id, p_format,
    coalesce(p_filter_params, '{}'::jsonb),
    coalesce(p_summary, '{}'::jsonb),
    p_artifact_sha256, p_artifact_bytes
  ) returning * into v_export;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_actor_id::text, null, null, null,
    'approval.exported'::public.ledger_action_type, v_export.id::text,
    null, null, null, null, null, null, 'success',
    jsonb_build_object(
      'export_id', v_export.id,
      'plan_id', p_plan_id,
      'format', p_format,
      'artifact_sha256', p_artifact_sha256,
      'artifact_bytes', p_artifact_bytes
    )
  );

  return jsonb_build_object(
    'exportId', v_export.id,
    'status', 'exported',
    'artifactSha256', v_export.artifact_sha256,
    'createdAt', v_export.created_at
  );
end $$;

revoke all on function public.record_approval_export(uuid, uuid, uuid, text, jsonb, jsonb, text, bigint, uuid) from public, anon, authenticated;
grant execute on function public.record_approval_export(uuid, uuid, uuid, text, jsonb, jsonb, text, bigint, uuid) to service_role;

-- ─── 4. RPC: record_statutory_report_draft ───────────────────────────

create or replace function public.record_statutory_report_draft(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_engagement_id uuid,
  p_kind text,
  p_title text,
  p_library_version text,
  p_content_text text,
  p_html_text text,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_report public.reports;
  v_content jsonb;
  v_content_hash text;
  v_html_hash text;
  v_op_key uuid;
begin
  if not public.is_tenant_member(p_tenant_id) and not exists (
    select 1 from public.tenant_users where tenant_id = p_tenant_id and user_id = p_actor_id
  ) then
    return jsonb_build_object('error', 'forbidden');
  end if;

  if p_kind not in ('board', 'auditor', 'dpb', 'technical') then
    return jsonb_build_object('error', 'invalid_report_kind');
  end if;

  if p_content_text is null or octet_length(p_content_text) > 5242880 or
     p_html_text is null or octet_length(p_html_text) > 5242880 then
    return jsonb_build_object('error', 'invalid_content');
  end if;

  begin
    v_content := p_content_text::jsonb;
  exception when invalid_text_representation then
    return jsonb_build_object('error', 'invalid_json');
  end;

  v_content_hash := encode(sha256(convert_to(p_content_text, 'UTF8')), 'hex');
  v_html_hash := encode(sha256(convert_to(p_html_text, 'UTF8')), 'hex');
  v_op_key := gen_random_uuid();

  insert into public.reports (
    tenant_id, engagement_id, kind, title, storage_uri, content,
    library_version, generated_by_agent, operation_key, created_by,
    content_text, content_sha256
  ) values (
    p_tenant_id, p_engagement_id, p_kind::public.report_kind, btrim(p_title), null, v_content,
    p_library_version, 'prativedan', v_op_key, p_actor_id,
    p_content_text, v_content_hash
  ) returning * into v_report;

  insert into public.statutory_report_artifacts (
    tenant_id, report_id, kind, source_json_sha256, source_json_bytes,
    html_sha256, html_bytes
  ) values (
    p_tenant_id, v_report.id, p_kind::public.report_kind, v_content_hash, octet_length(p_content_text),
    v_html_hash, octet_length(p_html_text)
  );

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'agent', 'prativedan', null, null, null,
    'report.drafted'::public.ledger_action_type, v_report.id::text,
    null, null, null, null, null, null, 'success',
    jsonb_build_object(
      'report_id', v_report.id,
      'kind', p_kind,
      'content_hash', v_content_hash,
      'html_hash', v_html_hash
    )
  );

  return jsonb_build_object(
    'reportId', v_report.id,
    'status', 'draft',
    'kind', p_kind,
    'contentHash', v_content_hash,
    'htmlHash', v_html_hash
  );
end $$;

revoke all on function public.record_statutory_report_draft(uuid, uuid, uuid, text, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.record_statutory_report_draft(uuid, uuid, uuid, text, text, text, text, text, uuid) to service_role;

-- ─── 5. RPC: attach_statutory_report_pdf ─────────────────────────────

create or replace function public.attach_statutory_report_pdf(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_report_id uuid,
  p_pdf_sha256 text,
  p_pdf_bytes bigint,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_artifact public.statutory_report_artifacts;
begin
  if not exists (
    select 1 from public.reports
     where tenant_id = p_tenant_id and id = p_report_id
  ) then
    return jsonb_build_object('error', 'report_not_found');
  end if;

  if p_pdf_sha256 is null or p_pdf_sha256 !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('error', 'invalid_pdf_hash');
  end if;

  if p_pdf_bytes is null or p_pdf_bytes < 1 or p_pdf_bytes > 67108864 then
    return jsonb_build_object('error', 'invalid_pdf_size');
  end if;

  update public.statutory_report_artifacts
     set pdf_sha256 = p_pdf_sha256,
         pdf_bytes = p_pdf_bytes
   where tenant_id = p_tenant_id and report_id = p_report_id
  returning * into v_artifact;

  if not found then
    return jsonb_build_object('error', 'artifact_not_found');
  end if;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'agent', 'prativedan', null, null, null,
    'report.exported'::public.ledger_action_type, p_report_id::text,
    null, null, null, null, null, null, 'success',
    jsonb_build_object(
      'report_id', p_report_id,
      'pdf_sha256', p_pdf_sha256,
      'pdf_bytes', p_pdf_bytes
    )
  );

  return jsonb_build_object(
    'reportId', p_report_id,
    'pdfSha256', p_pdf_sha256,
    'pdfBytes', p_pdf_bytes,
    'status', 'pdf_attached'
  );
end $$;

revoke all on function public.attach_statutory_report_pdf(uuid, uuid, uuid, text, bigint, uuid) from public, anon, authenticated;
grant execute on function public.attach_statutory_report_pdf(uuid, uuid, uuid, text, bigint, uuid) to service_role;
