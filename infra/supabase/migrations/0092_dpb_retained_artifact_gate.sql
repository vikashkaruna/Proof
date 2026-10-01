-- DPB review packs need exact Compliance-locked source and PDF versions.
-- SQL records trusted controller receipts; the BFF must read back provider bytes.
create table public.dpb_artifact_builds (
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
 unique(tenant_id,id),unique(tenant_id,id,report_id),unique(tenant_id,operation_key),
 foreign key(tenant_id,report_id) references public.reports(tenant_id,id) on delete restrict,
 foreign key(tenant_id,review_id) references public.report_reviews(tenant_id,id) on delete restrict,
 check((status='pending' and settled_at is null) or (status='settled' and settled_at is not null))
);
create table public.dpb_artifact_versions (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id) on delete restrict,
 report_id uuid not null,build_id uuid not null,
 artifact_kind text not null check(artifact_kind in ('source_json','dpb_pdf')),
 provider text not null check(provider in ('s3','s3-compatible')),bucket text not null,object_key text not null,
 version_id text not null check(length(version_id) between 1 and 1024 and btrim(version_id)<>'' and version_id<>'null'),
 content_hash text not null check(content_hash ~ '^[0-9a-f]{64}$'),
 byte_size bigint not null check(byte_size between 1 and 33554432),mime_type text not null,
 retain_until timestamptz not null,readback_at timestamptz not null,
 lock_mode text not null check(lock_mode='COMPLIANCE'),legal_hold boolean not null check(legal_hold=false),
 encryption text not null check(encryption in ('AES256','aws:kms')),
 receipt jsonb not null,verified_by uuid not null references public.users(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp(),unique(tenant_id,id),
 unique(tenant_id,report_id,artifact_kind),unique(tenant_id,build_id,artifact_kind),
 unique(provider,bucket,object_key,version_id),
 foreign key(tenant_id,report_id) references public.reports(tenant_id,id) on delete restrict,
 foreign key(tenant_id,build_id,report_id) references public.dpb_artifact_builds(tenant_id,id,report_id) on delete restrict,
 check((artifact_kind='source_json' and mime_type='application/json' and byte_size<=4194304) or
       (artifact_kind='dpb_pdf' and mime_type='application/pdf'))
);
alter table public.dpb_artifact_builds enable row level security;
alter table public.dpb_artifact_versions enable row level security;
revoke all on public.dpb_artifact_builds,public.dpb_artifact_versions from public,anon,authenticated,service_role;
grant select on public.dpb_artifact_builds,public.dpb_artifact_versions to service_role;
create policy dpb_build_service_read on public.dpb_artifact_builds for select to service_role using(true);
create policy dpb_version_service_read on public.dpb_artifact_versions for select to service_role using(true);
create trigger dpb_build_immutable before update or delete on public.dpb_artifact_builds
 for each row execute function public.pack_build_immutable();
create trigger dpb_version_immutable before update or delete on public.dpb_artifact_versions
 for each row execute function public.evidence_receipt_immutable();

create function public.begin_dpb_artifact_build(p_tenant_id uuid,p_actor_id uuid,p_report_id uuid,
 p_operation_key uuid,p_request jsonb,p_correlation_id uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare r public.reports;req public.dpb_report_requests;src public.dpb_request_sources;
 rev public.report_reviews;b public.dpb_artifact_builds;item jsonb;idx integer;
begin
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','founder_authority_required'); end if;
 if p_report_id is null or p_operation_key is null or p_correlation_id is null or p_request is null
  or jsonb_typeof(p_request)<>'object' or octet_length(p_request::text)>16384
  or not(p_request ?& array['provider','bucket','retention_policy','legal_hold','source_sha256','content_sha256','review_sha256','renderer_version','artifacts'])
  or p_request-array['provider','bucket','retention_policy','legal_hold','source_sha256','content_sha256','review_sha256','renderer_version','artifacts']<>'{}'::jsonb
  or p_request->>'provider' is null or p_request->>'provider' not in ('s3','s3-compatible')
  or p_request->>'retention_policy' is distinct from 'seven_years'
  or p_request->'legal_hold' is distinct from 'false'::jsonb
  or length(coalesce(p_request->>'bucket','')) not between 3 and 255
  or p_request->>'bucket' !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]+$'
  or p_request->>'renderer_version' is distinct from 'chromium-dpb-v1'
  or (case when jsonb_typeof(p_request->'artifacts')='array'
      then jsonb_array_length(p_request->'artifacts') else -1 end)<>2
  then return jsonb_build_object('error','invalid_request'); end if;
 select * into r from public.reports where tenant_id=p_tenant_id and id=p_report_id for update;
 if not found then return jsonb_build_object('error','report_not_found'); end if;
 if r.kind<>'dpb' or r.generated_by_agent<>'dpb-report-builder' then return jsonb_build_object('error','report_kind_invalid'); end if;
 if r.status not in ('approved','published') then return jsonb_build_object('error','not_approved'); end if;
 select * into req from public.dpb_report_requests where tenant_id=p_tenant_id and report_id=r.id;
 select * into src from public.dpb_request_sources where tenant_id=p_tenant_id and request_id=req.id;
 select * into rev from public.report_reviews where tenant_id=p_tenant_id and report_id=r.id;
 if req.id is null or src.request_id is null or rev.id is null or rev.decision<>'approved'
  or rev.content_sha256 is distinct from r.content_sha256 or r.reviewed_content_hash is distinct from r.content_sha256
  or p_request->>'source_sha256' is distinct from src.source_sha256
  or p_request->>'content_sha256' is distinct from r.content_sha256
  or p_request->>'review_sha256' is distinct from rev.review_sha256
  then return jsonb_build_object('error','source_or_review_mismatch'); end if;
 for idx in 0..1 loop
  item:=p_request->'artifacts'->idx;
  if jsonb_typeof(item) is distinct from 'object' or not(item ?& array['kind','mime_type','content_hash','byte_size','object_key'])
   or item-array['kind','mime_type','content_hash','byte_size','object_key']<>'{}'::jsonb
   or item->>'kind' is distinct from (case idx when 0 then 'source_json' else 'dpb_pdf' end)
   or item->>'mime_type' is distinct from (case idx when 0 then 'application/json' else 'application/pdf' end)
   or coalesce(item->>'content_hash','') !~ '^[0-9a-f]{64}$'
   or jsonb_typeof(item->'byte_size') is distinct from 'number'
   or coalesce(item->>'byte_size','') !~ '^[0-9]{1,8}$'
   or (item->>'byte_size')::bigint not between 1 and 33554432
   or length(coalesce(item->>'object_key','')) not between 1 and 1024
   or item->>'object_key' !~ '^reports/dpb/[0-9a-f-]{36}/[0-9a-f-]{36}/(source_json|dpb_pdf)/[0-9a-f]{64}$'
   or split_part(item->>'object_key','/',3)<>p_tenant_id::text
   or split_part(item->>'object_key','/',4)<>p_report_id::text
   or split_part(item->>'object_key','/',6)<>item->>'content_hash'
   or (idx=0 and (item->>'content_hash'<>src.source_sha256 or (item->>'byte_size')::bigint<>octet_length(src.source_text)))
   then return jsonb_build_object('error','artifact_request_mismatch'); end if;
 end loop;
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||p_operation_key::text,0));
 select * into b from public.dpb_artifact_builds where tenant_id=p_tenant_id and report_id=p_report_id for update;
 if found then
  if b.operation_key<>p_operation_key or b.request<>p_request then return jsonb_build_object('error','idempotency_conflict'); end if;
  return jsonb_build_object('buildId',b.id,'reportId',b.report_id,'status',b.status,'replayed',true);
 end if;
 insert into public.dpb_artifact_builds(tenant_id,report_id,operation_key,actor_id,review_id,
  source_sha256,content_sha256,review_sha256,request,retain_until,correlation_id)
 values(p_tenant_id,p_report_id,p_operation_key,p_actor_id,rev.id,src.source_sha256,r.content_sha256,
  rev.review_sha256,p_request,clock_timestamp()+interval '2555 days',p_correlation_id) returning * into b;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
  'report.artifacts.started'::public.ledger_action_type,p_report_id::text,null,null,null,null,null,null,'success',
  jsonb_build_object('build_id',b.id,'source_sha256',src.source_sha256,'review_id',rev.id));
 return jsonb_build_object('buildId',b.id,'reportId',b.report_id,'status','pending','replayed',false);
end $$;
revoke all on function public.begin_dpb_artifact_build(uuid,uuid,uuid,uuid,jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.begin_dpb_artifact_build(uuid,uuid,uuid,uuid,jsonb,uuid) to statutory_proof_writer;

create function public.settle_dpb_artifact_version(p_tenant_id uuid,p_actor_id uuid,p_build_id uuid,
 p_artifact_kind text,p_receipt jsonb,p_correlation_id uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare b public.dpb_artifact_builds;existing public.dpb_artifact_versions;item jsonb;
 v_until timestamptz;v_readback timestamptz;v_id uuid;v_count integer;v_status text;
begin
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','founder_authority_required'); end if;
 if p_build_id is null or p_correlation_id is null or p_artifact_kind is null
  or p_artifact_kind not in ('source_json','dpb_pdf')
  or p_receipt is null or jsonb_typeof(p_receipt)<>'object' or octet_length(p_receipt::text)>8192
  or not(p_receipt ?& array['provider','bucket','object_key','version_id','content_hash','byte_size','mime_type','retain_until','readback_at','lock_mode','legal_hold','encryption'])
  or p_receipt-array['provider','bucket','object_key','version_id','content_hash','byte_size','mime_type','retain_until','readback_at','lock_mode','legal_hold','encryption']<>'{}'::jsonb
  then return jsonb_build_object('error','invalid_receipt'); end if;
 select * into b from public.dpb_artifact_builds where tenant_id=p_tenant_id and id=p_build_id for update;
 if not found then return jsonb_build_object('error','operation_not_found'); end if;
 select * into existing from public.dpb_artifact_versions where tenant_id=p_tenant_id and build_id=b.id and artifact_kind=p_artifact_kind;
 if found then
  if existing.receipt is distinct from p_receipt then return jsonb_build_object('error','receipt_conflict'); end if;
  return jsonb_build_object('buildId',b.id,'artifactId',existing.id,'status',b.status,'replayed',true);
 end if;
 item:=b.request->'artifacts'->(case when p_artifact_kind='source_json' then 0 else 1 end);
 if p_receipt->>'provider' is distinct from b.request->>'provider' or p_receipt->>'bucket' is distinct from b.request->>'bucket'
  or p_receipt->>'object_key' is distinct from item->>'object_key'
  or p_receipt->>'content_hash' is distinct from item->>'content_hash'
  or p_receipt->>'mime_type' is distinct from item->>'mime_type'
  or jsonb_typeof(p_receipt->'byte_size') is distinct from 'number'
  or p_receipt->>'byte_size' is distinct from item->>'byte_size'
  or p_receipt->>'lock_mode' is distinct from 'COMPLIANCE' or p_receipt->'legal_hold' is distinct from 'false'::jsonb
  or p_receipt->>'encryption' is null or p_receipt->>'encryption' not in ('AES256','aws:kms')
  or length(coalesce(p_receipt->>'version_id','')) not between 1 and 1024
  or p_receipt->>'version_id'='null' then return jsonb_build_object('error','receipt_mismatch'); end if;
 begin v_until:=(p_receipt->>'retain_until')::timestamptz;v_readback:=(p_receipt->>'readback_at')::timestamptz;
 exception when invalid_datetime_format or datetime_field_overflow then return jsonb_build_object('error','invalid_receipt'); end;
 if v_until is null or not isfinite(v_until) or v_until<b.retain_until
  or v_readback is null or not isfinite(v_readback) or v_readback<clock_timestamp()-interval '5 minutes'
  or v_readback>clock_timestamp()+interval '5 minutes' then return jsonb_build_object('error','receipt_mismatch'); end if;
 insert into public.dpb_artifact_versions(tenant_id,report_id,build_id,artifact_kind,provider,bucket,object_key,
  version_id,content_hash,byte_size,mime_type,retain_until,readback_at,lock_mode,legal_hold,encryption,receipt,verified_by)
 values(p_tenant_id,b.report_id,b.id,p_artifact_kind,p_receipt->>'provider',p_receipt->>'bucket',p_receipt->>'object_key',
  p_receipt->>'version_id',p_receipt->>'content_hash',(p_receipt->>'byte_size')::bigint,item->>'mime_type',
  v_until,v_readback,'COMPLIANCE',false,p_receipt->>'encryption',p_receipt,p_actor_id) returning id into v_id;
 select count(*) into v_count from public.dpb_artifact_versions where tenant_id=p_tenant_id and build_id=b.id;
 v_status:=case when v_count=2 then 'settled' else 'pending' end;
 update public.dpb_artifact_builds set status=v_status,last_error_code=null,
  settled_at=case when v_count=2 then clock_timestamp() else null end,updated_at=clock_timestamp() where id=b.id;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
  'report.artifact.settled'::public.ledger_action_type,b.report_id::text,null,null,null,null,null,null,'success',
  jsonb_build_object('build_id',b.id,'artifact_id',v_id,'artifact_kind',p_artifact_kind,
   'content_hash',p_receipt->>'content_hash','version_id',p_receipt->>'version_id'));
 return jsonb_build_object('buildId',b.id,'reportId',b.report_id,'artifactId',v_id,'status',v_status,'replayed',false);
end $$;
revoke all on function public.settle_dpb_artifact_version(uuid,uuid,uuid,text,jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.settle_dpb_artifact_version(uuid,uuid,uuid,text,jsonb,uuid) to statutory_proof_writer;

create function public.note_dpb_artifact_failure(p_tenant_id uuid,p_actor_id uuid,p_build_id uuid,
 p_error_code text,p_correlation_id uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare b public.dpb_artifact_builds;
begin
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','founder_authority_required'); end if;
 if p_correlation_id is null or p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,79}$'
  then return jsonb_build_object('error','invalid_request'); end if;
 select * into b from public.dpb_artifact_builds where tenant_id=p_tenant_id and id=p_build_id for update;
 if not found then return jsonb_build_object('error','operation_not_found'); end if;
 if b.status='pending' and b.last_error_code is distinct from p_error_code then
  update public.dpb_artifact_builds set last_error_code=p_error_code,updated_at=clock_timestamp() where id=b.id;
  perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
   'report.artifacts.pending'::public.ledger_action_type,b.report_id::text,null,null,null,null,null,null,'failure',
   jsonb_build_object('build_id',b.id,'error_code',p_error_code));
 end if;
 return jsonb_build_object('buildId',b.id,'reportId',b.report_id,'status',b.status,
  'lastErrorCode',case when b.status='pending' then p_error_code else null end);
end $$;
revoke all on function public.note_dpb_artifact_failure(uuid,uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.note_dpb_artifact_failure(uuid,uuid,uuid,text,uuid) to statutory_proof_writer;

create function public.release_dpb_report(p_tenant_id uuid,p_report_id uuid,p_actor_id uuid,
 p_expected_content_hash text,p_expected_pdf_hash text,p_correlation_id uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare r public.reports;req public.dpb_report_requests;src public.dpb_request_sources;
 rev public.report_reviews;b public.dpb_artifact_builds;s public.dpb_artifact_versions;pdf public.dpb_artifact_versions;
begin
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','founder_authority_required'); end if;
 if p_report_id is null or p_correlation_id is null or p_expected_content_hash is null
  or p_expected_pdf_hash is null or p_expected_content_hash !~ '^[0-9a-f]{64}$'
  or p_expected_pdf_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('error','invalid_request'); end if;
 select * into r from public.reports where tenant_id=p_tenant_id and id=p_report_id for update;
 if not found then return jsonb_build_object('error','report_not_found'); end if;
 if r.kind<>'dpb' or r.generated_by_agent<>'dpb-report-builder' then return jsonb_build_object('error','report_kind_invalid'); end if;
 if r.status not in ('approved','published') or r.content_text is null then return jsonb_build_object('error','not_approved'); end if;
 select * into req from public.dpb_report_requests where tenant_id=p_tenant_id and report_id=r.id;
 select * into src from public.dpb_request_sources where tenant_id=p_tenant_id and request_id=req.id;
 select * into rev from public.report_reviews where tenant_id=p_tenant_id and report_id=r.id;
 select * into b from public.dpb_artifact_builds where tenant_id=p_tenant_id and report_id=r.id;
 if req.id is null or src.request_id is null or rev.id is null or rev.decision<>'approved'
  or rev.content_sha256 is distinct from r.content_sha256 or r.reviewed_content_hash is distinct from r.content_sha256
  or b.id is null or b.status<>'settled' or b.review_id is distinct from rev.id
  or b.source_sha256 is distinct from src.source_sha256 or b.content_sha256 is distinct from r.content_sha256
  or b.review_sha256 is distinct from rev.review_sha256 then return jsonb_build_object('error','build_not_settled'); end if;
 select * into s from public.dpb_artifact_versions where tenant_id=p_tenant_id and build_id=b.id and artifact_kind='source_json';
 select * into pdf from public.dpb_artifact_versions where tenant_id=p_tenant_id and build_id=b.id and artifact_kind='dpb_pdf';
 if s.id is null or pdf.id is null or s.content_hash<>src.source_sha256
  or s.byte_size<>octet_length(src.source_text) or pdf.content_hash<>p_expected_pdf_hash
  or r.content_sha256<>p_expected_content_hash
  or s.retain_until<b.retain_until or pdf.retain_until<b.retain_until
  or s.lock_mode<>'COMPLIANCE' or pdf.lock_mode<>'COMPLIANCE'
  then return jsonb_build_object('error','artifact_mismatch'); end if;
 if r.status='published' then
  if r.released_content_hash is distinct from p_expected_content_hash
   or r.released_archive_hash is distinct from p_expected_pdf_hash
   then return jsonb_build_object('error','idempotency_conflict'); end if;
  return jsonb_build_object('reportId',r.id,'status','published','replayed',true);
 end if;
 update public.reports set status='published',published_at=clock_timestamp(),released_by=p_actor_id,
  released_content_hash=p_expected_content_hash,released_archive_hash=p_expected_pdf_hash
  where tenant_id=p_tenant_id and id=p_report_id;
 update public.dpb_report_requests set status='released',updated_at=clock_timestamp() where id=req.id;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
  'report.released'::public.ledger_action_type,r.id::text,null,null,null,null,null,null,'success',
  jsonb_build_object('content_hash',p_expected_content_hash,'pdf_hash',p_expected_pdf_hash,
   'review_id',rev.id,'source_version_id',s.version_id,'pdf_version_id',pdf.version_id));
 return jsonb_build_object('reportId',r.id,'status','published','replayed',false);
end $$;
revoke all on function public.release_dpb_report(uuid,uuid,uuid,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.release_dpb_report(uuid,uuid,uuid,text,text,uuid) to statutory_proof_writer;

-- The generic release RPC predates this subtype. A row-level guard makes it
-- impossible to publish a DPB builder report by bypassing the dedicated gate.
create function public.dpb_report_publish_guard() returns trigger
 language plpgsql security definer set search_path='' as $$
declare b public.dpb_artifact_builds;rev public.report_reviews;s public.dpb_artifact_versions;pdf public.dpb_artifact_versions;
begin
 if new.kind<>'dpb' or new.generated_by_agent<>'dpb-report-builder' or new.status<>'published'
  or old.status='published' then return new; end if;
 select * into b from public.dpb_artifact_builds where tenant_id=new.tenant_id and report_id=new.id;
 select * into rev from public.report_reviews where tenant_id=new.tenant_id and report_id=new.id;
 select * into s from public.dpb_artifact_versions where tenant_id=new.tenant_id and build_id=b.id and artifact_kind='source_json';
 select * into pdf from public.dpb_artifact_versions where tenant_id=new.tenant_id and build_id=b.id and artifact_kind='dpb_pdf';
 if b.id is null or b.status<>'settled' or rev.id is null or rev.decision<>'approved'
  or b.review_id is distinct from rev.id or s.id is null or pdf.id is null
  or new.released_content_hash is distinct from b.content_sha256
  or new.released_archive_hash is distinct from pdf.content_hash
  then raise exception 'DPB exact-version release gate refused publication'; end if;
 return new;
end $$;
revoke all on function public.dpb_report_publish_guard() from public,anon,authenticated,service_role;
create trigger dpb_report_publish_guard before update on public.reports
 for each row execute function public.dpb_report_publish_guard();

-- The pre-existing generic release RPC has no provider readback. Preserve its
-- behavior for every other kind, but make DPB release enter the dedicated BFF
-- and SQL gate. Renaming retains the old function body; remove its service
-- execute grant so clients cannot call it under its new name.
alter function public.release_report(uuid,uuid,uuid,text,text,uuid) rename to release_report_pre_dpb;
revoke all on function public.release_report_pre_dpb(uuid,uuid,uuid,text,text,uuid)
 from public,anon,authenticated,service_role;
create function public.release_report(p_tenant_id uuid,p_report_id uuid,p_released_by uuid,
 p_expected_content_hash text,p_expected_archive_hash text,p_correlation_id uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.reports where tenant_id=p_tenant_id and id=p_report_id and kind='dpb')
  then return jsonb_build_object('error','source_bound_workflow_required'); end if;
 return public.release_report_pre_dpb(p_tenant_id,p_report_id,p_released_by,
  p_expected_content_hash,p_expected_archive_hash,p_correlation_id);
end $$;
revoke all on function public.release_report(uuid,uuid,uuid,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.release_report(uuid,uuid,uuid,text,text,uuid) to statutory_proof_writer;
