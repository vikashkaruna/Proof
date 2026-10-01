-- A technical register dossier derives only from a founder-released recorded-plan report. Historical dossier rows remain unverified metadata. Only these RPCs
-- may create or release a source-bound dossier; service_role has read access.
create table public.pramaan_technical_builds (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 dossier_id uuid not null unique,
 report_id uuid not null,
 source_build_id uuid not null,
 source_version_id uuid not null,
 pdf_version_id uuid not null,
 operation_key uuid not null,
 requested_by uuid not null references public.users(id) on delete restrict,
 request jsonb not null check(jsonb_typeof(request)='object' and octet_length(request::text)<=16384),
 retain_until timestamptz not null,
 correlation_id uuid not null,
 status text not null default 'pending' check(status in ('pending','settled')),
 last_error_code text,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 settled_at timestamptz,
 unique(tenant_id,id), unique(tenant_id,id,dossier_id), unique(tenant_id,dossier_id), unique(tenant_id,operation_key), unique(tenant_id,report_id),
 foreign key(tenant_id,dossier_id) references public.pramaan_dossiers(tenant_id,id) on delete restrict,
 foreign key(tenant_id,report_id) references public.reports(tenant_id,id) on delete restrict,
 foreign key(tenant_id,source_build_id,report_id) references public.technical_artifact_builds(tenant_id,id,report_id) on delete restrict,
 foreign key(tenant_id,source_version_id) references public.technical_artifact_versions(tenant_id,id) on delete restrict,
 foreign key(tenant_id,pdf_version_id) references public.technical_artifact_versions(tenant_id,id) on delete restrict,
 check((status='pending' and settled_at is null) or (status='settled' and settled_at is not null))
);
create table public.pramaan_technical_archives (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 dossier_id uuid not null,
 build_id uuid not null,
 provider text not null check(provider in ('s3','s3-compatible')),
 bucket text not null,
 object_key text not null,
 version_id text not null check(length(version_id) between 1 and 1024 and btrim(version_id)<>'' and version_id<>'null'),
 content_hash text not null check(content_hash ~ '^[0-9a-f]{64}$'),
 byte_size bigint not null check(byte_size between 1 and 67108864),
 retain_until timestamptz not null,
 readback_at timestamptz not null,
 lock_mode text not null check(lock_mode='COMPLIANCE'),
 legal_hold boolean not null check(legal_hold=false),
 encryption text not null check(encryption in ('AES256','aws:kms')),
 receipt jsonb not null,
 verified_by uuid not null references public.users(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,id), unique(tenant_id,dossier_id), unique(tenant_id,build_id),
 unique(provider,bucket,object_key,version_id),
 foreign key(tenant_id,dossier_id) references public.pramaan_dossiers(tenant_id,id) on delete restrict,
 foreign key(tenant_id,build_id,dossier_id) references public.pramaan_technical_builds(tenant_id,id,dossier_id) on delete restrict
);
alter table public.pramaan_technical_builds enable row level security;
alter table public.pramaan_technical_archives enable row level security;
revoke all on public.pramaan_technical_builds,public.pramaan_technical_archives from public,anon,authenticated,service_role;
grant select on public.pramaan_technical_builds,public.pramaan_technical_archives to service_role;
create policy pramaan_technical_build_service_read on public.pramaan_technical_builds for select to service_role using(true);
create policy pramaan_technical_archive_service_read on public.pramaan_technical_archives for select to service_role using(true);
create trigger pramaan_technical_build_immutable before update or delete on public.pramaan_technical_builds
 for each row execute function public.pack_build_immutable();
create trigger pramaan_technical_archive_immutable before update or delete on public.pramaan_technical_archives
 for each row execute function public.evidence_receipt_immutable();


create function public.begin_technical_pramaan(
 p_tenant_id uuid,p_actor_id uuid,p_report_id uuid,p_operation_key uuid,
 p_title text,p_request jsonb,p_correlation_id uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare r public.reports; b public.technical_artifact_builds; s public.technical_artifact_versions;
 pdf public.technical_artifact_versions; existing public.pramaan_technical_builds;
 req public.technical_report_requests; src public.technical_request_sources;
 v_dossier_id uuid; v_root text; v_proof text; v_retain timestamptz;
begin
 if not exists(select 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id
    and role in ('founder','owner','admin')) then return jsonb_build_object('error','manager_authority_required'); end if;
 if p_report_id is null or p_operation_key is null or p_correlation_id is null
   or p_title is null or length(btrim(p_title)) not between 1 and 300
   or p_request is null or jsonb_typeof(p_request)<>'object' or octet_length(p_request::text)>16384
   or not(p_request ?& array['provider','bucket','source_sha256','pdf_sha256','source_version_id',
     'pdf_version_id','manifest_sha256','archive_sha256','archive_bytes','object_key'])
   or (p_request-array['provider','bucket','source_sha256','pdf_sha256','source_version_id',
     'pdf_version_id','manifest_sha256','archive_sha256','archive_bytes','object_key'])<>'{}'::jsonb
   or p_request->>'provider' not in ('s3','s3-compatible')
   or jsonb_typeof(p_request->'bucket')<>'string' or length(p_request->>'bucket') not between 3 and 255
   or p_request->>'bucket' !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]+$'
   or p_request->>'source_sha256' !~ '^[0-9a-f]{64}$'
   or p_request->>'pdf_sha256' !~ '^[0-9a-f]{64}$'
   or p_request->>'manifest_sha256' !~ '^[0-9a-f]{64}$'
   or p_request->>'archive_sha256' !~ '^[0-9a-f]{64}$'
   or jsonb_typeof(p_request->'archive_bytes')<>'number'
   or p_request->>'archive_bytes' !~ '^[0-9]+$'
   or length(p_request->>'archive_bytes')>8
   or (p_request->>'archive_bytes')::bigint not between 1 and 67108864
   then return jsonb_build_object('error','invalid_request'); end if;
 select * into r from public.reports where tenant_id=p_tenant_id and id=p_report_id for update;
 if not found or r.kind<>'technical' or r.generated_by_agent<>'technical-report-builder'
   or r.status<>'published' then return jsonb_build_object('error','source_report_not_released'); end if;
 select * into req from public.technical_report_requests
   where tenant_id=p_tenant_id and report_id=r.id ;
 select * into src from public.technical_request_sources
   where tenant_id=p_tenant_id and request_id=req.id;
 select * into b from public.technical_artifact_builds where tenant_id=p_tenant_id and report_id=r.id;
 select * into s from public.technical_artifact_versions where tenant_id=p_tenant_id and build_id=b.id and artifact_kind='source_json';
 select * into pdf from public.technical_artifact_versions where tenant_id=p_tenant_id and build_id=b.id and artifact_kind='technical_pdf';
 if r.engagement_id is null or req.id is null or req.status<>'released'
   or src.source_text::jsonb#>>'{plan,id}' is distinct from req.plan_id::text
   or (src.source_text::jsonb->'plan'->>'engagement_id') is distinct from r.engagement_id::text
   or r.released_by is null or not exists(select 1 from public.audit_ledger l
     where l.tenant_id=p_tenant_id and l.action_type='report.released'
       and l.target_ref=r.id::text and l.result='success'
       and l.actor_type='human' and l.actor_id=r.released_by::text
       and l.detail->>'pdf_hash'=r.released_archive_hash
       and l.detail->>'content_hash'=r.content_sha256
       and l.detail->>'source_version_id'=s.version_id
       and l.detail->>'pdf_version_id'=pdf.version_id)
   or src.request_id is null or src.source_text::jsonb#>>'{plan,id}' is distinct from req.plan_id::text
   or src.source_text::jsonb#>>'{plan,engagement_id}' is distinct from r.engagement_id::text
   or src.source_sha256 is distinct from encode(sha256(convert_to(src.source_text,'UTF8')),'hex')
   or r.content->>'source_sha256' is distinct from src.source_sha256
   or r.released_content_hash is distinct from r.content_sha256
   or b.id is null or b.status<>'settled' or b.source_sha256 is distinct from src.source_sha256
   or b.content_sha256 is distinct from r.content_sha256
   or s.id is null or pdf.id is null or s.report_id is distinct from r.id
   or pdf.report_id is distinct from r.id or s.build_id is distinct from b.id
   or pdf.build_id is distinct from b.id or s.content_hash is distinct from src.source_sha256
   or s.byte_size is distinct from octet_length(src.source_text)
   or s.retain_until<b.retain_until or pdf.retain_until<b.retain_until
   or r.released_archive_hash is distinct from pdf.content_hash
   or s.content_hash is distinct from p_request->>'source_sha256'
   or pdf.content_hash is distinct from p_request->>'pdf_sha256'
   or s.id::text is distinct from p_request->>'source_version_id'
   or pdf.id::text is distinct from p_request->>'pdf_version_id'
   or s.provider is distinct from p_request->>'provider' or pdf.provider is distinct from p_request->>'provider'
   or s.bucket is distinct from p_request->>'bucket' or pdf.bucket is distinct from p_request->>'bucket'
   then return jsonb_build_object('error','source_version_conflict'); end if;
 if p_request->>'object_key' is distinct from
   'tenants/'||p_tenant_id::text||'/pramaan/technical/'||p_report_id::text||'/'||p_operation_key::text||'/'||(p_request->>'archive_sha256')
   then return jsonb_build_object('error','invalid_request'); end if;
 select * into existing from public.pramaan_technical_builds where tenant_id=p_tenant_id and operation_key=p_operation_key for update;
 if found then
   if existing.report_id is distinct from p_report_id or existing.request is distinct from p_request
      then return jsonb_build_object('error','idempotency_conflict'); end if;
   return jsonb_build_object('dossierId',existing.dossier_id,'buildId',existing.id,
      'status',existing.status,'replayed',true);
 end if;
 if exists(select 1 from public.pramaan_technical_builds where tenant_id=p_tenant_id and report_id=p_report_id)
   then return jsonb_build_object('error','source_already_dossiered'); end if;
 -- A two-leaf Merkle root over the exact source and PDF content hashes.
 v_root:=encode(sha256(decode('01','hex')||decode(s.content_hash,'hex')||decode(pdf.content_hash,'hex')),'hex');
 v_proof:=encode(sha256(convert_to('pramaan-proof-v1:'||(p_request->>'manifest_sha256')||':'||(p_request->>'archive_sha256'),'UTF8')),'hex');
 v_retain:=date_trunc('second',clock_timestamp()+interval '7 years')+interval '1 second';
 insert into public.pramaan_dossiers(tenant_id,engagement_id,report_id,dossier_type,title,status,
   merkle_root,manifest_hash,archive_hash,archive_bytes,proof_seal_hash,metadata)
 values(p_tenant_id,r.engagement_id,r.id,'technical_register',btrim(p_title),'draft',
   v_root,p_request->>'manifest_sha256',p_request->>'archive_sha256',
   (p_request->>'archive_bytes')::bigint,v_proof,
   jsonb_build_object('source_kind','published_recorded_plan_technical_report_v1','source_report_id',r.id))
 returning id into v_dossier_id;
 insert into public.pramaan_technical_builds(tenant_id,dossier_id,report_id,source_build_id,
   source_version_id,pdf_version_id,operation_key,requested_by,request,retain_until,correlation_id)
 values(p_tenant_id,v_dossier_id,r.id,b.id,s.id,pdf.id,p_operation_key,p_actor_id,p_request,v_retain,p_correlation_id)
 returning * into existing;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
   'closure.pramaan.drafted'::public.ledger_action_type,v_dossier_id::text,null,null,null,null,null,null,
   'success',jsonb_build_object('report_id',r.id,'source_version_id',s.id,'pdf_version_id',pdf.id,
     'archive_sha256',p_request->>'archive_sha256','build_id',existing.id));
 return jsonb_build_object('dossierId',v_dossier_id,'buildId',existing.id,'status','pending','replayed',false);
end $$;

create function public.settle_technical_pramaan(
 p_tenant_id uuid,p_actor_id uuid,p_build_id uuid,p_receipt jsonb,p_correlation_id uuid)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.pramaan_technical_builds; d public.pramaan_dossiers; a public.pramaan_technical_archives;
 v_until timestamptz;v_readback timestamptz; v_field text;
begin
 if p_correlation_id is null or p_receipt is null or jsonb_typeof(p_receipt)<>'object'
   or octet_length(p_receipt::text)>16384 then return jsonb_build_object('error','invalid_receipt'); end if;
 select * into b from public.pramaan_technical_builds where tenant_id=p_tenant_id and id=p_build_id for update;
 if not found then return jsonb_build_object('error','operation_not_found'); end if;
 if b.requested_by is distinct from p_actor_id and not public.report_founder_allowed(p_tenant_id,p_actor_id)
   then return jsonb_build_object('error','manager_authority_required'); end if;
 select * into d from public.pramaan_dossiers where tenant_id=p_tenant_id and id=b.dossier_id for update;
 select * into a from public.pramaan_technical_archives where tenant_id=p_tenant_id and build_id=b.id;
 if found then
   if a.receipt is distinct from p_receipt then return jsonb_build_object('error','receipt_conflict'); end if;
   return jsonb_build_object('dossierId',d.id,'buildId',b.id,'status','settled','replayed',true);
 end if;
 if b.status<>'pending' or d.status<>'draft' then return jsonb_build_object('error','not_draft'); end if;
 foreach v_field in array array['provider','bucket','object_key','version_id','content_hash','tenant_id',
   'engagement_id','collected_by_agent','retain_until','readback_at','lock_mode','encryption','operation_id','correlation_id'] loop
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
   or p_receipt->>'object_key' is distinct from b.request->>'object_key'
   or p_receipt->>'content_hash' is distinct from b.request->>'archive_sha256'
   or p_receipt->'byte_size' is distinct from b.request->'archive_bytes'
   or p_receipt->>'tenant_id' is distinct from p_tenant_id::text
   or p_receipt->>'engagement_id' is distinct from d.engagement_id::text
   or p_receipt->>'collected_by_agent' is distinct from 'pramaan'
   or p_receipt->>'operation_id' is distinct from b.id::text
   or p_receipt->>'correlation_id' is distinct from b.correlation_id::text
   or p_receipt->'verified' is distinct from 'true'::jsonb
   or p_receipt->'legal_hold' is distinct from 'false'::jsonb
   or p_receipt->>'lock_mode' is distinct from 'COMPLIANCE'
   or p_receipt->>'encryption' not in ('AES256','aws:kms')
   or length(coalesce(p_receipt->>'version_id','')) not between 1 and 1024
   or btrim(p_receipt->>'version_id')='' or p_receipt->>'version_id'='null'
   then return jsonb_build_object('error','receipt_mismatch'); end if;
 begin v_until:=(p_receipt->>'retain_until')::timestamptz;
   v_readback:=(p_receipt->>'readback_at')::timestamptz;
 exception when invalid_datetime_format or datetime_field_overflow then return jsonb_build_object('error','invalid_receipt'); end;
 if v_until is null or not isfinite(v_until) or v_until<b.retain_until
   or v_readback is null or not isfinite(v_readback)
   or v_readback<clock_timestamp()-interval '5 minutes'
   or v_readback>clock_timestamp()+interval '5 minutes'
   then return jsonb_build_object('error','receipt_mismatch'); end if;
 insert into public.pramaan_technical_archives(tenant_id,dossier_id,build_id,provider,bucket,object_key,
   version_id,content_hash,byte_size,retain_until,readback_at,lock_mode,legal_hold,encryption,receipt,verified_by)
 values(p_tenant_id,d.id,b.id,p_receipt->>'provider',p_receipt->>'bucket',p_receipt->>'object_key',
   p_receipt->>'version_id',p_receipt->>'content_hash',(p_receipt->>'byte_size')::bigint,
   v_until,v_readback,'COMPLIANCE',false,p_receipt->>'encryption',p_receipt,p_actor_id);
 update public.pramaan_technical_builds set status='settled',settled_at=clock_timestamp(),
   last_error_code=null,updated_at=clock_timestamp() where id=b.id;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
   'closure.pramaan.archive_settled'::public.ledger_action_type,d.id::text,null,null,null,null,null,null,
   'success',jsonb_build_object('build_id',b.id,'version_id',p_receipt->>'version_id',
     'archive_sha256',p_receipt->>'content_hash'));
 return jsonb_build_object('dossierId',d.id,'buildId',b.id,'status','settled','replayed',false);
end $$;

create function public.note_technical_pramaan_failure(
 p_tenant_id uuid,p_actor_id uuid,p_build_id uuid,p_error_code text,p_correlation_id uuid)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.pramaan_technical_builds;
begin
 if p_correlation_id is null or p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,79}$'
   then return jsonb_build_object('error','invalid_request'); end if;
 select * into b from public.pramaan_technical_builds where tenant_id=p_tenant_id and id=p_build_id for update;
 if not found then return jsonb_build_object('error','operation_not_found'); end if;
 if b.requested_by is distinct from p_actor_id and not public.report_founder_allowed(p_tenant_id,p_actor_id)
   then return jsonb_build_object('error','manager_authority_required'); end if;
 if b.status='pending' and b.last_error_code is distinct from p_error_code then
   update public.pramaan_technical_builds set last_error_code=p_error_code,
     updated_at=clock_timestamp() where id=b.id;
   perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
     'closure.pramaan.archive_pending'::public.ledger_action_type,b.dossier_id::text,null,null,null,null,null,null,
     'failure',jsonb_build_object('build_id',b.id,'error_code',p_error_code));
 end if;
 return jsonb_build_object('dossierId',b.dossier_id,'buildId',b.id,'status',b.status);
end $$;

create function public.seal_technical_pramaan(
 p_tenant_id uuid,p_actor_id uuid,p_dossier_id uuid,p_expected_proof_seal text,p_correlation_id uuid)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.pramaan_dossiers;b public.pramaan_technical_builds;a public.pramaan_technical_archives;
 r public.reports; req public.technical_report_requests; src public.technical_request_sources;
 sb public.technical_artifact_builds; sv public.technical_artifact_versions; pv public.technical_artifact_versions;
begin
 if not public.report_founder_allowed(p_tenant_id,p_actor_id)
   then return jsonb_build_object('error','founder_authority_required'); end if;
 if p_correlation_id is null or p_expected_proof_seal !~ '^[0-9a-f]{64}$'
   then return jsonb_build_object('error','invalid_request'); end if;
 select * into d from public.pramaan_dossiers where tenant_id=p_tenant_id and id=p_dossier_id for update;
 select * into b from public.pramaan_technical_builds where tenant_id=p_tenant_id and dossier_id=p_dossier_id;
 select * into a from public.pramaan_technical_archives where tenant_id=p_tenant_id and dossier_id=p_dossier_id;
 select * into r from public.reports where tenant_id=p_tenant_id and id=b.report_id;
 select * into req from public.technical_report_requests where tenant_id=p_tenant_id and report_id=r.id;
 select * into src from public.technical_request_sources where tenant_id=p_tenant_id and request_id=req.id;
 select * into sb from public.technical_artifact_builds where tenant_id=p_tenant_id and report_id=r.id;
 select * into sv from public.technical_artifact_versions where tenant_id=p_tenant_id and id=b.source_version_id;
 select * into pv from public.technical_artifact_versions where tenant_id=p_tenant_id and id=b.pdf_version_id;
 if d.id is null or b.id is null then return jsonb_build_object('error','source_bound_dossier_required'); end if;
 if d.proof_seal_hash is distinct from p_expected_proof_seal
   then return jsonb_build_object('error','proof_seal_mismatch'); end if;
 if b.status<>'settled' or a.id is null or a.content_hash is distinct from d.archive_hash
   or a.byte_size is distinct from d.archive_bytes or r.status<>'published'
   or r.kind<>'technical' or r.generated_by_agent<>'technical-report-builder'
   or req.id is null or req.status<>'released'
   or r.released_by is null or not exists(select 1 from public.audit_ledger l
     where l.tenant_id=p_tenant_id and l.action_type='report.released'
       and l.target_ref=r.id::text and l.result='success'
       and l.actor_type='human' and l.actor_id=r.released_by::text
       and l.detail->>'pdf_hash'=r.released_archive_hash
       and l.detail->>'content_hash'=r.content_sha256
       and l.detail->>'source_version_id'=sv.version_id
       and l.detail->>'pdf_version_id'=pv.version_id)
   or src.request_id is null or src.source_sha256 is distinct from encode(sha256(convert_to(src.source_text,'UTF8')),'hex')
   or r.content->>'source_sha256' is distinct from src.source_sha256
   or r.released_content_hash is distinct from r.content_sha256
   or sb.id is distinct from b.source_build_id or sb.status<>'settled'
   or sb.content_sha256 is distinct from r.content_sha256
   or sb.source_sha256 is distinct from src.source_sha256
   or sv.id is null or sv.artifact_kind<>'source_json' or sv.report_id is distinct from r.id
   or sv.build_id is distinct from sb.id or sv.content_hash is distinct from src.source_sha256
   or sv.byte_size is distinct from octet_length(src.source_text)
   or sv.retain_until<sb.retain_until or pv.retain_until<sb.retain_until
   or pv.id is null or pv.artifact_kind<>'technical_pdf' or pv.report_id is distinct from r.id
   or pv.build_id is distinct from sb.id
   or r.released_archive_hash is distinct from pv.content_hash
   or pv.content_hash is distinct from b.request->>'pdf_sha256'
   then return jsonb_build_object('error','archive_unverified'); end if;
 if d.status='sealed' then return jsonb_build_object('dossierId',d.id,'status','sealed','replayed',true); end if;
 if d.status<>'draft' then return jsonb_build_object('error','not_draft'); end if;
 update public.pramaan_dossiers set status='sealed',sealed_at=clock_timestamp(),sealed_by=p_actor_id,
   updated_at=clock_timestamp() where id=d.id;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
   'closure.pramaan.sealed'::public.ledger_action_type,d.id::text,null,null,null,null,null,null,
   'success',jsonb_build_object('build_id',b.id,'source_report_id',r.id,
     'archive_version_id',a.version_id,'archive_sha256',a.content_hash,'proof_seal_hash',d.proof_seal_hash));
 return jsonb_build_object('dossierId',d.id,'status','sealed','replayed',false);
end $$;

revoke all on function public.begin_technical_pramaan(uuid,uuid,uuid,uuid,text,jsonb,uuid),
 public.settle_technical_pramaan(uuid,uuid,uuid,jsonb,uuid),
 public.note_technical_pramaan_failure(uuid,uuid,uuid,text,uuid),
 public.seal_technical_pramaan(uuid,uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.begin_technical_pramaan(uuid,uuid,uuid,uuid,text,jsonb,uuid),
 public.settle_technical_pramaan(uuid,uuid,uuid,jsonb,uuid),
 public.note_technical_pramaan_failure(uuid,uuid,uuid,text,uuid),
 public.seal_technical_pramaan(uuid,uuid,uuid,text,uuid) to statutory_proof_writer;
