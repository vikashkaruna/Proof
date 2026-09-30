-- A board request freezes the exact finalized packet bytes it will render.
-- Historical requests without a snapshot remain unreleasable and must be
-- requested again under a new operation key. This is a database snapshot,
-- not an Object Lock receipt or permission to release a report.
create table public.board_request_sources (
  request_id uuid primary key references public.board_report_requests(id) on delete restrict,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  source_text text not null check (octet_length(source_text) between 1 and 4194304),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  controls_sha256 text not null check (controls_sha256 ~ '^[0-9a-f]{64}$'),
  result_sha256 text not null check (result_sha256 ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, request_id),
  foreign key (tenant_id, request_id)
    references public.board_report_requests(tenant_id, id) on delete restrict,
  check (source_sha256 = encode(sha256(convert_to(source_text, 'UTF8')), 'hex'))
);

alter table public.board_request_sources enable row level security;
revoke all on public.board_request_sources from public, anon, authenticated, service_role;
grant select on public.board_request_sources to service_role;
create policy board_request_source_service_read on public.board_request_sources
  for select to service_role using (true);

create function public.capture_board_request_source() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  packet public.workload_assessment_packets;
  started public.audit_ledger;
  completed public.audit_ledger;
  finalized public.audit_ledger;
  controls_text text;
  result_text text;
  source_text text;
begin
  -- The request RPC checked and share-locked the same finalized packet.
  -- Recheck here so an alternative privileged INSERT cannot freeze a
  -- merely completed or mismatched packet.
  if not public.board_assessment_source_valid(
    new.tenant_id, new.assessment_run_id, new.engagement_id
  ) then
    raise exception 'board assessment source is not finalized';
  end if;

  select * into packet from public.workload_assessment_packets
    where tenant_id = new.tenant_id and run_id = new.assessment_run_id
      and engagement_id = new.engagement_id for share;
  if not found or packet.result_digest is distinct from new.assessment_result_digest
     or packet.library_digest is distinct from new.library_digest
     or packet.library_version is distinct from new.library_version then
    raise exception 'board assessment source changed';
  end if;

  controls_text := packet.controls::text;
  result_text := packet.result::text;
  if packet.library_digest is distinct from encode(sha256(convert_to(controls_text, 'UTF8')), 'hex')
     or packet.result_digest is distinct from encode(sha256(convert_to(result_text, 'UTF8')), 'hex') then
    raise exception 'board assessment digest mismatch';
  end if;

  select * into started from public.audit_ledger
    where tenant_id = new.tenant_id and id = packet.started_receipt;
  select * into completed from public.audit_ledger
    where tenant_id = new.tenant_id and id = packet.completed_receipt;
  select * into finalized from public.audit_ledger
    where tenant_id = new.tenant_id and id = packet.finalized_receipt;

  source_text := jsonb_build_object(
    'schema_version', 1,
    'serialization', 'postgres-jsonb-text-v1',
    'kind', 'board_source',
    'request_id', new.id,
    'tenant_id', new.tenant_id,
    'engagement_id', new.engagement_id,
    'assessment_run_id', new.assessment_run_id,
    'library_version', packet.library_version,
    'controls_text', controls_text,
    'controls_sha256', packet.library_digest,
    'result_text', result_text,
    'result_sha256', packet.result_digest,
    'completed_at', packet.completed_at,
    'finalized_at', packet.finalized_at,
    'receipts', jsonb_build_object(
      'started', jsonb_build_object('id', started.id::text, 'entry_hash', started.entry_hash),
      'completed', jsonb_build_object('id', completed.id::text, 'entry_hash', completed.entry_hash),
      'finalized', jsonb_build_object('id', finalized.id::text, 'entry_hash', finalized.entry_hash)
    ),
    'limitations', jsonb_build_array(
      'Recorded questionnaire computation; no independent evidence verification.',
      'Current remediation state is not included.',
      'Not a compliance certification or legal opinion.'
    )
  )::text;
  if octet_length(source_text) > 4194304 then
    raise exception 'board source exceeds byte limit';
  end if;

  insert into public.board_request_sources (
    request_id, tenant_id, source_text, source_sha256,
    controls_sha256, result_sha256
  ) values (
    new.id, new.tenant_id, source_text,
    encode(sha256(convert_to(source_text, 'UTF8')), 'hex'),
    packet.library_digest, packet.result_digest
  );
  return new;
end $$;

revoke all on function public.capture_board_request_source() from public, anon, authenticated, service_role;
create trigger board_request_capture_source
  after insert on public.board_report_requests
  for each row execute function public.capture_board_request_source();

-- The legacy draft RPC stores source_json_* on board_report_artifacts. Before
-- that row is inserted, replace its former content-hash alias with the actual
-- frozen source hash/size, and refuse a draft that does not name that source.
-- This remains metadata only; no object version has been sealed yet.
create function public.bind_board_draft_source() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  report public.reports;
  snapshot public.board_request_sources;
  request public.board_report_requests;
begin
  select * into report from public.reports
    where tenant_id=new.tenant_id and id=new.report_id;
  if not found or report.kind<>'board' or report.operation_key is null then
    raise exception 'board draft report binding unavailable';
  end if;
  select * into request from public.board_report_requests
    where tenant_id=new.tenant_id and operation_key=report.operation_key;
  if not found or request.engagement_id is distinct from report.engagement_id
     or request.title is distinct from report.title then
    raise exception 'board draft request binding unavailable';
  end if;
  select * into snapshot from public.board_request_sources
    where tenant_id=new.tenant_id and request_id=request.id;
  if not found or report.content->>'source_sha256' is distinct from snapshot.source_sha256
     or report.content->>'assessment_run_id' is distinct from request.assessment_run_id::text
     or report.content->>'assessment_result_digest' is distinct from request.assessment_result_digest
     or report.content->>'library_digest' is distinct from request.library_digest then
    raise exception 'board draft source binding mismatch';
  end if;
  new.source_json_sha256 := snapshot.source_sha256;
  new.source_json_bytes := octet_length(snapshot.source_text);
  return new;
end $$;

revoke all on function public.bind_board_draft_source() from public, anon, authenticated, service_role;
create trigger board_draft_bind_source
  before insert on public.board_report_artifacts
  for each row execute function public.bind_board_draft_source();
