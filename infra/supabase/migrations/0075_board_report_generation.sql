-- ─────────────────────────────────────────────────────────────────────
-- 0075_board_report_generation.sql
--
-- Revision 102 · Board reports from finalized assessment sources (W8):
--   1. board_report_requests: Manager-initiated request bound to a finalized
--      assessment packet (with verified result_digest and library_digest).
--   2. board_report_artifacts: Retains exact source JSON bytes, rendered HTML,
--      and exact PDF hash/storage metadata.
--   3. Dual-visibility: Drafts remain private to current tenant founder who
--      is also Axiom-internal; requesting managers see their own request
--      status/metadata until published.
--   4. Immutable founder review & release gate.
-- ─────────────────────────────────────────────────────────────────────

alter type public.ledger_action_type add value if not exists 'report.requested';
alter type public.ledger_action_type add value if not exists 'report.drafted';

create table public.board_report_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  engagement_id uuid not null,
  assessment_run_id uuid not null references public.workload_assessment_packets(run_id) on delete restrict,
  report_id uuid references public.reports(id) on delete restrict,
  operation_key uuid not null,
  requested_by uuid not null references public.users(id) on delete restrict,
  title text not null check (length(btrim(title)) between 1 and 300),
  status text not null default 'requested' check (status in ('requested', 'drafted', 'reviewed', 'released', 'rejected')),
  assessment_result_digest text not null check (assessment_result_digest ~ '^[0-9a-f]{64}$'),
  library_version text not null references public.control_libraries(version) on delete restrict,
  library_digest text not null check (library_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, id),
  unique (tenant_id, operation_key),
  foreign key (tenant_id, engagement_id) references public.engagements(tenant_id, id) on delete restrict
);

create table public.board_report_artifacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  report_id uuid not null unique,
  source_json_sha256 text not null check (source_json_sha256 ~ '^[0-9a-f]{64}$'),
  source_json_bytes bigint not null check (source_json_bytes between 1 and 10485760),
  html_sha256 text not null check (html_sha256 ~ '^[0-9a-f]{64}$'),
  html_bytes bigint not null check (html_bytes between 1 and 10485760),
  pdf_sha256 text check (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  pdf_bytes bigint check (pdf_bytes between 1 and 67108864),
  storage_provider text default 's3-compatible' check (storage_provider in ('s3', 's3-compatible')),
  storage_bucket text,
  storage_key text,
  storage_version_id text,
  retain_until timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, id),
  foreign key (tenant_id, report_id) references public.reports(tenant_id, id) on delete restrict
);

alter table public.board_report_requests enable row level security;
alter table public.board_report_artifacts enable row level security;

revoke all on public.board_report_requests from public, anon, authenticated, service_role;
revoke all on public.board_report_artifacts from public, anon, authenticated, service_role;

grant select on public.board_report_requests to service_role, authenticated;
grant select on public.board_report_artifacts to service_role, authenticated;

-- Requesting managers can see their own requests; founders/internal can see all tenant requests.
create policy board_request_tenant_read on public.board_report_requests
  for select to authenticated
  using (
    tenant_id in (select tenant_id from public.tenant_users where user_id = auth.uid())
    and (
      requested_by = auth.uid()
      or exists (
        select 1 from public.tenant_users tu
        join public.users u on u.id = tu.user_id
        where tu.tenant_id = board_report_requests.tenant_id
          and tu.user_id = auth.uid()
          and tu.role in ('founder', 'owner', 'admin')
      )
    )
  );

create policy board_request_service_read on public.board_report_requests
  for select to service_role using (true);

-- Artifacts are readable by permitted report viewers
create policy board_artifact_tenant_read on public.board_report_artifacts
  for select to authenticated
  using (
    exists (
      select 1 from public.reports r
      where r.tenant_id = board_report_artifacts.tenant_id
        and r.id = board_report_artifacts.report_id
        and public.report_visible(r.tenant_id, r.created_by, r.status)
    )
  );

create policy board_artifact_service_read on public.board_report_artifacts
  for select to service_role using (true);

-- ─── Function: request_board_report ───────────────────────────────────
create function public.request_board_report(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_operation_key uuid,
  p_engagement_id uuid,
  p_assessment_run_id uuid,
  p_title text,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_req public.board_report_requests;
  v_pkt public.workload_assessment_packets;
begin
  if not public.evidence_manager_allowed(p_tenant_id, p_actor_id) then
    return jsonb_build_object('error', 'forbidden');
  end if;

  if p_operation_key is null or p_correlation_id is null or p_engagement_id is null
     or p_assessment_run_id is null or p_title is null
     or length(btrim(p_title)) not between 1 and 300 then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  select * into v_pkt from public.workload_assessment_packets
   where tenant_id = p_tenant_id
     and run_id = p_assessment_run_id
     and engagement_id = p_engagement_id;

  if not found then
    return jsonb_build_object('error', 'assessment_not_found');
  end if;

  if v_pkt.completed_at is null or v_pkt.result_digest is null then
    return jsonb_build_object('error', 'assessment_not_finalized');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || p_operation_key::text, 0));

  select * into v_req from public.board_report_requests
   where tenant_id = p_tenant_id and operation_key = p_operation_key for update;

  if found then
    if v_req.requested_by is distinct from p_actor_id
       or v_req.engagement_id is distinct from p_engagement_id
       or v_req.assessment_run_id is distinct from p_assessment_run_id
       or v_req.title is distinct from btrim(p_title) then
      return jsonb_build_object('error', 'idempotency_conflict');
    end if;
    return jsonb_build_object(
      'requestId', v_req.id,
      'status', v_req.status,
      'reportId', v_req.report_id,
      'replayed', true
    );
  end if;

  insert into public.board_report_requests (
    tenant_id, engagement_id, assessment_run_id, operation_key,
    requested_by, title, status, assessment_result_digest,
    library_version, library_digest
  ) values (
    p_tenant_id, p_engagement_id, p_assessment_run_id, p_operation_key,
    p_actor_id, btrim(p_title), 'requested', v_pkt.result_digest,
    v_pkt.library_version, v_pkt.library_digest
  ) returning * into v_req;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_actor_id::text, null, null, null,
    'report.requested'::public.ledger_action_type, v_req.id::text,
    null, null, null, null, null, null, 'success',
    jsonb_build_object(
      'assessment_run_id', p_assessment_run_id,
      'result_digest', v_pkt.result_digest,
      'library_version', v_pkt.library_version
    )
  );

  return jsonb_build_object(
    'requestId', v_req.id,
    'status', 'requested',
    'reportId', null,
    'replayed', false
  );
end $$;

revoke all on function public.request_board_report(uuid, uuid, uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.request_board_report(uuid, uuid, uuid, uuid, uuid, text, uuid) to service_role;

-- ─── Function: record_board_report_draft ──────────────────────────────
create function public.record_board_report_draft(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_request_id uuid,
  p_content_text text,
  p_html_text text,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_req public.board_report_requests;
  v_report public.reports;
  v_content jsonb;
  v_content_hash text;
  v_html_hash text;
begin
  if not public.report_founder_allowed(p_tenant_id, p_actor_id) then
    return jsonb_build_object('error', 'founder_authority_required');
  end if;

  if p_request_id is null or p_correlation_id is null or p_content_text is null
     or octet_length(p_content_text) > 5242880 or p_html_text is null
     or octet_length(p_html_text) > 5242880 then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  begin
    v_content := p_content_text::jsonb;
  exception when invalid_text_representation then
    return jsonb_build_object('error', 'invalid_request');
  end;

  if jsonb_typeof(v_content) is distinct from 'object' then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  select * into v_req from public.board_report_requests
   where tenant_id = p_tenant_id and id = p_request_id for update;

  if not found then
    return jsonb_build_object('error', 'request_not_found');
  end if;

  if v_req.status not in ('requested', 'drafted') then
    return jsonb_build_object('error', 'invalid_request_state');
  end if;

  v_content_hash := encode(sha256(convert_to(p_content_text, 'UTF8')), 'hex');
  v_html_hash := encode(sha256(convert_to(p_html_text, 'UTF8')), 'hex');

  if v_req.report_id is not null then
    select * into v_report from public.reports
     where tenant_id = p_tenant_id and id = v_req.report_id for update;
    if found and v_report.content_sha256 = v_content_hash then
      return jsonb_build_object(
        'reportId', v_report.id,
        'requestId', v_req.id,
        'status', v_report.status,
        'contentHash', v_content_hash,
        'replayed', true
      );
    end if;
  end if;

  insert into public.reports (
    tenant_id, engagement_id, kind, title, storage_uri, content,
    library_version, generated_by_agent, operation_key, created_by,
    content_text, content_sha256
  ) values (
    p_tenant_id, v_req.engagement_id, 'board'::public.report_kind, v_req.title, null, v_content,
    v_req.library_version, 'prativedan', v_req.operation_key, p_actor_id,
    p_content_text, v_content_hash
  ) returning * into v_report;

  insert into public.board_report_artifacts (
    tenant_id, report_id, source_json_sha256, source_json_bytes,
    html_sha256, html_bytes
  ) values (
    p_tenant_id, v_report.id, v_content_hash, octet_length(p_content_text),
    v_html_hash, octet_length(p_html_text)
  );

  update public.board_report_requests
     set report_id = v_report.id,
         status = 'drafted',
         updated_at = clock_timestamp()
   where tenant_id = p_tenant_id and id = v_req.id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'agent', 'prativedan', null, null, null,
    'report.drafted'::public.ledger_action_type, v_report.id::text,
    null, null, null, null, null, null, 'success',
    jsonb_build_object(
      'request_id', v_req.id,
      'content_hash', v_content_hash,
      'html_hash', v_html_hash
    )
  );

  return jsonb_build_object(
    'reportId', v_report.id,
    'requestId', v_req.id,
    'status', 'draft',
    'contentHash', v_content_hash,
    'replayed', false
  );
end $$;

revoke all on function public.record_board_report_draft(uuid, uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.record_board_report_draft(uuid, uuid, uuid, text, text, uuid) to service_role;

-- ─── Function: attach_board_report_pdf ────────────────────────────────
create function public.attach_board_report_pdf(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_report_id uuid,
  p_pdf_sha256 text,
  p_pdf_bytes bigint,
  p_storage_provider text,
  p_storage_bucket text,
  p_storage_key text,
  p_storage_version_id text,
  p_retain_until timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
begin
  if not public.report_founder_allowed(p_tenant_id, p_actor_id) then
    return jsonb_build_object('error', 'founder_authority_required');
  end if;

  if p_report_id is null or p_pdf_sha256 is null or p_pdf_sha256 !~ '^[0-9a-f]{64}$'
     or p_pdf_bytes is null or p_pdf_bytes not between 1 and 67108864
     or p_storage_bucket is null or p_storage_key is null then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  update public.board_report_artifacts
     set pdf_sha256 = p_pdf_sha256,
         pdf_bytes = p_pdf_bytes,
         storage_provider = coalesce(p_storage_provider, 's3-compatible'),
         storage_bucket = p_storage_bucket,
         storage_key = p_storage_key,
         storage_version_id = p_storage_version_id,
         retain_until = p_retain_until
   where tenant_id = p_tenant_id and report_id = p_report_id;

  if not found then
    return jsonb_build_object('error', 'report_not_found');
  end if;

  return jsonb_build_object('reportId', p_report_id, 'pdfHash', p_pdf_sha256);
end $$;

revoke all on function public.attach_board_report_pdf(uuid, uuid, uuid, text, bigint, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.attach_board_report_pdf(uuid, uuid, uuid, text, bigint, text, text, text, text, timestamptz) to service_role;
