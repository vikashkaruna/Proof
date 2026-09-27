-- Durable evidence upload intent and immutable provider readback receipts.
-- Legacy rows remain unverified. A database record is never itself proof of S3
-- retention: only trusted BFF provider readback may settle an ingestion.
alter type public.ledger_action_type add value if not exists 'evidence.ingestion.started';
alter type public.ledger_action_type add value if not exists 'evidence.ingestion.pending';
alter type public.ledger_action_type add value if not exists 'evidence.ingestion.settled';

alter table public.evidence add constraint evidence_tenant_identity unique(tenant_id,id);
alter table public.evidence drop constraint evidence_tenant_id_fkey;
alter table public.evidence add constraint evidence_tenant_id_fkey foreign key(tenant_id) references public.tenants(id) on delete restrict;
alter table public.evidence drop constraint evidence_engagement_id_fkey;
-- Preserve existing legacy rows, including historical inconsistent references,
-- while enforcing the tenant boundary for all new writes.
alter table public.evidence add constraint evidence_engagement_tenant_fk foreign key(tenant_id,engagement_id)
  references public.engagements(tenant_id,id) on delete restrict not valid;

create table public.evidence_ingestions (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 operation_key uuid not null,
 engagement_id uuid,
 actor_id uuid not null references public.users(id) on delete restrict,
 correlation_id uuid not null,
 request jsonb not null check(jsonb_typeof(request)='object' and octet_length(request::text)<=16384),
 retain_until timestamptz not null,
 status text not null default 'pending' check(status in ('pending','settled')),
 evidence_id uuid,
 last_error_code text,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 settled_at timestamptz,
 unique(tenant_id,id), unique(tenant_id,operation_key),
 foreign key(tenant_id,evidence_id) references public.evidence(tenant_id,id) on delete restrict,
 foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id) on delete restrict,
 check((status='pending' and evidence_id is null and settled_at is null) or
       (status='settled' and evidence_id is not null and settled_at is not null))
);
create table public.evidence_object_versions (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 evidence_id uuid not null unique,
 ingestion_id uuid not null unique,
 provider text not null check(provider in ('s3','s3-compatible')),
 bucket text not null,
 object_key text not null,
 version_id text not null check(length(version_id) between 1 and 1024 and version_id<>'null'),
 content_hash text not null check(content_hash ~ '^[0-9a-f]{64}$'),
 byte_size bigint not null check(byte_size between 1 and 8388608),
 lock_mode text not null check(lock_mode='COMPLIANCE'),
 retain_until timestamptz not null,
 readback_at timestamptz not null,
 legal_hold boolean not null,
 encryption text not null check(encryption in ('AES256','aws:kms')),
 receipt jsonb not null,
 verified_by uuid not null references public.users(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,id),
 unique(provider,bucket,object_key,version_id),
 foreign key(tenant_id,evidence_id) references public.evidence(tenant_id,id) on delete restrict,
 foreign key(tenant_id,ingestion_id) references public.evidence_ingestions(tenant_id,id) on delete restrict
);
revoke truncate on public.evidence from service_role;
create index evidence_ingestions_pending on public.evidence_ingestions(tenant_id,created_at) where status='pending';
-- No legacy backfill: a URI and date cannot establish an exact object version.
do $$ declare t text; begin
 foreach t in array array['evidence_ingestions','evidence_object_versions'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to authenticated,service_role',t);
  execute format('create policy tenant_member_read on public.%I for select to authenticated using(public.is_tenant_member(tenant_id))',t);
  execute format('create policy bff_service_read on public.%I for select to service_role using(true)',t);
 end loop;
end $$;

create function public.evidence_ingestion_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' or old.status='settled' or
    (to_jsonb(new)-array['status','evidence_id','last_error_code','updated_at','settled_at']) is distinct from
    (to_jsonb(old)-array['status','evidence_id','last_error_code','updated_at','settled_at']) then
  raise exception 'evidence_ingestion_immutable' using errcode='42501';
 end if;
 return new;
end $$;
create trigger evidence_ingestion_immutable before update or delete on public.evidence_ingestions
 for each row execute function public.evidence_ingestion_immutable();
create function public.evidence_receipt_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'evidence_receipt_immutable' using errcode='42501'; end $$;
create trigger evidence_receipt_immutable before update or delete on public.evidence_object_versions
 for each row execute function public.evidence_receipt_immutable();
create function public.protect_verified_evidence() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.evidence_object_versions where tenant_id=old.tenant_id and evidence_id=old.id) then
  raise exception 'verified_evidence_immutable' using errcode='42501';
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger protect_verified_evidence before update or delete on public.evidence
 for each row execute function public.protect_verified_evidence();
revoke all on function public.evidence_ingestion_immutable(),public.evidence_receipt_immutable(),public.protect_verified_evidence() from public,anon,authenticated,service_role;

create function public.evidence_manager_allowed(p_tenant_id uuid,p_actor_id uuid) returns boolean
 language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id
   and role in ('founder','owner','admin') for share;
 return found;
end $$;
revoke all on function public.evidence_manager_allowed(uuid,uuid) from public,anon,authenticated,service_role;

create function public.begin_evidence_ingest(p_tenant_id uuid,p_actor_id uuid,p_operation_key uuid,
 p_request jsonb,p_correlation_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.evidence_ingestions; v_engagement uuid; v_size bigint; v_hash text; v_field text;
begin
 if not public.evidence_manager_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','forbidden'); end if;
 if p_operation_key is null or p_correlation_id is null or p_request is null or jsonb_typeof(p_request)<>'object'
    or octet_length(p_request::text)>16384 then return jsonb_build_object('error','invalid_request'); end if;
 -- Reject unbound metadata rather than silently dropping it on an idempotent retry.
 if (p_request-array['content_hash','byte_size','mime_type','filename','evidence_type','description','control_ids',
    'engagement_id','collected_by_agent','provider','bucket','object_key','retention_policy','legal_hold'])<>'{}'::jsonb
    or not(p_request ?& array['content_hash','byte_size','mime_type','evidence_type','control_ids','collected_by_agent',
      'provider','bucket','object_key','retention_policy','legal_hold']) then return jsonb_build_object('error','invalid_request'); end if;
 -- Null optional metadata is canonical so every persisted intent is readable
 -- by both BFF and producer schemas; omission never invents a value.
 p_request:=jsonb_build_object('filename',null,'description',null,'engagement_id',null)||p_request;
 foreach v_field in array array['content_hash','mime_type','evidence_type','collected_by_agent','provider','bucket','object_key','retention_policy'] loop
  if jsonb_typeof(p_request->v_field) is distinct from 'string' then return jsonb_build_object('error','invalid_request'); end if;
 end loop;
 foreach v_field in array array['filename','description','engagement_id'] loop
  if p_request ? v_field and jsonb_typeof(p_request->v_field) not in ('string','null') then return jsonb_build_object('error','invalid_request'); end if;
 end loop;
 begin
  v_size:=(p_request->>'byte_size')::bigint;
  v_engagement:=(p_request->>'engagement_id')::uuid;
 exception when invalid_text_representation or numeric_value_out_of_range then return jsonb_build_object('error','invalid_request'); end;
 v_hash:=p_request->>'content_hash';
 if v_hash is null or v_hash !~ '^[0-9a-f]{64}$' or v_size is null or v_size not between 1 and 8388608
    or jsonb_typeof(p_request->'byte_size')<>'number' or (p_request->>'byte_size') !~ '^[0-9]+$'
    or p_request->>'retention_policy' is distinct from 'seven_years'
    or jsonb_typeof(p_request->'legal_hold') is distinct from 'boolean'
    or jsonb_typeof(p_request->'control_ids') is distinct from 'array'
    or p_request->>'provider' not in ('s3','s3-compatible')
    or p_request->>'collected_by_agent' not in ('human','saakshi')
    or length(coalesce(p_request->>'mime_type','')) not between 1 and 200
    or length(coalesce(p_request->>'bucket','')) not between 3 and 255
    or p_request->>'bucket' !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]+$'
    or p_request->>'object_key' is distinct from 'tenants/'||p_tenant_id::text||'/evidence-ingestions/'||p_operation_key::text||'/'||v_hash
    or p_request->>'evidence_type' not in ('document','config','screenshot','log','attestation','interview','inventory','report')
    or length(p_request->>'filename')>160 or length(p_request->>'description')>2000 then
  return jsonb_build_object('error','invalid_request');
 end if;
 if jsonb_array_length(p_request->'control_ids')>40 or exists(select 1 from jsonb_array_elements(p_request->'control_ids') x
    where jsonb_typeof(x)<>'string' or length(x#>>'{}') not between 1 and 100) then return jsonb_build_object('error','invalid_request'); end if;
 if exists(select 1 from jsonb_array_elements_text(p_request->'control_ids') x where not exists(select 1 from public.controls c where c.id=x)) then
  return jsonb_build_object('error','control_not_found'); end if;
 if v_engagement is not null then
  perform 1 from public.engagements where tenant_id=p_tenant_id and id=v_engagement for key share;
  if not found then return jsonb_build_object('error','engagement_not_found'); end if;
 end if;
 -- Serialize tenant/key retries and same-content starts before any provider write.
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||p_operation_key::text,0));
 select * into r from public.evidence_ingestions where tenant_id=p_tenant_id and operation_key=p_operation_key for update;
 if found then
  if r.request is distinct from p_request then return jsonb_build_object('error','idempotency_conflict'); end if;
  return jsonb_build_object('operation_id',r.id,'operation_key',r.operation_key,'status',r.status,'evidence_id',r.evidence_id,'request',r.request,
    'retain_until',r.retain_until,'correlation_id',r.correlation_id,'replayed',true);
 end if;
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||v_hash,1));
 if exists(select 1 from public.evidence where tenant_id=p_tenant_id and content_hash=v_hash) then
  return jsonb_build_object('error','content_already_registered'); end if;
 if exists(select 1 from public.evidence_ingestions where tenant_id=p_tenant_id and request->>'content_hash'=v_hash) then
  return jsonb_build_object('error','content_ingestion_pending'); end if;
 insert into public.evidence_ingestions(tenant_id,operation_key,engagement_id,actor_id,correlation_id,request,retain_until)
 values(p_tenant_id,p_operation_key,v_engagement,p_actor_id,p_correlation_id,p_request,date_trunc('second',clock_timestamp())+interval '7 years 1 second') returning * into r;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
  'evidence.ingestion.started',r.id::text,null,null,null,null,null,null,'success',
  jsonb_build_object('operation_id',r.id,'content_hash',v_hash,'byte_size',v_size,'provider',p_request->>'provider'));
 return jsonb_build_object('operation_id',r.id,'operation_key',r.operation_key,'status',r.status,'evidence_id',null,'request',r.request,
  'retain_until',r.retain_until,'correlation_id',r.correlation_id,'replayed',false);
end $$;

create function public.settle_evidence_ingest(p_tenant_id uuid,p_actor_id uuid,p_operation_id uuid,
 p_receipt jsonb,p_correlation_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.evidence_ingestions; q jsonb; v_id uuid; v_until timestamptz; v_readback timestamptz;
 v_existing jsonb; v_version uuid; v_field text;
begin
 if not public.evidence_manager_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','forbidden'); end if;
 if p_correlation_id is null or p_receipt is null or jsonb_typeof(p_receipt)<>'object'
    or octet_length(p_receipt::text)>16384 then return jsonb_build_object('error','invalid_receipt'); end if;
 select * into r from public.evidence_ingestions where tenant_id=p_tenant_id and id=p_operation_id for update;
 if not found then return jsonb_build_object('error','operation_not_found'); end if;
 if r.status='settled' then
  select receipt,id into v_existing,v_version from public.evidence_object_versions where tenant_id=p_tenant_id and ingestion_id=r.id;
  if v_existing is distinct from p_receipt then return jsonb_build_object('error','receipt_conflict'); end if;
  return jsonb_build_object('operation_id',r.id,'status','settled','evidence_id',r.evidence_id,'object_version_id',v_version,'replayed',true);
 end if;
 q:=r.request;
 -- JSON coercion must not turn numeric/boolean versions into provider IDs.
 foreach v_field in array array['provider','bucket','object_key','version_id','content_hash','tenant_id',
   'collected_by_agent','retain_until','readback_at','lock_mode','encryption','operation_id','correlation_id'] loop
  if jsonb_typeof(p_receipt->v_field) is distinct from 'string' then return jsonb_build_object('error','invalid_receipt'); end if;
 end loop;
 foreach v_field in array array['retain_until','readback_at'] loop
  if p_receipt->>v_field !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?([Zz]|[+-][0-9]{2}:[0-9]{2})$' then
   return jsonb_build_object('error','invalid_receipt'); end if;
 end loop;
 begin
  v_until:=(p_receipt->>'retain_until')::timestamptz;
  v_readback:=(p_receipt->>'readback_at')::timestamptz;
 exception when invalid_datetime_format or datetime_field_overflow then return jsonb_build_object('error','invalid_receipt'); end;
 if not(p_receipt ?& array['provider','bucket','object_key','version_id','content_hash','byte_size','tenant_id',
      'engagement_id','collected_by_agent','retain_until','readback_at','lock_mode','verified','legal_hold','encryption','operation_id','correlation_id'])
    or (p_receipt-array['provider','bucket','object_key','version_id','content_hash','byte_size','tenant_id','engagement_id',
      'collected_by_agent','retain_until','readback_at','lock_mode','verified','legal_hold','encryption','operation_id','correlation_id'])<>'{}'::jsonb
    or p_receipt->>'tenant_id' is distinct from p_tenant_id::text
    or p_receipt->>'operation_id' is distinct from r.id::text
    or p_receipt->>'correlation_id' is distinct from r.correlation_id::text
    or p_receipt->>'engagement_id' is distinct from q->>'engagement_id'
    or p_receipt->>'collected_by_agent' is distinct from q->>'collected_by_agent'
    or p_receipt->'byte_size' is distinct from q->'byte_size'
    or p_receipt->>'provider' is distinct from q->>'provider'
    or p_receipt->>'bucket' is distinct from q->>'bucket'
    or p_receipt->>'object_key' is distinct from q->>'object_key'
    or p_receipt->>'content_hash' is distinct from q->>'content_hash'
    or p_receipt->'legal_hold' is distinct from q->'legal_hold'
    or p_receipt->'verified' is distinct from 'true'::jsonb
    or p_receipt->>'lock_mode' is distinct from 'COMPLIANCE'
    or p_receipt->>'encryption' is null or p_receipt->>'encryption' not in ('AES256','aws:kms')
    or length(coalesce(p_receipt->>'version_id','')) not between 1 and 1024
    or btrim(p_receipt->>'version_id')='' or p_receipt->>'version_id'='null'
    or v_until is null or not isfinite(v_until) or v_until<r.retain_until
    or v_readback is null or not isfinite(v_readback) or v_readback<clock_timestamp()-interval '5 minutes'
    or v_readback>clock_timestamp()+interval '5 minutes' then
  return jsonb_build_object('error','receipt_mismatch');
 end if;
 -- A concurrent legacy insert may win the old content dedupe constraint. It
 -- cannot acquire verified assurance by being matched after this upload.
 insert into public.evidence(tenant_id,engagement_id,content_hash,storage_uri,filename,mime_type,byte_size,
   evidence_type,description,collected_by_agent,demonstrates_control_ids,worm_lock_until)
 values(p_tenant_id,(q->>'engagement_id')::uuid,q->>'content_hash','s3://'||(q->>'bucket')||'/'||(q->>'object_key'),
   q->>'filename',q->>'mime_type',(q->>'byte_size')::bigint,(q->>'evidence_type')::public.evidence_type,
   q->>'description',q->>'collected_by_agent',array(select jsonb_array_elements_text(q->'control_ids')),v_until)
 on conflict(tenant_id,content_hash) do nothing returning id into v_id;
 if not found then return jsonb_build_object('error','content_already_registered'); end if;
 insert into public.evidence_object_versions(tenant_id,evidence_id,ingestion_id,provider,bucket,object_key,version_id,
   content_hash,byte_size,lock_mode,retain_until,readback_at,legal_hold,encryption,receipt,verified_by)
 values(p_tenant_id,v_id,r.id,p_receipt->>'provider',p_receipt->>'bucket',p_receipt->>'object_key',p_receipt->>'version_id',
   p_receipt->>'content_hash',(p_receipt->>'byte_size')::bigint,'COMPLIANCE',v_until,v_readback,
   (p_receipt->>'legal_hold')::boolean,p_receipt->>'encryption',p_receipt,p_actor_id) returning id into v_version;
 update public.evidence_ingestions set status='settled',evidence_id=v_id,last_error_code=null,
   updated_at=clock_timestamp(),settled_at=clock_timestamp() where id=r.id;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
   'evidence.ingestion.settled',v_id::text,null,null,null,null,null,null,'success',
   jsonb_build_object('operation_id',r.id,'intent_correlation_id',r.correlation_id,'evidence_id',v_id,
     'object_version_id',v_version,'content_hash',q->>'content_hash','version_id',p_receipt->>'version_id'));
 return jsonb_build_object('operation_id',r.id,'status','settled','evidence_id',v_id,'object_version_id',v_version,'replayed',false);
end $$;

create function public.note_evidence_ingest_failure(p_tenant_id uuid,p_actor_id uuid,p_operation_id uuid,
 p_error_code text,p_correlation_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.evidence_ingestions;
begin
 if not public.evidence_manager_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','forbidden'); end if;
 if p_correlation_id is null or p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,63}$' then
  return jsonb_build_object('error','invalid_request'); end if;
 select * into r from public.evidence_ingestions where tenant_id=p_tenant_id and id=p_operation_id for update;
 if not found then return jsonb_build_object('error','operation_not_found'); end if;
 if r.status='settled' then return jsonb_build_object('operation_id',r.id,'status','settled','evidence_id',r.evidence_id); end if;
 if r.last_error_code is distinct from p_error_code then
  update public.evidence_ingestions set last_error_code=p_error_code,updated_at=clock_timestamp() where id=r.id;
  perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
   'evidence.ingestion.pending',r.id::text,null,null,null,null,null,null,'success',
   jsonb_build_object('operation_id',r.id,'intent_correlation_id',r.correlation_id,'error_code',p_error_code,'disposition','pending_reconciliation'));
 end if;
 return jsonb_build_object('operation_id',r.id,'status','pending','last_error_code',p_error_code);
end $$;
revoke all on function public.begin_evidence_ingest(uuid,uuid,uuid,jsonb,uuid),
 public.settle_evidence_ingest(uuid,uuid,uuid,jsonb,uuid),
 public.note_evidence_ingest_failure(uuid,uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.begin_evidence_ingest(uuid,uuid,uuid,jsonb,uuid),
 public.settle_evidence_ingest(uuid,uuid,uuid,jsonb,uuid),
 public.note_evidence_ingest_failure(uuid,uuid,uuid,text,uuid) to service_role;
