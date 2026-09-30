-- W8 statutory report source and exact-version gate. Historical metadata-only
-- statutory artifacts remain unreleasable. SQL verifies the frozen assessment
-- chain and trusted provider readback receipt shape; the BFF verifies actual
-- provider bytes and must render source-bound content deterministically.


create table public.statutory_report_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  engagement_id uuid not null,
  assessment_run_id uuid not null references public.workload_assessment_packets(run_id) on delete restrict,
  kind public.report_kind not null check(kind in ('auditor')),
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
  unique (tenant_id, report_id),
  unique (tenant_id, id, kind),
  foreign key (tenant_id, engagement_id) references public.engagements(tenant_id, id) on delete restrict,
  foreign key (tenant_id, report_id) references public.reports(tenant_id, id) on delete restrict
);


alter table public.statutory_report_requests enable row level security;
revoke all on public.statutory_report_requests from public, anon, authenticated, service_role;
grant select on public.statutory_report_requests to authenticated, service_role;
create policy statutory_request_tenant_read on public.statutory_report_requests
 for select to authenticated using (
  requested_by=auth.uid() and exists(select 1 from public.tenant_users tu
   where tu.tenant_id=statutory_report_requests.tenant_id and tu.user_id=auth.uid()
    and tu.role in ('owner','admin','founder'))
  or exists(select 1 from public.tenant_users tu
   join public.users u on u.id=tu.user_id
   where tu.tenant_id=statutory_report_requests.tenant_id
    and tu.user_id=auth.uid() and tu.role='founder' and u.is_axiom_internal=true));
create policy statutory_request_service_read on public.statutory_report_requests
 for select to service_role using(true);


-- An auditor assessment report freezes the exact finalized packet bytes.
-- Historical requests without a snapshot remain unreleasable and must be
-- requested again under a new operation key. This is a database snapshot,
-- not an Object Lock receipt or permission to release a report.
create table public.statutory_request_sources (
  request_id uuid primary key references public.statutory_report_requests(id) on delete restrict,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  source_text text not null check (octet_length(source_text) between 1 and 4194304),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  controls_sha256 text not null check (controls_sha256 ~ '^[0-9a-f]{64}$'),
  result_sha256 text not null check (result_sha256 ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, request_id),
  foreign key (tenant_id, request_id)
    references public.statutory_report_requests(tenant_id, id) on delete restrict,
  check (source_sha256 = encode(sha256(convert_to(source_text, 'UTF8')), 'hex'))
);

alter table public.statutory_request_sources enable row level security;
revoke all on public.statutory_request_sources from public, anon, authenticated, service_role;
grant select on public.statutory_request_sources to service_role;
create policy statutory_request_source_service_read on public.statutory_request_sources
  for select to service_role using (true);
create trigger statutory_request_source_immutable before update or delete on public.statutory_request_sources
  for each row execute function public.evidence_receipt_immutable();

create function public.capture_statutory_request_source() returns trigger
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
    raise exception 'auditor assessment source is not finalized';
  end if;

  select * into packet from public.workload_assessment_packets
    where tenant_id = new.tenant_id and run_id = new.assessment_run_id
      and engagement_id = new.engagement_id for share;
  if not found or packet.result_digest is distinct from new.assessment_result_digest
     or packet.library_digest is distinct from new.library_digest
     or packet.library_version is distinct from new.library_version then
    raise exception 'auditor assessment source changed';
  end if;

  controls_text := packet.controls::text;
  result_text := packet.result::text;
  if packet.library_digest is distinct from encode(sha256(convert_to(controls_text, 'UTF8')), 'hex')
     or packet.result_digest is distinct from encode(sha256(convert_to(result_text, 'UTF8')), 'hex') then
    raise exception 'auditor assessment digest mismatch';
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
    'kind', 'statutory_source',
    'report_kind', new.kind,
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
      'Assessment-derived auditor review only; no independent audit attestation, evidence certification, compliance certification or legal opinion.'
    )
  )::text;
  if octet_length(source_text) > 4194304 then
    raise exception 'auditor source exceeds byte limit';
  end if;

  insert into public.statutory_request_sources (
    request_id, tenant_id, source_text, source_sha256,
    controls_sha256, result_sha256
  ) values (
    new.id, new.tenant_id, source_text,
    encode(sha256(convert_to(source_text, 'UTF8')), 'hex'),
    packet.library_digest, packet.result_digest
  );
  return new;
end $$;

revoke all on function public.capture_statutory_request_source() from public, anon, authenticated, service_role;
create trigger statutory_request_capture_source
  after insert on public.statutory_report_requests
  for each row execute function public.capture_statutory_request_source();

-- The legacy draft RPC stores source_json_* on statutory_report_artifacts. Before
-- that row is inserted, replace its former content-hash alias with the actual
-- frozen source hash/size, and refuse a draft that does not name that source.
-- This remains metadata only; no object version has been sealed yet.
create function public.bind_statutory_draft_source() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  report public.reports;
  snapshot public.statutory_request_sources;
  request public.statutory_report_requests;
begin
  select * into report from public.reports
    where tenant_id=new.tenant_id and id=new.report_id;
  -- Historical metadata-only rows remain unreleasable under release_report.
  if found and report.generated_by_agent<>'statutory-report-builder' then return new; end if;
  if not found or report.kind not in ('auditor') or report.operation_key is null then
    raise exception 'statutory draft report binding unavailable';
  end if;
  select * into request from public.statutory_report_requests
    where tenant_id=new.tenant_id and operation_key=report.operation_key;
  if not found or request.engagement_id is distinct from report.engagement_id
     or request.title is distinct from report.title or request.kind is distinct from report.kind then
    raise exception 'statutory draft request binding unavailable';
  end if;
  select * into snapshot from public.statutory_request_sources
    where tenant_id=new.tenant_id and request_id=request.id;
  if not found or report.content->>'source_sha256' is distinct from snapshot.source_sha256
     or report.content->>'assessment_run_id' is distinct from request.assessment_run_id::text
     or report.content->>'assessment_result_digest' is distinct from request.assessment_result_digest
     or report.content->>'library_digest' is distinct from request.library_digest
     or report.content->>'kind' is distinct from 'auditor_pack' then
    raise exception 'statutory draft source binding mismatch';
  end if;
  new.source_json_sha256 := snapshot.source_sha256;
  new.source_json_bytes := octet_length(snapshot.source_text);
  return new;
end $$;

revoke all on function public.bind_statutory_draft_source() from public, anon, authenticated, service_role;
create trigger statutory_draft_bind_source
  before insert on public.statutory_report_artifacts
  for each row execute function public.bind_statutory_draft_source();

create or replace function public.request_statutory_report(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_operation_key uuid,
  p_engagement_id uuid,
  p_assessment_run_id uuid,
  p_kind text,
  p_title text,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_req public.statutory_report_requests;
  v_pkt public.workload_assessment_packets;
begin
  if not public.evidence_manager_allowed(p_tenant_id, p_actor_id) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if exists(select 1 from public.tenant_users
    where tenant_id=p_tenant_id and user_id=p_actor_id and role='founder')
    and not public.report_founder_allowed(p_tenant_id,p_actor_id) then
    return jsonb_build_object('error', 'forbidden');
  end if;

  if p_operation_key is null or p_correlation_id is null or p_engagement_id is null
     or p_assessment_run_id is null or p_kind is distinct from 'auditor' or p_title is null
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

  if not public.board_assessment_source_valid(p_tenant_id, p_assessment_run_id, p_engagement_id) then
    return jsonb_build_object('error', 'assessment_not_finalized');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || p_operation_key::text, 0));

  select * into v_req from public.statutory_report_requests
   where tenant_id = p_tenant_id and operation_key = p_operation_key for update;

  if found then
    if v_req.requested_by is distinct from p_actor_id
       or v_req.engagement_id is distinct from p_engagement_id
       or v_req.assessment_run_id is distinct from p_assessment_run_id
       or v_req.kind::text is distinct from p_kind
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

  insert into public.statutory_report_requests (
    tenant_id, engagement_id, assessment_run_id, kind, operation_key,
    requested_by, title, status, assessment_result_digest,
    library_version, library_digest
  ) values (
    p_tenant_id, p_engagement_id, p_assessment_run_id, p_kind::public.report_kind, p_operation_key,
    p_actor_id, btrim(p_title), 'requested', v_pkt.result_digest,
    v_pkt.library_version, v_pkt.library_digest
  ) returning * into v_req;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_actor_id::text, null, null, null,
    'report.requested'::public.ledger_action_type, v_req.id::text,
    null, null, null, null, null, null, 'success',
    jsonb_build_object(
      'assessment_run_id', p_assessment_run_id,
      'kind', p_kind,
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

create or replace function public.record_source_bound_statutory_draft(
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
  v_req public.statutory_report_requests;
  v_report public.reports;
  v_source public.statutory_request_sources;
  v_content jsonb;
  v_result jsonb;
  v_source_document jsonb;
  v_controls jsonb;
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

  select * into v_req from public.statutory_report_requests
   where tenant_id = p_tenant_id and id = p_request_id;

  if not found then
    return jsonb_build_object('error', 'request_not_found');
  end if;

  if not public.board_assessment_source_valid(p_tenant_id, v_req.assessment_run_id, v_req.engagement_id) then
    return jsonb_build_object('error', 'assessment_not_finalized');
  end if;

  select * into v_req from public.statutory_report_requests
   where tenant_id = p_tenant_id and id = p_request_id for update;
  if not found then
    return jsonb_build_object('error', 'request_not_found');
  end if;

  select * into v_source from public.statutory_request_sources
   where tenant_id = p_tenant_id and request_id = v_req.id;
  if found then
    v_source_document := v_source.source_text::jsonb;
    v_result := (v_source_document->>'result_text')::jsonb;
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',item->>'id','title',item->>'title','domain',item->>'domain','severity',item->>'severity'
    ) order by ordinal),'[]'::jsonb) into v_controls
    from jsonb_array_elements((v_source_document->>'controls_text')::jsonb) with ordinality as c(item,ordinal);
  end if;
  if not found or v_source.source_sha256 is distinct from encode(sha256(convert_to(v_source.source_text,'UTF8')),'hex')
    or not (v_content ?& array['schema_version','kind','source_kind','request_id','tenant_id',
      'engagement_id','assessment_run_id','source_sha256','assessment_result_digest','library_digest',
      'library_version','title','generated_by','generated_at','posture_score','finalized_at',
      'finalized_ledger_receipt','findings','controls','limitations'])
    or (v_content - array['schema_version','kind','source_kind','request_id','tenant_id',
      'engagement_id','assessment_run_id','source_sha256','assessment_result_digest','library_digest',
      'library_version','title','generated_by','generated_at','posture_score','finalized_at',
      'finalized_ledger_receipt','findings','controls','limitations']) <> '{}'::jsonb
    or v_content->'schema_version' is distinct from '2'::jsonb
    or v_content->>'kind' is distinct from 'auditor_pack'
    or v_content->>'source_kind' is distinct from 'finalized_assessment'
    or v_content->>'request_id' is distinct from v_req.id::text
    or v_content->>'tenant_id' is distinct from p_tenant_id::text
    or v_content->>'engagement_id' is distinct from v_req.engagement_id::text
    or v_content->>'source_sha256' is distinct from v_source.source_sha256
    or v_content->>'assessment_run_id' is distinct from v_req.assessment_run_id::text
    or v_content->>'assessment_result_digest' is distinct from v_req.assessment_result_digest
    or v_content->>'library_digest' is distinct from v_req.library_digest
    or v_content->>'library_version' is distinct from v_req.library_version
    or v_content->>'title' is distinct from v_req.title
    or v_content->>'generated_by' is distinct from 'statutory-report-builder'
    or jsonb_typeof(v_content->'generated_at') is distinct from 'string'
    or length(coalesce(v_content->>'generated_at','')) not between 1 and 80
    or v_content->'posture_score' is distinct from v_result->'posture_score'
    or v_content->>'finalized_at' is distinct from v_source_document->>'finalized_at'
    or v_content->>'finalized_ledger_receipt' is distinct from v_source_document#>>'{receipts,finalized,id}'
    or jsonb_typeof(v_result->'findings') is distinct from 'array'
    or v_content->'findings' is distinct from v_result->'findings'
    or v_content->'controls' is distinct from v_controls
    or v_content->>'limitations' is distinct from
      'Assessment-derived findings only. No independent audit, evidence verification, or auditor attestation is represented.' then
    return jsonb_build_object('error', 'assessment_source_conflict');
  end if;

  if v_req.status not in ('requested', 'drafted') then
    return jsonb_build_object('error', 'invalid_request_state');
  end if;

  v_content_hash := encode(sha256(convert_to(p_content_text, 'UTF8')), 'hex');
  v_html_hash := encode(sha256(convert_to(p_html_text, 'UTF8')), 'hex');

  if v_req.report_id is not null then
    select * into v_report from public.reports
     where tenant_id = p_tenant_id and id = v_req.report_id for update;
    if found then
      if v_report.content_sha256 is distinct from v_content_hash then
        return jsonb_build_object('error','idempotency_conflict');
      end if;
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
    p_tenant_id, v_req.engagement_id, v_req.kind, v_req.title, null, v_content,
    v_req.library_version, 'statutory-report-builder', v_req.operation_key, p_actor_id,
    p_content_text, v_content_hash
  ) returning * into v_report;

  insert into public.statutory_report_artifacts (
    tenant_id, report_id, kind, source_json_sha256, source_json_bytes,
    html_sha256, html_bytes
  ) values (
    p_tenant_id, v_report.id, v_req.kind, v_content_hash, octet_length(p_content_text),
    v_html_hash, octet_length(p_html_text)
  );

  update public.statutory_report_requests
     set report_id = v_report.id,
         status = 'drafted',
         updated_at = clock_timestamp()
   where tenant_id = p_tenant_id and id = v_req.id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'system', 'statutory-report-builder', null, null, null,
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

revoke all on function public.request_statutory_report(uuid,uuid,uuid,uuid,uuid,text,text,uuid),
 public.record_source_bound_statutory_draft(uuid,uuid,uuid,text,text,uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.request_statutory_report(uuid,uuid,uuid,uuid,uuid,text,text,uuid),
 public.record_source_bound_statutory_draft(uuid,uuid,uuid,text,text,uuid) to service_role;


create table public.statutory_artifact_builds (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete restrict,
 report_id uuid not null unique, operation_key uuid not null, actor_id uuid not null references public.users(id) on delete restrict,
 review_id uuid not null, source_sha256 text not null check(source_sha256 ~ '^[0-9a-f]{64}$'),
 content_sha256 text not null check(content_sha256 ~ '^[0-9a-f]{64}$'),
 review_sha256 text not null check(review_sha256 ~ '^[0-9a-f]{64}$'),
 request jsonb not null check(jsonb_typeof(request)='object' and octet_length(request::text)<=16384),
 retain_until timestamptz not null, correlation_id uuid not null,
 status text not null default 'pending' check(status in ('pending','settled')),
 last_error_code text, created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(), settled_at timestamptz,
 unique(tenant_id,id), unique(tenant_id,id,report_id), unique(tenant_id,operation_key),
 foreign key(tenant_id,report_id) references public.reports(tenant_id,id) on delete restrict,
 foreign key(tenant_id,review_id) references public.report_reviews(tenant_id,id) on delete restrict,
 check((status='pending' and settled_at is null) or (status='settled' and settled_at is not null))
);
create table public.statutory_artifact_versions (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete restrict,
 report_id uuid not null, build_id uuid not null,
 artifact_kind text not null check(artifact_kind in ('source_json','statutory_pdf')),
 provider text not null check(provider in ('s3','s3-compatible')), bucket text not null, object_key text not null,
 version_id text not null check(length(version_id) between 1 and 1024 and btrim(version_id)<>'' and version_id<>'null'),
 content_hash text not null check(content_hash ~ '^[0-9a-f]{64}$'),
 byte_size bigint not null check(byte_size between 1 and 33554432),
 mime_type text not null, retain_until timestamptz not null, readback_at timestamptz not null,
 lock_mode text not null check(lock_mode='COMPLIANCE'), legal_hold boolean not null check(legal_hold=false),
 encryption text not null check(encryption in ('AES256','aws:kms')),
 receipt jsonb not null, verified_by uuid not null references public.users(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp(), unique(tenant_id,id),
 unique(tenant_id,report_id,artifact_kind), unique(tenant_id,build_id,artifact_kind),
 unique(provider,bucket,object_key,version_id),
 foreign key(tenant_id,report_id) references public.reports(tenant_id,id) on delete restrict,
 foreign key(tenant_id,build_id,report_id) references public.statutory_artifact_builds(tenant_id,id,report_id) on delete restrict,
 check((artifact_kind='source_json' and mime_type='application/json' and byte_size<=4194304) or
       (artifact_kind='statutory_pdf' and mime_type='application/pdf'))
);
create index statutory_artifact_builds_pending on public.statutory_artifact_builds(tenant_id,created_at) where status='pending';
alter table public.statutory_artifact_builds enable row level security;
alter table public.statutory_artifact_versions enable row level security;
revoke all on public.statutory_artifact_builds,public.statutory_artifact_versions from public,anon,authenticated,service_role;
grant select on public.statutory_artifact_builds,public.statutory_artifact_versions to service_role;
create policy statutory_artifact_build_service_read on public.statutory_artifact_builds for select to service_role using(true);
create policy statutory_artifact_version_service_read on public.statutory_artifact_versions for select to service_role using(true);
create trigger statutory_artifact_build_immutable before update or delete on public.statutory_artifact_builds
 for each row execute function public.pack_build_immutable();
create trigger statutory_artifact_version_immutable before update or delete on public.statutory_artifact_versions
 for each row execute function public.evidence_receipt_immutable();

create function public.begin_statutory_artifact_build(p_tenant_id uuid,p_actor_id uuid,p_report_id uuid,
 p_operation_key uuid,p_request jsonb,p_correlation_id uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare r public.reports; req public.statutory_report_requests; src public.statutory_request_sources;
 a public.statutory_report_artifacts; rev public.report_reviews; b public.statutory_artifact_builds;
 item jsonb; kind text; expected_key text; n bigint; idx integer;
begin
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','founder_authority_required'); end if;
 if p_report_id is null or p_operation_key is null or p_correlation_id is null or p_request is null
  or jsonb_typeof(p_request)<>'object' or octet_length(p_request::text)>16384
  or not(p_request ?& array['provider','bucket','retention_policy','legal_hold','source_sha256','content_sha256','review_sha256','renderer_version','artifacts'])
  or (p_request-array['provider','bucket','retention_policy','legal_hold','source_sha256','content_sha256','review_sha256','renderer_version','artifacts'])<>'{}'::jsonb
  or p_request->'legal_hold' is distinct from 'false'::jsonb
  or p_request->>'provider' not in ('s3','s3-compatible') or jsonb_typeof(p_request->'provider')<>'string'
  or jsonb_typeof(p_request->'bucket')<>'string' or length(p_request->>'bucket') not between 3 and 255
  or p_request->>'bucket' !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]+$'
  or p_request->>'retention_policy'<>'seven_years' or jsonb_typeof(p_request->'retention_policy')<>'string'
  or jsonb_typeof(p_request->'renderer_version')<>'string'
  or length(coalesce(p_request->>'renderer_version','')) not between 1 and 200
  or jsonb_typeof(p_request->'artifacts')<>'array' or jsonb_array_length(p_request->'artifacts')<>2
  or p_request->>'source_sha256' !~ '^[0-9a-f]{64}$'
  or p_request->>'content_sha256' !~ '^[0-9a-f]{64}$'
  or p_request->>'review_sha256' !~ '^[0-9a-f]{64}$' then return jsonb_build_object('error','invalid_request'); end if;
 select * into r from public.reports where tenant_id=p_tenant_id and id=p_report_id for update;
 if not found or r.kind not in ('auditor') or r.generated_by_agent<>'statutory-report-builder' then return jsonb_build_object('error','report_not_found'); end if;
 select * into req from public.statutory_report_requests where tenant_id=p_tenant_id and report_id=r.id;
 select * into src from public.statutory_request_sources where tenant_id=p_tenant_id and request_id=req.id;
 select * into a from public.statutory_report_artifacts where tenant_id=p_tenant_id and report_id=r.id;
 select * into rev from public.report_reviews where tenant_id=p_tenant_id and report_id=r.id;
 if req.id is null or src.request_id is null or a.id is null or req.operation_key is distinct from r.operation_key
  or req.engagement_id is distinct from r.engagement_id or req.title is distinct from r.title or req.kind is distinct from r.kind
  or r.content->>'source_sha256' is distinct from src.source_sha256
  or r.content->>'assessment_run_id' is distinct from req.assessment_run_id::text
  or r.content->>'assessment_result_digest' is distinct from req.assessment_result_digest
  or r.content->>'library_digest' is distinct from req.library_digest
  or a.source_json_sha256 is distinct from src.source_sha256
  or a.source_json_bytes is distinct from octet_length(src.source_text)
  or src.source_sha256 is distinct from encode(sha256(convert_to(src.source_text,'UTF8')),'hex')
  then return jsonb_build_object('error','assessment_source_conflict'); end if;
 if r.status not in ('approved','published') or rev.id is null or rev.decision<>'approved'
  or rev.content_sha256 is distinct from r.content_sha256
  or r.reviewed_content_hash is distinct from r.content_sha256
  or rev.review_sha256 is distinct from encode(sha256(convert_to(rev.review_text,'UTF8')),'hex')
  then return jsonb_build_object('error','not_approved'); end if;
 if p_request->>'source_sha256' is distinct from src.source_sha256
  or p_request->>'content_sha256' is distinct from r.content_sha256
  or p_request->>'review_sha256' is distinct from rev.review_sha256
  then return jsonb_build_object('error','manifest_changed'); end if;
 for idx in 0..1 loop
  item:=p_request->'artifacts'->idx;
  kind:=case idx when 0 then 'source_json' else 'statutory_pdf' end;
  if jsonb_typeof(item)<>'object' or not(item ?& array['kind','mime_type','content_hash','byte_size','object_key'])
    or (item-array['kind','mime_type','content_hash','byte_size','object_key'])<>'{}'::jsonb
    or item->>'kind' is distinct from kind
    or item->>'mime_type' is distinct from (case idx when 0 then 'application/json' else 'application/pdf' end)
    or jsonb_typeof(item->'content_hash')<>'string' or item->>'content_hash' !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(item->'byte_size')<>'number' or item->>'byte_size' !~ '^[0-9]+$'
    or jsonb_typeof(item->'object_key')<>'string' then return jsonb_build_object('error','invalid_request'); end if;
  begin n:=(item->>'byte_size')::bigint; exception when numeric_value_out_of_range then return jsonb_build_object('error','invalid_request'); end;
  if (idx=0 and (n<>octet_length(src.source_text) or item->>'content_hash' is distinct from src.source_sha256))
    or (idx=1 and n not between 1 and 33554432) then return jsonb_build_object('error','manifest_changed'); end if;
  expected_key:='tenants/'||p_tenant_id::text||'/reports/'||r.id::text||'/'||p_operation_key::text||'/'||kind||'/'||(item->>'content_hash');
  if item->>'object_key' is distinct from expected_key then return jsonb_build_object('error','invalid_request'); end if;
 end loop;
 select * into b from public.statutory_artifact_builds where tenant_id=p_tenant_id and report_id=r.id for update;
 if found then
  if b.operation_key is distinct from p_operation_key or b.request is distinct from p_request then return jsonb_build_object('error','idempotency_conflict'); end if;
  return jsonb_build_object('buildId',b.id,'reportId',r.id,'operationKey',b.operation_key,'status',b.status,
   'request',b.request,'retainUntil',b.retain_until,'correlationId',b.correlation_id,'replayed',true);
 end if;
 if r.status<>'approved' then return jsonb_build_object('error','not_approved'); end if;
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||p_operation_key::text,0));
 if exists(select 1 from public.statutory_artifact_builds where tenant_id=p_tenant_id and operation_key=p_operation_key)
  then return jsonb_build_object('error','idempotency_conflict'); end if;
 insert into public.statutory_artifact_builds(tenant_id,report_id,operation_key,actor_id,review_id,source_sha256,
  content_sha256,review_sha256,request,retain_until,correlation_id)
 values(p_tenant_id,r.id,p_operation_key,p_actor_id,rev.id,src.source_sha256,r.content_sha256,rev.review_sha256,
  p_request,date_trunc('second',clock_timestamp()+interval '7 years')+interval '1 second',p_correlation_id) returning * into b;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
  'report.artifacts.started'::public.ledger_action_type,r.id::text,null,null,null,null,null,null,'success',
  jsonb_build_object('build_id',b.id,'source_sha256',b.source_sha256,'pdf_sha256',p_request#>>'{artifacts,1,content_hash}','review_id',rev.id));
 return jsonb_build_object('buildId',b.id,'reportId',r.id,'operationKey',b.operation_key,'status',b.status,
  'request',b.request,'retainUntil',b.retain_until,'correlationId',b.correlation_id,'replayed',false);
end $$;

create function public.settle_statutory_artifact_version(p_tenant_id uuid,p_actor_id uuid,p_build_id uuid,
 p_artifact_kind text,p_receipt jsonb,p_correlation_id uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare b public.statutory_artifact_builds;r public.reports;item jsonb;existing public.statutory_artifact_versions;
 v_id uuid;v_until timestamptz;v_readback timestamptz;v_field text;v_status text;v_count integer;
begin
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','founder_authority_required'); end if;
 if p_correlation_id is null or p_artifact_kind not in ('source_json','statutory_pdf') or p_receipt is null
  or jsonb_typeof(p_receipt)<>'object' or octet_length(p_receipt::text)>16384 then return jsonb_build_object('error','invalid_receipt'); end if;
 select * into b from public.statutory_artifact_builds where tenant_id=p_tenant_id and id=p_build_id;
 if not found then return jsonb_build_object('error','operation_not_found'); end if;
 select * into r from public.reports where tenant_id=p_tenant_id and id=b.report_id for update;
 select * into b from public.statutory_artifact_builds where tenant_id=p_tenant_id and id=p_build_id for update;
 select * into existing from public.statutory_artifact_versions where tenant_id=p_tenant_id and build_id=b.id and artifact_kind=p_artifact_kind;
 if found then
  if existing.receipt is distinct from p_receipt then return jsonb_build_object('error','receipt_conflict'); end if;
  return jsonb_build_object('buildId',b.id,'reportId',b.report_id,'artifactKind',p_artifact_kind,
   'artifactId',existing.id,'status',b.status,'replayed',true);
 end if;
 if b.status<>'pending' or r.status<>'approved' then return jsonb_build_object('error','not_approved'); end if;
 item:=b.request->'artifacts'->(case when p_artifact_kind='source_json' then 0 else 1 end);
 foreach v_field in array array['provider','bucket','object_key','version_id','content_hash','tenant_id','engagement_id',
   'collected_by_agent','retain_until','readback_at','lock_mode','encryption','operation_id','correlation_id'] loop
  if jsonb_typeof(p_receipt->v_field) is distinct from 'string' then return jsonb_build_object('error','invalid_receipt'); end if;
 end loop;
 if not(p_receipt ?& array['provider','bucket','object_key','version_id','content_hash','byte_size','tenant_id',
   'engagement_id','collected_by_agent','retain_until','readback_at','lock_mode','verified','legal_hold',
   'encryption','operation_id','correlation_id'])
  or (p_receipt-array['provider','bucket','object_key','version_id','content_hash','byte_size','tenant_id',
   'engagement_id','collected_by_agent','retain_until','readback_at','lock_mode','verified','legal_hold',
   'encryption','operation_id','correlation_id'])<>'{}'::jsonb
  or p_receipt->>'provider' is distinct from b.request->>'provider'
  or p_receipt->>'bucket' is distinct from b.request->>'bucket'
  or p_receipt->>'object_key' is distinct from item->>'object_key'
  or p_receipt->>'content_hash' is distinct from item->>'content_hash'
  or p_receipt->'byte_size' is distinct from item->'byte_size'
  or p_receipt->>'tenant_id' is distinct from p_tenant_id::text
  or p_receipt->>'engagement_id' is distinct from r.engagement_id::text
  or p_receipt->>'collected_by_agent' is distinct from 'statutory-report-builder'
  or p_receipt->>'operation_id' is distinct from b.id::text
  or p_receipt->>'correlation_id' is distinct from b.correlation_id::text
  or p_receipt->'verified' is distinct from 'true'::jsonb
  or p_receipt->'legal_hold' is distinct from 'false'::jsonb
  or p_receipt->>'lock_mode' is distinct from 'COMPLIANCE'
  or p_receipt->>'encryption' not in ('AES256','aws:kms')
  or length(coalesce(p_receipt->>'version_id','')) not between 1 and 1024
  or btrim(p_receipt->>'version_id')='' or p_receipt->>'version_id'='null'
  or p_receipt->>'retain_until' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?([Zz]|[+-][0-9]{2}:[0-9]{2})$'
  or p_receipt->>'readback_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?([Zz]|[+-][0-9]{2}:[0-9]{2})$'
  then return jsonb_build_object('error','receipt_mismatch'); end if;
 begin v_until:=(p_receipt->>'retain_until')::timestamptz;v_readback:=(p_receipt->>'readback_at')::timestamptz;
 exception when invalid_datetime_format or datetime_field_overflow then return jsonb_build_object('error','invalid_receipt'); end;
 if v_until is null or not isfinite(v_until) or v_until<b.retain_until
  or v_readback is null or not isfinite(v_readback) or v_readback<clock_timestamp()-interval '5 minutes'
  or v_readback>clock_timestamp()+interval '5 minutes' then return jsonb_build_object('error','receipt_mismatch'); end if;
 insert into public.statutory_artifact_versions(tenant_id,report_id,build_id,artifact_kind,provider,bucket,object_key,
  version_id,content_hash,byte_size,mime_type,retain_until,readback_at,lock_mode,legal_hold,encryption,receipt,verified_by)
 values(p_tenant_id,b.report_id,b.id,p_artifact_kind,p_receipt->>'provider',p_receipt->>'bucket',p_receipt->>'object_key',
  p_receipt->>'version_id',p_receipt->>'content_hash',(p_receipt->>'byte_size')::bigint,item->>'mime_type',
  v_until,v_readback,'COMPLIANCE',false,p_receipt->>'encryption',p_receipt,p_actor_id) returning id into v_id;
 select count(*) into v_count from public.statutory_artifact_versions where tenant_id=p_tenant_id and build_id=b.id;
 v_status:=case when v_count=2 then 'settled' else 'pending' end;
 update public.statutory_artifact_builds set status=v_status,last_error_code=null,
  settled_at=case when v_count=2 then clock_timestamp() else null end,updated_at=clock_timestamp()
  where tenant_id=p_tenant_id and id=b.id;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
  'report.artifact.settled'::public.ledger_action_type,b.report_id::text,null,null,null,null,null,null,'success',
  jsonb_build_object('build_id',b.id,'artifact_id',v_id,'artifact_kind',p_artifact_kind,
   'content_hash',p_receipt->>'content_hash','version_id',p_receipt->>'version_id'));
 return jsonb_build_object('buildId',b.id,'reportId',b.report_id,'artifactKind',p_artifact_kind,
  'artifactId',v_id,'status',v_status,'replayed',false);
end $$;

create function public.note_statutory_artifact_failure(p_tenant_id uuid,p_actor_id uuid,p_build_id uuid,
 p_error_code text,p_correlation_id uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare b public.statutory_artifact_builds;r public.reports;
begin
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','founder_authority_required'); end if;
 if p_correlation_id is null or p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,79}$'
  then return jsonb_build_object('error','invalid_request'); end if;
 select * into b from public.statutory_artifact_builds where tenant_id=p_tenant_id and id=p_build_id;
 if not found then return jsonb_build_object('error','operation_not_found'); end if;
 select * into r from public.reports where tenant_id=p_tenant_id and id=b.report_id for update;
 select * into b from public.statutory_artifact_builds where tenant_id=p_tenant_id and id=p_build_id for update;
 if b.status='pending' and b.last_error_code is distinct from p_error_code then
  update public.statutory_artifact_builds set last_error_code=p_error_code,updated_at=clock_timestamp() where id=b.id;
  perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
   'report.artifacts.pending'::public.ledger_action_type,b.report_id::text,null,null,null,null,null,null,'failure',
   jsonb_build_object('build_id',b.id,'error_code',p_error_code));
 end if;
 return jsonb_build_object('buildId',b.id,'reportId',b.report_id,'status',b.status,
  'lastErrorCode',case when b.status='pending' then p_error_code else null end);
end $$;

-- Preserve the existing board and evidence-pack release branches and fail-closed DPB/technical gate.

create or replace function public.release_report(p_tenant_id uuid,p_report_id uuid,p_released_by uuid,
 p_expected_content_hash text,p_expected_archive_hash text,p_correlation_id uuid)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.reports;p public.evidence_packs;a public.evidence_pack_archives;v_review public.report_reviews;
 b public.board_artifact_builds;s public.board_artifact_versions;pdf public.board_artifact_versions;
 sb public.statutory_artifact_builds;ss public.statutory_artifact_versions;spdf public.statutory_artifact_versions;
 sr public.statutory_report_requests;srs public.statutory_request_sources;sa public.statutory_report_artifacts;
 src public.board_request_sources;req public.board_report_requests;v_time timestamptz:=clock_timestamp();
begin
 if not public.report_founder_allowed(p_tenant_id,p_released_by) then return jsonb_build_object('error','founder_authority_required'); end if;
 if p_correlation_id is null or p_expected_content_hash is null or p_expected_content_hash !~ '^[0-9a-f]{64}$'
  or (p_expected_archive_hash is not null and p_expected_archive_hash !~ '^[0-9a-f]{64}$') then return jsonb_build_object('error','invalid_request'); end if;
 select * into r from public.reports where tenant_id=p_tenant_id and id=p_report_id for update;
 if not found then return jsonb_build_object('error','report_not_found'); end if;
 if r.content_text is null then return jsonb_build_object('error','legacy_report_requires_revision'); end if;
 if r.content_sha256<>p_expected_content_hash then return jsonb_build_object('error','manifest_changed'); end if;
 if r.status not in ('approved','published') then return jsonb_build_object('error','not_approved'); end if;
 select * into v_review from public.report_reviews where tenant_id=p_tenant_id and report_id=r.id;
 if not found or v_review.decision<>'approved' or v_review.content_sha256 is distinct from r.content_sha256
  or r.reviewed_content_hash is distinct from r.content_sha256 then return jsonb_build_object('error','not_approved'); end if;
 if r.kind in ('dpb','technical') then return jsonb_build_object('error','report_artifact_unverified'); end if;
 if r.kind='auditor' and not exists(
  select 1 from public.statutory_report_artifacts where tenant_id=p_tenant_id and report_id=r.id
 ) then return jsonb_build_object('error','report_artifact_unverified'); end if;
 if exists(select 1 from public.statutory_report_artifacts where tenant_id=p_tenant_id and report_id=r.id) then
  select * into sr from public.statutory_report_requests where tenant_id=p_tenant_id and report_id=r.id;
  select * into srs from public.statutory_request_sources where tenant_id=p_tenant_id and request_id=sr.id;
  select * into sa from public.statutory_report_artifacts where tenant_id=p_tenant_id and report_id=r.id;
  select * into sb from public.statutory_artifact_builds where tenant_id=p_tenant_id and report_id=r.id;
  if sr.id is null or srs.request_id is null or sb.id is null then return jsonb_build_object('error','report_artifact_unverified'); end if;
  if r.generated_by_agent<>'statutory-report-builder' or r.kind is distinct from sr.kind
   or sr.operation_key is distinct from r.operation_key or sr.engagement_id is distinct from r.engagement_id
   or r.content->>'source_sha256' is distinct from srs.source_sha256
   or r.content->>'assessment_run_id' is distinct from sr.assessment_run_id::text
   or r.content->>'assessment_result_digest' is distinct from sr.assessment_result_digest
   or r.content->>'library_digest' is distinct from sr.library_digest
   or srs.source_sha256 is distinct from encode(sha256(convert_to(srs.source_text,'UTF8')),'hex')
   or sa.source_json_sha256 is distinct from srs.source_sha256
   or sa.source_json_bytes is distinct from octet_length(srs.source_text)
   or sb.status<>'settled' or sb.source_sha256 is distinct from srs.source_sha256
   or sb.content_sha256 is distinct from r.content_sha256
   or sb.review_id is distinct from v_review.id or sb.review_sha256 is distinct from v_review.review_sha256
   then return jsonb_build_object('error','build_not_settled'); end if;
  select * into ss from public.statutory_artifact_versions where tenant_id=p_tenant_id and build_id=sb.id and artifact_kind='source_json';
  select * into spdf from public.statutory_artifact_versions where tenant_id=p_tenant_id and build_id=sb.id and artifact_kind='statutory_pdf';
  if ss.id is null or spdf.id is null or ss.content_hash is distinct from srs.source_sha256
   or ss.byte_size is distinct from octet_length(srs.source_text)
   or ss.content_hash is distinct from sb.request#>>'{artifacts,0,content_hash}'
   or spdf.content_hash is distinct from sb.request#>>'{artifacts,1,content_hash}'
   then return jsonb_build_object('error','build_not_settled'); end if;
  if p_expected_archive_hash is distinct from spdf.content_hash then return jsonb_build_object('error','archive_hash_mismatch'); end if;
 else
 if r.generated_by_agent in ('prativedan','board-report-builder')
  or exists(select 1 from public.board_report_artifacts where tenant_id=p_tenant_id and report_id=r.id) then
  select * into req from public.board_report_requests where tenant_id=p_tenant_id and report_id=r.id;
  select * into src from public.board_request_sources where tenant_id=p_tenant_id and request_id=req.id;
  select * into b from public.board_artifact_builds where tenant_id=p_tenant_id and report_id=r.id;
  if b.id is null then return jsonb_build_object('error','report_artifact_unverified'); end if;
  if req.id is null or src.request_id is null or b.status<>'settled'
   or b.source_sha256 is distinct from src.source_sha256 or b.content_sha256 is distinct from r.content_sha256
   or b.review_id is distinct from v_review.id or b.review_sha256 is distinct from v_review.review_sha256
   then return jsonb_build_object('error','build_not_settled'); end if;
  select * into s from public.board_artifact_versions where tenant_id=p_tenant_id and build_id=b.id and artifact_kind='source_json';
  select * into pdf from public.board_artifact_versions where tenant_id=p_tenant_id and build_id=b.id and artifact_kind='board_pdf';
  if s.id is null or pdf.id is null or s.content_hash is distinct from src.source_sha256
   or s.byte_size is distinct from octet_length(src.source_text)
   or s.content_hash is distinct from b.request#>>'{artifacts,0,content_hash}'
   or pdf.content_hash is distinct from b.request#>>'{artifacts,1,content_hash}'
   then return jsonb_build_object('error','build_not_settled'); end if;
  if p_expected_archive_hash is distinct from pdf.content_hash then return jsonb_build_object('error','archive_hash_mismatch'); end if;
 else
  select * into p from public.evidence_packs where tenant_id=p_tenant_id and report_id=r.id;
  if found then
   select a0.* into a from public.evidence_pack_archives a0 join public.evidence_pack_builds eb on eb.tenant_id=a0.tenant_id and eb.id=a0.build_id
    where a0.tenant_id=p_tenant_id and a0.pack_id=p.id and eb.status='settled';
   if not found then return jsonb_build_object('error','build_not_settled'); end if;
   if p_expected_archive_hash is distinct from a.content_hash then return jsonb_build_object('error','archive_hash_mismatch'); end if;
  elsif p_expected_archive_hash is not null then return jsonb_build_object('error','archive_hash_mismatch'); end if;
 end if;
 end if;
 if r.status='published' then
  if r.released_content_hash is distinct from p_expected_content_hash or r.released_archive_hash is distinct from p_expected_archive_hash
   then return jsonb_build_object('error','idempotency_conflict'); end if;
  return jsonb_build_object('reportId',r.id,'status','published','contentHash',r.released_content_hash,
   'archiveHash',r.released_archive_hash,'replayed',true);
 end if;
 update public.reports set status='published',published_at=v_time,released_by=p_released_by,released_content_hash=r.content_sha256,
  released_archive_hash=p_expected_archive_hash where tenant_id=p_tenant_id and id=r.id;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_released_by::text,null,null,null,'report.released',r.id::text,
  null,null,null,null,null,null,'success',jsonb_build_object('content_hash',r.content_sha256,'archive_hash',p_expected_archive_hash,'review_id',v_review.id));
 return jsonb_build_object('reportId',r.id,'status','published','contentHash',r.content_sha256,'archiveHash',p_expected_archive_hash,'replayed',false);
end $$;

revoke all on function public.begin_statutory_artifact_build(uuid,uuid,uuid,uuid,jsonb,uuid),
 public.settle_statutory_artifact_version(uuid,uuid,uuid,text,jsonb,uuid),
 public.note_statutory_artifact_failure(uuid,uuid,uuid,text,uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.begin_statutory_artifact_build(uuid,uuid,uuid,uuid,jsonb,uuid),
 public.settle_statutory_artifact_version(uuid,uuid,uuid,text,jsonb,uuid),
 public.note_statutory_artifact_failure(uuid,uuid,uuid,text,uuid) to service_role;
revoke all on function public.release_report(uuid,uuid,uuid,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.release_report(uuid,uuid,uuid,text,text,uuid) to service_role;
