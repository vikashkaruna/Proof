-- W8.3: freeze an actual reviewed DPB notification and its recorded breach.
-- This snapshot is a review source, never proof of regulator receipt.
alter type public.ledger_action_type add value if not exists 'report.dpb.requested';
alter type public.ledger_action_type add value if not exists 'report.dpb.drafted';

create table public.dpb_report_requests (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 breach_id uuid not null references public.breaches(id) on delete restrict,
 notification_id uuid not null references public.breach_notifications(id) on delete restrict,
 operation_key uuid not null,
 requested_by uuid not null references public.users(id) on delete restrict,
 title text not null check(length(btrim(title)) between 1 and 300),
 report_id uuid references public.reports(id) on delete restrict,
 status text not null default 'requested' check(status in ('requested','drafted','reviewed','released','rejected')),
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,id), unique(tenant_id,operation_key), unique(tenant_id,report_id),
 foreign key(tenant_id,report_id) references public.reports(tenant_id,id) on delete restrict
);
create table public.dpb_request_sources (
 request_id uuid primary key references public.dpb_report_requests(id) on delete restrict,
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 source_text text not null check(octet_length(source_text) between 1 and 4194304),
 source_sha256 text not null check(source_sha256 ~ '^[0-9a-f]{64}$'),
 captured_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,request_id),
 foreign key(tenant_id,request_id) references public.dpb_report_requests(tenant_id,id) on delete restrict,
 check(source_sha256=encode(sha256(convert_to(source_text,'UTF8')),'hex'))
);
alter table public.dpb_report_requests enable row level security;
alter table public.dpb_request_sources enable row level security;
revoke all on public.dpb_report_requests,public.dpb_request_sources from public,anon,authenticated,service_role;
grant select on public.dpb_report_requests,public.dpb_request_sources to service_role;
create policy dpb_request_service_read on public.dpb_report_requests for select to service_role using(true);
create policy dpb_source_service_read on public.dpb_request_sources for select to service_role using(true);
create trigger dpb_source_immutable before update or delete on public.dpb_request_sources
 for each row execute function public.evidence_receipt_immutable();

create function public.request_dpb_report(p_tenant_id uuid,p_actor_id uuid,p_operation_key uuid,
 p_breach_id uuid,p_notification_id uuid,p_title text,p_correlation_id uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare b public.breaches;n public.breach_notifications;r public.dpb_report_requests;
 source_text text;v_time timestamptz:=clock_timestamp();
begin
 if not exists(select 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id
   and role in ('owner','admin')) and not public.report_founder_allowed(p_tenant_id,p_actor_id)
  then return jsonb_build_object('error','forbidden'); end if;
 if p_operation_key is null or p_breach_id is null or p_notification_id is null or p_correlation_id is null
  or p_title is null or length(btrim(p_title)) not between 1 and 300 then
  return jsonb_build_object('error','invalid_request'); end if;
 -- Resolve a committed operation before rechecking a source that may since
 -- have been superseded. A replay returns the original immutable snapshot.
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || p_operation_key::text,0));
 select * into r from public.dpb_report_requests where tenant_id=p_tenant_id and operation_key=p_operation_key for update;
 if found then
  if r.requested_by is distinct from p_actor_id or r.breach_id is distinct from p_breach_id
   or r.notification_id is distinct from p_notification_id or r.title is distinct from btrim(p_title)
   then return jsonb_build_object('error','idempotency_conflict'); end if;
  return jsonb_build_object('requestId',r.id,'reportId',r.report_id,'status',r.status,'replayed',true);
 end if;
 -- Lock the source before taking its snapshot. A later status change does not
 -- rewrite a reviewed historical source; a fresh request gets a fresh source.
 select * into b from public.breaches where tenant_id=p_tenant_id and id=p_breach_id for share;
 if not found then return jsonb_build_object('error','breach_not_found'); end if;
 select * into n from public.breach_notifications
  where tenant_id=p_tenant_id and id=p_notification_id and breach_id=p_breach_id for share;
 if not found then return jsonb_build_object('error','notification_not_found'); end if;
 if n.kind<>'dpb' or n.status not in ('reviewed','sent') or n.reviewed_by is null
  or n.reviewed_at is null or n.reviewed_by=n.created_by or n.superseded_by is not null then
  return jsonb_build_object('error','notification_not_reviewed'); end if;
 if n.status='sent' and (n.delivery_outcome<>'delivered' or n.sent_at is null or n.sent_by is null)
  then return jsonb_build_object('error','notification_state_invalid'); end if;
 insert into public.dpb_report_requests(tenant_id,breach_id,notification_id,operation_key,requested_by,title)
 values(p_tenant_id,p_breach_id,p_notification_id,p_operation_key,p_actor_id,btrim(p_title)) returning * into r;
 source_text:=jsonb_build_object(
  'schema_version',1,'serialization','postgres-jsonb-text-v1','kind','dpb_breach_source',
  'request_id',r.id,'tenant_id',p_tenant_id,'captured_at',v_time,
  'breach',jsonb_build_object('id',b.id,'title',b.title,'description',b.description,
   'severity',b.severity,'status',b.status,'occurred_at',b.occurred_at,'detected_at',b.detected_at,
   'dpb_notification_due_by',b.dpb_notification_due_by,'affected_count',b.affected_count,
   'data_categories',b.data_categories,'dpb_notified_at',b.dpb_notified_at,
   'dpb_reference',b.dpb_reference,'principals_notified_at',b.principals_notified_at),
  'notification',jsonb_build_object('id',n.id,'kind',n.kind,'status',n.status,'language',n.language,
   'subject',n.subject,'body',n.body,'created_by',n.created_by,'created_at',n.created_at,
   'reviewed_by',n.reviewed_by,'reviewed_at',n.reviewed_at,'sent_by',n.sent_by,'sent_at',n.sent_at,
   'delivery_outcome',n.delivery_outcome,'delivery_attempts',n.delivery_attempts),
  'limitations',jsonb_build_array('Recorded human-authored breach and notification, not independently verified forensic facts.',
   'Delivery outcome is recorded by the operator in their own channel; no regulator receipt or acceptance is verified.',
   'This is a review pack, not a filed statutory form or legal opinion.')
 )::text;
 if octet_length(source_text)>4194304 then raise exception 'DPB source too large'; end if;
 insert into public.dpb_request_sources(request_id,tenant_id,source_text,source_sha256)
 values(r.id,p_tenant_id,source_text,encode(sha256(convert_to(source_text,'UTF8')),'hex'));
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
  'report.dpb.requested'::public.ledger_action_type,r.id::text,null,null,null,null,null,null,'success',
  jsonb_build_object('breach_id',p_breach_id,'notification_id',p_notification_id,
   'source_sha256',encode(sha256(convert_to(source_text,'UTF8')),'hex')));
 return jsonb_build_object('requestId',r.id,'reportId',null,'status','requested','replayed',false);
end $$;
revoke all on function public.request_dpb_report(uuid,uuid,uuid,uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.request_dpb_report(uuid,uuid,uuid,uuid,uuid,text,uuid) to statutory_proof_writer;

create function public.record_dpb_report_draft(p_tenant_id uuid,p_actor_id uuid,p_request_id uuid,
 p_content_text text,p_correlation_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare req public.dpb_report_requests;src public.dpb_request_sources;content jsonb;r public.reports;
 v_hash text;v_library text;
begin
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','founder_authority_required'); end if;
 if p_request_id is null or p_correlation_id is null or p_content_text is null
  or octet_length(p_content_text) not between 1 and 65536 then return jsonb_build_object('error','invalid_request'); end if;
 begin content:=p_content_text::jsonb; exception when others then return jsonb_build_object('error','invalid_request'); end;
 select * into req from public.dpb_report_requests where tenant_id=p_tenant_id and id=p_request_id for update;
 if not found then return jsonb_build_object('error','request_not_found'); end if;
 select * into src from public.dpb_request_sources where tenant_id=p_tenant_id and request_id=p_request_id;
 if not found then return jsonb_build_object('error','source_not_found'); end if;
 if jsonb_typeof(content)<>'object' or content ?& array['schema_version','kind','request_id','tenant_id','source_sha256','title','generated_by'] is not true
  or content-array['schema_version','kind','request_id','tenant_id','source_sha256','title','generated_by']<>'{}'::jsonb
  or content->'schema_version' is distinct from '2'::jsonb
  or content->>'kind' is distinct from 'dpb_notification_review_pack'
  or jsonb_typeof(content->'title') is distinct from 'string'
  or content->>'generated_by' is distinct from 'dpb-report-builder'
  or content->>'request_id' is distinct from req.id::text
  or content->>'tenant_id' is distinct from p_tenant_id::text
  or content->>'source_sha256' is distinct from src.source_sha256
  or content->>'title' is distinct from req.title then return jsonb_build_object('error','source_binding_mismatch'); end if;
 v_hash:=encode(sha256(convert_to(p_content_text,'UTF8')),'hex');
 if req.report_id is not null then
  select * into r from public.reports where tenant_id=p_tenant_id and id=req.report_id;
  if found and r.content_sha256=v_hash then
   return jsonb_build_object('requestId',req.id,'reportId',r.id,'status',r.status,'contentHash',v_hash,'replayed',true);
  end if;
  return jsonb_build_object('error','idempotency_conflict');
 end if;
 select version into v_library from public.control_libraries order by created_at desc limit 1;
 if v_library is null then return jsonb_build_object('error','library_unavailable'); end if;
 insert into public.reports(tenant_id,kind,title,storage_uri,content,library_version,
  generated_by_agent,operation_key,created_by,content_text,content_sha256)
 values(p_tenant_id,'dpb',req.title,null,content,v_library,'dpb-report-builder',req.operation_key,
  p_actor_id,p_content_text,v_hash) returning * into r;
 update public.dpb_report_requests set report_id=r.id,status='drafted',updated_at=clock_timestamp() where id=req.id;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
  'report.dpb.drafted'::public.ledger_action_type,r.id::text,null,null,null,null,null,null,'success',
  jsonb_build_object('request_id',req.id,'source_sha256',src.source_sha256,'content_sha256',v_hash));
 return jsonb_build_object('requestId',req.id,'reportId',r.id,'status','draft','contentHash',v_hash,'replayed',false);
end $$;
revoke all on function public.record_dpb_report_draft(uuid,uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.record_dpb_report_draft(uuid,uuid,uuid,text,uuid) to statutory_proof_writer;
