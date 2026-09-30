-- Board publication requires two independently read-back, versioned objects.
-- These rows bind trusted controller receipts; SQL alone cannot verify S3 bytes.
-- A pending build keeps its fixed keys and deadline. Reconciliation reads exact
-- provider versions; a new PUT needs a separate founder retry after confirmed
-- absence. Unknown provider state remains pending, never silently re-PUT.
alter type public.ledger_action_type add value if not exists 'report.artifacts.started';
alter type public.ledger_action_type add value if not exists 'report.artifact.settled';
alter type public.ledger_action_type add value if not exists 'report.artifacts.pending';

create table public.board_artifact_builds (
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
create table public.board_artifact_versions (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete restrict,
 report_id uuid not null, build_id uuid not null,
 artifact_kind text not null check(artifact_kind in ('source_json','board_pdf')),
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
 foreign key(tenant_id,build_id,report_id) references public.board_artifact_builds(tenant_id,id,report_id) on delete restrict,
 check((artifact_kind='source_json' and mime_type='application/json' and byte_size<=4194304) or
       (artifact_kind='board_pdf' and mime_type='application/pdf'))
);
create index board_artifact_builds_pending on public.board_artifact_builds(tenant_id,created_at) where status='pending';
alter table public.board_artifact_builds enable row level security;
alter table public.board_artifact_versions enable row level security;
revoke all on public.board_artifact_builds,public.board_artifact_versions from public,anon,authenticated,service_role;
grant select on public.board_artifact_builds,public.board_artifact_versions to service_role;
create policy board_artifact_build_service_read on public.board_artifact_builds for select to service_role using(true);
create policy board_artifact_version_service_read on public.board_artifact_versions for select to service_role using(true);
create trigger board_artifact_build_immutable before update or delete on public.board_artifact_builds
 for each row execute function public.pack_build_immutable();
create trigger board_artifact_version_immutable before update or delete on public.board_artifact_versions
 for each row execute function public.evidence_receipt_immutable();

create function public.begin_board_artifact_build(p_tenant_id uuid,p_actor_id uuid,p_report_id uuid,
 p_operation_key uuid,p_request jsonb,p_correlation_id uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare r public.reports; req public.board_report_requests; src public.board_request_sources;
 a public.board_report_artifacts; rev public.report_reviews; b public.board_artifact_builds;
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
 if not found or r.kind<>'board' or r.generated_by_agent<>'board-report-builder' then return jsonb_build_object('error','report_not_found'); end if;
 select * into req from public.board_report_requests where tenant_id=p_tenant_id and report_id=r.id;
 select * into src from public.board_request_sources where tenant_id=p_tenant_id and request_id=req.id;
 select * into a from public.board_report_artifacts where tenant_id=p_tenant_id and report_id=r.id;
 select * into rev from public.report_reviews where tenant_id=p_tenant_id and report_id=r.id;
 if req.id is null or src.request_id is null or a.id is null or req.operation_key is distinct from r.operation_key
  or req.engagement_id is distinct from r.engagement_id or req.title is distinct from r.title
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
  kind:=case idx when 0 then 'source_json' else 'board_pdf' end;
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
 select * into b from public.board_artifact_builds where tenant_id=p_tenant_id and report_id=r.id for update;
 if found then
  if b.operation_key is distinct from p_operation_key or b.request is distinct from p_request then return jsonb_build_object('error','idempotency_conflict'); end if;
  return jsonb_build_object('buildId',b.id,'reportId',r.id,'operationKey',b.operation_key,'status',b.status,
   'request',b.request,'retainUntil',b.retain_until,'correlationId',b.correlation_id,'replayed',true);
 end if;
 if r.status<>'approved' then return jsonb_build_object('error','not_approved'); end if;
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||p_operation_key::text,0));
 if exists(select 1 from public.board_artifact_builds where tenant_id=p_tenant_id and operation_key=p_operation_key)
  then return jsonb_build_object('error','idempotency_conflict'); end if;
 insert into public.board_artifact_builds(tenant_id,report_id,operation_key,actor_id,review_id,source_sha256,
  content_sha256,review_sha256,request,retain_until,correlation_id)
 values(p_tenant_id,r.id,p_operation_key,p_actor_id,rev.id,src.source_sha256,r.content_sha256,rev.review_sha256,
  p_request,date_trunc('second',clock_timestamp()+interval '7 years')+interval '1 second',p_correlation_id) returning * into b;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
  'report.artifacts.started'::public.ledger_action_type,r.id::text,null,null,null,null,null,null,'success',
  jsonb_build_object('build_id',b.id,'source_sha256',b.source_sha256,'pdf_sha256',p_request#>>'{artifacts,1,content_hash}','review_id',rev.id));
 return jsonb_build_object('buildId',b.id,'reportId',r.id,'operationKey',b.operation_key,'status',b.status,
  'request',b.request,'retainUntil',b.retain_until,'correlationId',b.correlation_id,'replayed',false);
end $$;

create function public.settle_board_artifact_version(p_tenant_id uuid,p_actor_id uuid,p_build_id uuid,
 p_artifact_kind text,p_receipt jsonb,p_correlation_id uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare b public.board_artifact_builds;r public.reports;item jsonb;existing public.board_artifact_versions;
 v_id uuid;v_until timestamptz;v_readback timestamptz;v_field text;v_status text;v_count integer;
begin
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','founder_authority_required'); end if;
 if p_correlation_id is null or p_artifact_kind not in ('source_json','board_pdf') or p_receipt is null
  or jsonb_typeof(p_receipt)<>'object' or octet_length(p_receipt::text)>16384 then return jsonb_build_object('error','invalid_receipt'); end if;
 select * into b from public.board_artifact_builds where tenant_id=p_tenant_id and id=p_build_id;
 if not found then return jsonb_build_object('error','operation_not_found'); end if;
 select * into r from public.reports where tenant_id=p_tenant_id and id=b.report_id for update;
 select * into b from public.board_artifact_builds where tenant_id=p_tenant_id and id=p_build_id for update;
 select * into existing from public.board_artifact_versions where tenant_id=p_tenant_id and build_id=b.id and artifact_kind=p_artifact_kind;
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
  or p_receipt->>'collected_by_agent' is distinct from 'board-report-builder'
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
 insert into public.board_artifact_versions(tenant_id,report_id,build_id,artifact_kind,provider,bucket,object_key,
  version_id,content_hash,byte_size,mime_type,retain_until,readback_at,lock_mode,legal_hold,encryption,receipt,verified_by)
 values(p_tenant_id,b.report_id,b.id,p_artifact_kind,p_receipt->>'provider',p_receipt->>'bucket',p_receipt->>'object_key',
  p_receipt->>'version_id',p_receipt->>'content_hash',(p_receipt->>'byte_size')::bigint,item->>'mime_type',
  v_until,v_readback,'COMPLIANCE',false,p_receipt->>'encryption',p_receipt,p_actor_id) returning id into v_id;
 select count(*) into v_count from public.board_artifact_versions where tenant_id=p_tenant_id and build_id=b.id;
 v_status:=case when v_count=2 then 'settled' else 'pending' end;
 update public.board_artifact_builds set status=v_status,last_error_code=null,
  settled_at=case when v_count=2 then clock_timestamp() else null end,updated_at=clock_timestamp()
  where tenant_id=p_tenant_id and id=b.id;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
  'report.artifact.settled'::public.ledger_action_type,b.report_id::text,null,null,null,null,null,null,'success',
  jsonb_build_object('build_id',b.id,'artifact_id',v_id,'artifact_kind',p_artifact_kind,
   'content_hash',p_receipt->>'content_hash','version_id',p_receipt->>'version_id'));
 return jsonb_build_object('buildId',b.id,'reportId',b.report_id,'artifactKind',p_artifact_kind,
  'artifactId',v_id,'status',v_status,'replayed',false);
end $$;

create function public.note_board_artifact_failure(p_tenant_id uuid,p_actor_id uuid,p_build_id uuid,
 p_error_code text,p_correlation_id uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare b public.board_artifact_builds;r public.reports;
begin
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','founder_authority_required'); end if;
 if p_correlation_id is null or p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,79}$'
  then return jsonb_build_object('error','invalid_request'); end if;
 select * into b from public.board_artifact_builds where tenant_id=p_tenant_id and id=p_build_id;
 if not found then return jsonb_build_object('error','operation_not_found'); end if;
 select * into r from public.reports where tenant_id=p_tenant_id and id=b.report_id for update;
 select * into b from public.board_artifact_builds where tenant_id=p_tenant_id and id=p_build_id for update;
 if b.status='pending' and b.last_error_code is distinct from p_error_code then
  update public.board_artifact_builds set last_error_code=p_error_code,updated_at=clock_timestamp() where id=b.id;
  perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
   'report.artifacts.pending'::public.ledger_action_type,b.report_id::text,null,null,null,null,null,null,'failure',
   jsonb_build_object('build_id',b.id,'error_code',p_error_code));
 end if;
 return jsonb_build_object('buildId',b.id,'reportId',b.report_id,'status',b.status,
  'lastErrorCode',case when b.status='pending' then p_error_code else null end);
end $$;

-- Preserve the existing evidence-pack branch and statutory fail-closed gate.
create or replace function public.release_report(p_tenant_id uuid,p_report_id uuid,p_released_by uuid,
 p_expected_content_hash text,p_expected_archive_hash text,p_correlation_id uuid)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.reports;p public.evidence_packs;a public.evidence_pack_archives;v_review public.report_reviews;
 b public.board_artifact_builds;s public.board_artifact_versions;pdf public.board_artifact_versions;
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
 if exists(select 1 from public.statutory_report_artifacts where tenant_id=p_tenant_id and report_id=r.id)
  then return jsonb_build_object('error','report_artifact_unverified'); end if;
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

revoke all on function public.begin_board_artifact_build(uuid,uuid,uuid,uuid,jsonb,uuid),
 public.settle_board_artifact_version(uuid,uuid,uuid,text,jsonb,uuid),
 public.note_board_artifact_failure(uuid,uuid,uuid,text,uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.begin_board_artifact_build(uuid,uuid,uuid,uuid,jsonb,uuid),
 public.settle_board_artifact_version(uuid,uuid,uuid,text,jsonb,uuid),
 public.note_board_artifact_failure(uuid,uuid,uuid,text,uuid) to service_role;
revoke all on function public.release_report(uuid,uuid,uuid,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.release_report(uuid,uuid,uuid,text,text,uuid) to service_role;
