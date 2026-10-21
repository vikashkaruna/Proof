-- Owner declarations clarify retained coverage gaps. Never observed evidence,
-- compliance judgments, report approvals, or permission to fetch a supplied URL.
alter type public.ledger_action_type add value if not exists 'public_coverage.owner_clarified';
create table controller_security.public_coverage_clarifications (
 id uuid primary key,tenant_id uuid not null references public.tenants(id),
 actor_id uuid not null references public.users(id),engagement_id uuid not null,
 check_id uuid not null,payload_sha256 text not null check(payload_sha256~'^[a-f0-9]{64}$'),
 operation_key uuid not null,previous_revision_id uuid,
 request_text text not null check(octet_length(request_text)<=16384),request_sha256 text not null,
 snapshot_text text not null check(octet_length(snapshot_text)<=24576),snapshot_sha256 text not null,
 receipt_id bigint not null,created_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,id),unique(tenant_id,operation_key),
 unique(tenant_id,engagement_id,check_id,payload_sha256,id),
 foreign key(tenant_id,engagement_id)references public.engagements(tenant_id,id),
 foreign key(tenant_id,check_id)references public.public_website_checks(tenant_id,id),
 foreign key(tenant_id,engagement_id,check_id,payload_sha256,previous_revision_id)
 references controller_security.public_coverage_clarifications(tenant_id,engagement_id,check_id,payload_sha256,id),
 foreign key(tenant_id,receipt_id)references public.audit_ledger(tenant_id,id),
 check(request_sha256=encode(sha256(convert_to(request_text,'UTF8')),'hex')),
 check(snapshot_sha256=encode(sha256(convert_to(snapshot_text,'UTF8')),'hex'))
);
create unique index coverage179_one_root on controller_security.public_coverage_clarifications(tenant_id,engagement_id,check_id,payload_sha256)where previous_revision_id is null;
create unique index coverage179_one_successor on controller_security.public_coverage_clarifications(previous_revision_id)where previous_revision_id is not null;
alter table controller_security.public_coverage_clarifications enable row level security;
revoke all on controller_security.public_coverage_clarifications from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
create trigger coverage179_immutable before update or delete on controller_security.public_coverage_clarifications for each row execute function public.evidence_receipt_immutable();
create trigger coverage179_no_truncate before truncate on controller_security.public_coverage_clarifications for each statement execute function public.evidence_receipt_immutable();

create function controller_security.coverage179_record(r controller_security.public_coverage_clarifications)returns jsonb language sql stable set search_path=''as $$
 select jsonb_build_object('id',r.id,'tenantId',r.tenant_id,'actorId',r.actor_id,'engagementId',r.engagement_id,'checkId',r.check_id,
 'payloadSha256',r.payload_sha256,'operationKey',r.operation_key,'requestText',r.request_text,'requestSha256',r.request_sha256,
 'snapshotText',r.snapshot_text,'snapshotSha256',r.snapshot_sha256,'receiptId',r.receipt_id::text)$$;
revoke all on function controller_security.coverage179_record(controller_security.public_coverage_clarifications)from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

create function controller_security.coverage179_pages(payload jsonb)returns jsonb
language plpgsql immutable set search_path=''as $$
declare pages jsonb:=payload->'pages';result jsonb;
begin
 if jsonb_typeof(pages)is distinct from 'array' then raise exception 'invalid coverage pages';end if;
 if exists(select 1 from jsonb_array_elements(pages)p where coalesce(p->>'page'in('root','privacy','contact','terms','consent'),false)is distinct from true)
 or(select count(*)from jsonb_array_elements(pages))<>(select count(distinct p->>'page')from jsonb_array_elements(pages)p)then raise exception 'invalid coverage pages';end if;
 select jsonb_agg(coalesce((select p from jsonb_array_elements(pages)p where p->>'page'=kind),jsonb_build_object('page',kind,'state','unexamined','truncated',false))order by ordinal)
 into result from unnest(array['root','privacy','contact','terms','consent'])with ordinality as kinds(kind,ordinal);
 return result;
end $$;
revoke all on function controller_security.coverage179_pages(jsonb)from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

create function public.read_public_coverage_clarification(p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_check_id uuid,p_payload_sha256 text,p_operation_key uuid default null)returns jsonb
language plpgsql security definer set search_path=''as $$
declare ctx jsonb;r controller_security.public_coverage_clarifications;allowed boolean;
begin
 ctx:=public.read_public_website_control_review(p_tenant_id,p_actor_id,p_engagement_id,p_check_id);
 if ctx?'error'then return ctx;end if;
 if ctx->>'payloadSha256'is distinct from p_payload_sha256 then return jsonb_build_object('error','source_refused');end if;
 perform pg_advisory_xact_lock(hashtextextended('public-coverage179:'||p_tenant_id::text,0));
 allowed:=exists(select 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id and role in('owner','admin'));
 if p_operation_key is null then
 select *into r from controller_security.public_coverage_clarifications x where x.tenant_id=p_tenant_id and x.engagement_id=p_engagement_id and x.check_id=p_check_id and x.payload_sha256=p_payload_sha256
 and not exists(select 1 from controller_security.public_coverage_clarifications n where n.previous_revision_id=x.id);
 else
 select *into r from controller_security.public_coverage_clarifications where tenant_id=p_tenant_id and engagement_id=p_engagement_id and check_id=p_check_id and payload_sha256=p_payload_sha256 and operation_key=p_operation_key;
 end if;
 return jsonb_build_object('canClarify',allowed,'record',case when r.id is null then null else controller_security.coverage179_record(r)end);
end $$;
revoke all on function public.read_public_coverage_clarification(uuid,uuid,uuid,uuid,text,uuid)from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.read_public_coverage_clarification(uuid,uuid,uuid,uuid,text,uuid)to service_role;

create function public.submit_public_coverage_clarification(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_text text)returns jsonb
language plpgsql security definer set search_path=''as $$
declare v jsonb;ctx jsonb;pages jsonb;entry jsonb;page jsonb;k text;root_origin text;proposal text;r controller_security.public_coverage_clarifications;head controller_security.public_coverage_clarifications;rid uuid:=gen_random_uuid();txt text;receipt bigint;stamp timestamptz:=clock_timestamp();
begin
 if current_setting('role',true)is distinct from 'human_action_writer'then raise exception 'scoped human writer required'using errcode='42501';end if;
 if p_request_text is null or octet_length(p_request_text)>16384 then return jsonb_build_object('error','invalid_record');end if;
 v:=p_request_text::jsonb;
 if controller_security.canonical_questionnaire_json(v)is distinct from p_request_text or controller_security.flow174_keys(v,array['version','operationKey','engagementId','checkId','payloadSha256','expectedPreviousRevisionId','clarifications'])is distinct from true
 or v->'version'is distinct from '1'::jsonb or not controller_security.flow174_uuid(v->'operationKey',false)
 or not controller_security.flow174_uuid(v->'engagementId',false)or not controller_security.flow174_uuid(v->'checkId',false)
 or not controller_security.flow174_uuid(v->'expectedPreviousRevisionId',true)or not controller_security.flow174_digest(v->'payloadSha256')
 or jsonb_typeof(v->'clarifications')is distinct from 'array'or jsonb_array_length(v->'clarifications')>5
 then return jsonb_build_object('error','invalid_record');end if;
 perform controller_security.flow174_human(p_tenant_id,p_actor_id,p_session_id);
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id and role in('owner','admin')for share;
 if not found then return jsonb_build_object('error','forbidden');end if;
 ctx:=public.read_public_website_control_review(p_tenant_id,p_actor_id,(v->>'engagementId')::uuid,(v->>'checkId')::uuid);
 if ctx?'error'then return ctx;end if;
 if ctx->>'payloadSha256'is distinct from v->>'payloadSha256'then return jsonb_build_object('error','source_refused');end if;
 pages:=controller_security.coverage179_pages((ctx->>'payloadText')::jsonb);
 root_origin:=substring((ctx->'pageSources'->0->>'finalUrl')from '^https?://[^/]+');
 if(select count(*)from jsonb_array_elements(v->'clarifications'))<>(select count(distinct x->>'page')from jsonb_array_elements(v->'clarifications')x)then return jsonb_build_object('error','invalid_record');end if;
 for entry in select value from jsonb_array_elements(v->'clarifications')loop
 if controller_security.flow174_keys(entry,array['page','sourceState','sourceTruncated','reasonCategory','reason','proposedPublicUrl'])is distinct from true
 or coalesce(entry->>'page'in('root','privacy','contact','terms','consent'),false)is distinct from true or coalesce(entry->>'reasonCategory'in('not_public','not_found','access_blocked','interactive_content','not_applicable','needs_investigation','other'),false)is distinct from true
 or not controller_security.flow174_text(entry->'reason',2000,false)or length(entry->>'reason')<20 or entry->>'reason'~'[[:cntrl:]]'
 or jsonb_typeof(entry->'sourceTruncated')is distinct from 'boolean'
 then return jsonb_build_object('error','invalid_record');end if;
 select value into page from jsonb_array_elements(pages)where value->>'page'=entry->>'page';
 if page is null or page->>'state'is distinct from entry->>'sourceState'or page->'truncated'is distinct from entry->'sourceTruncated'
 or(page->>'state'='examined'and page->'truncated'='false'::jsonb)then return jsonb_build_object('error','source_refused');end if;
 if entry->'proposedPublicUrl'<>'null'::jsonb then
 proposal:=entry->>'proposedPublicUrl';
 if not controller_security.flow174_text(entry->'proposedPublicUrl',2048,false)or root_origin is null
 or substring(proposal from '^https?://[^/]+')is distinct from root_origin or proposal~'[?#@[:space:]]'
 then return jsonb_build_object('error','invalid_record');end if;end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(pages)p where(p->>'state'<>'examined'or p->'truncated'='true'::jsonb)
 and not exists(select 1 from jsonb_array_elements(v->'clarifications')e where e->>'page'=p->>'page'))then return jsonb_build_object('error','explanation_required');end if;
 perform pg_advisory_xact_lock(hashtextextended('public-coverage179:'||p_tenant_id::text,0));
 select *into r from controller_security.public_coverage_clarifications where tenant_id=p_tenant_id and operation_key=(v->>'operationKey')::uuid;
 if found then
 if r.actor_id<>p_actor_id or r.request_text<>p_request_text then return jsonb_build_object('error','idempotency_conflict');end if;
 return jsonb_build_object('record',controller_security.coverage179_record(r),'replayed',true);end if;
 select *into head from controller_security.public_coverage_clarifications x where x.tenant_id=p_tenant_id and x.engagement_id=(v->>'engagementId')::uuid and x.check_id=(v->>'checkId')::uuid and x.payload_sha256=v->>'payloadSha256'
 and not exists(select 1 from controller_security.public_coverage_clarifications n where n.previous_revision_id=x.id);
 if head.id is distinct from (v->>'expectedPreviousRevisionId')::uuid then return jsonb_build_object('error','stale_revision');end if;
 txt:=controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'disposition','owner_declarations_unverified','tenantId',p_tenant_id,'actorId',p_actor_id,'revisionId',rid,'previousRevisionId',head.id,'recordedAt',to_char(stamp at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'request',v));
 receipt:=public.append_ledger(p_tenant_id,(v->>'operationKey')::uuid,'human',p_actor_id::text,null,null,null,'public_coverage.owner_clarified',rid::text,encode(sha256(convert_to(p_request_text,'UTF8')),'hex'),encode(sha256(convert_to(txt,'UTF8')),'hex'),null,null,null,null,'success',jsonb_build_object('engagement_id',v->'engagementId','check_id',v->'checkId','observed_evidence_changed',false));
 insert into controller_security.public_coverage_clarifications(id,tenant_id,actor_id,engagement_id,check_id,payload_sha256,operation_key,previous_revision_id,request_text,request_sha256,snapshot_text,snapshot_sha256,receipt_id,created_at)
 values(rid,p_tenant_id,p_actor_id,(v->>'engagementId')::uuid,(v->>'checkId')::uuid,v->>'payloadSha256',(v->>'operationKey')::uuid,head.id,p_request_text,encode(sha256(convert_to(p_request_text,'UTF8')),'hex'),txt,encode(sha256(convert_to(txt,'UTF8')),'hex'),receipt,stamp)returning *into r;
 return jsonb_build_object('record',controller_security.coverage179_record(r),'replayed',false);
exception when invalid_text_representation or numeric_value_out_of_range or check_violation then return jsonb_build_object('error','invalid_record');
end $$;
revoke all on function public.submit_public_coverage_clarification(uuid,uuid,uuid,text)from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.submit_public_coverage_clarification(uuid,uuid,uuid,text)to human_action_writer;
