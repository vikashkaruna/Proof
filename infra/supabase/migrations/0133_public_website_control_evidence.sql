-- Fresh, bounded public evidence only. Historical hash-only checks are not enriched.
alter type public.ledger_action_type add value if not exists 'connector.website.evidence_captured';

create table public.public_website_control_evidence (
 check_id uuid primary key references public.public_website_checks(id) on delete restrict,
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 codec text not null check(codec='axiom-public-evidence-v2-canonical-json-1'),
 payload_text text not null check(octet_length(payload_text) between 2 and 524288),
 payload_sha256 text not null check(payload_sha256=encode(sha256(convert_to(payload_text,'UTF8')),'hex')),
 page_sources jsonb not null check(jsonb_typeof(page_sources)='array' and jsonb_array_length(page_sources)=5),
 capture_receipt bigint not null,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(tenant_id,capture_receipt) references public.audit_ledger(tenant_id,id) on delete restrict
);
create trigger public_website_control_evidence_immutable before update or delete
 on public.public_website_control_evidence for each row execute function public.evidence_receipt_immutable();
create trigger public_website_control_evidence_no_truncate before truncate
 on public.public_website_control_evidence for each statement execute function public.evidence_receipt_immutable();
-- Legacy uncaptured observations keep their existing contract. Once richer
-- evidence refers to a check, its retained provenance cannot be rewritten.
create function public.protect_captured_public_website_check() returns trigger
 language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.public_website_control_evidence where check_id=old.id)
 then raise exception 'captured public website checks are immutable' using errcode='42501';end if;
 return new;
end $$;
revoke all on function public.protect_captured_public_website_check() from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
create trigger public_website_captured_check_immutable before update on public.public_website_checks
 for each row execute function public.protect_captured_public_website_check();
alter table public.public_website_control_evidence enable row level security;
revoke all on public.public_website_control_evidence from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant select on public.public_website_control_evidence to service_role;
create policy bff_read on public.public_website_control_evidence for select to service_role using(true);

create function public.record_public_website_control_capture(
 p_tenant_id uuid,p_actor_id uuid,p_correlation_id uuid,p_requested_url text,p_final_url text,
 p_result jsonb,p_codec text,p_payload_text text,p_payload_sha256 text,p_page_sources jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare saved jsonb;payload jsonb;page jsonb;provenance jsonb;seen text[]:=array[]::text[];
 kind text;receipt bigint;public_url_pattern text:='^https?://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(/[^?#[:space:]]*)?$';origin text;origin_pattern text:='^(https?://[^/]+)(/|$)';role_name public.user_role;internal boolean;
begin
 select role into role_name from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 select is_axiom_internal into internal from public.users where id=p_actor_id for share;
 if role_name is null or role_name not in ('founder','owner','admin') or internal is null
 or (role_name='founder' and internal is distinct from true)
 then raise exception 'connector manager required' using errcode='42501';end if;
 if p_codec is distinct from 'axiom-public-evidence-v2-canonical-json-1'
 or p_payload_text is null or octet_length(p_payload_text) not between 2 and 524288
 or p_payload_sha256 is distinct from encode(sha256(convert_to(p_payload_text,'UTF8')),'hex')
 then raise exception 'invalid public evidence' using errcode='22023';end if;
 payload:=p_payload_text::jsonb;
 origin:=substring(p_final_url from origin_pattern);
 if origin is null or p_final_url !~ public_url_pattern or p_requested_url !~ public_url_pattern then raise exception 'invalid origin' using errcode='22023';end if;
 if payload->>'version' is distinct from '2' or payload->>'requiresHumanReview' is distinct from 'true'
 or jsonb_typeof(payload->'pages') is distinct from 'array'
 or jsonb_array_length(payload->'pages')<>5
 or jsonb_typeof(p_page_sources) is distinct from 'array' or jsonb_array_length(p_page_sources)<>5
 then raise exception 'invalid public evidence' using errcode='22023';end if;
 for page in select value from jsonb_array_elements(payload->'pages') loop
  kind:=page->>'page';
  if kind is null or kind not in ('root','privacy','contact','terms','consent') or kind=any(seen)
  or page->>'state' is null or page->>'state' not in ('examined','unavailable','unexamined')
  then raise exception 'invalid public evidence' using errcode='22023';end if;
  seen:=array_append(seen,kind);
  select value into provenance from jsonb_array_elements(p_page_sources) where value->>'page'=kind;
  if provenance is null or provenance->>'state' is distinct from page->>'state'
   or provenance->>'contentSha256' is distinct from page->>'contentSha256'
  then raise exception 'invalid public provenance' using errcode='22023';end if;
  if (provenance->>'requestedUrl' is not null and provenance->>'requestedUrl' !~ public_url_pattern)
   or (provenance->>'finalUrl' is not null and provenance->>'finalUrl' !~ public_url_pattern)
  then raise exception 'invalid public provenance' using errcode='22023';end if;
  if page->>'state'='examined' and (page->>'contentSha256' is null or page->>'contentSha256' !~ '^[a-f0-9]{64}$'
   or provenance->>'requestedUrl' is null or provenance->>'finalUrl' is null)
  then raise exception 'invalid public provenance' using errcode='22023';end if;
  if page->>'state'='unexamined' and (provenance->>'requestedUrl' is not null or provenance->>'finalUrl' is not null or provenance->>'contentSha256' is not null)
   or page->>'state'='unavailable' and (provenance->>'requestedUrl' is null or provenance->>'finalUrl' is not null or provenance->>'contentSha256' is not null)
   or (kind<>'root' and page->>'state'<>'unexamined' and substring(provenance->>'requestedUrl' from origin_pattern) is distinct from origin)
   or (kind<>'root' and page->>'state'='examined' and substring(provenance->>'finalUrl' from origin_pattern) is distinct from origin)
  then raise exception 'invalid public provenance' using errcode='22023';end if;
  if kind='root' and (page->>'state'<>'examined' or page->>'contentSha256' is distinct from p_result->>'contentSha256'
   or provenance->>'requestedUrl' is distinct from p_requested_url or provenance->>'finalUrl' is distinct from p_final_url)
  then raise exception 'public root differs' using errcode='22023';end if;
 end loop;
 -- A companion may not silently replace any retained legacy page digest.
 for page in select value from jsonb_array_elements(coalesce(p_result->'auditPages','[]'::jsonb)) loop
  if not exists(select 1 from jsonb_array_elements(payload->'pages') v
    where v->>'page'=page->>'kind'
    and v->>'state'=case when page->>'status'='checked' then 'examined' else 'unavailable' end
    and v->>'contentSha256' is not distinct from page->>'contentSha256')
   or not exists(select 1 from jsonb_array_elements(p_page_sources) v where v->>'page'=page->>'kind'
    and v->>'requestedUrl' is not distinct from page->>'requestedUrl' and v->>'finalUrl' is not distinct from page->>'finalUrl')
  then raise exception 'public page differs' using errcode='22023';end if;
 end loop;
 saved:=public.record_public_website_check(p_tenant_id,p_actor_id,p_correlation_id,p_requested_url,p_final_url,'checked',p_result,null);
 receipt:=public.append_ledger(p_tenant_id,p_correlation_id,'human'::public.actor_type,p_actor_id::text,null,null,null,
  'connector.website.evidence_captured'::public.ledger_action_type,saved->>'id',p_payload_sha256,
  encode(sha256(convert_to(p_page_sources::text,'UTF8')),'hex'),null,null,null,null,'success'::public.ledger_result,
  jsonb_build_object('codec',p_codec,'source_version',2,'requires_human_review',true));
 insert into public.public_website_control_evidence(check_id,tenant_id,codec,payload_text,payload_sha256,page_sources,capture_receipt)
 values((saved->>'id')::uuid,p_tenant_id,p_codec,p_payload_text,p_payload_sha256,p_page_sources,receipt);
 return saved;
end $$;
revoke all on function public.record_public_website_control_capture(uuid,uuid,uuid,text,text,jsonb,text,text,text,jsonb)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.record_public_website_control_capture(uuid,uuid,uuid,text,text,jsonb,text,text,text,jsonb) to human_action_writer;

create function public.read_public_website_control_review(p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_check_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare authority jsonb;e public.engagements;c public.public_website_control_evidence;s public.public_website_checks;lib public.control_libraries;rows jsonb;
begin
 -- Reuse the existing live human membership, tenant/engagement/estate/source checks.
 authority:=public.get_public_source_projection(p_tenant_id,p_actor_id,p_engagement_id,p_check_id);
 if authority?'error' then return authority;end if;
 select * into e from public.engagements where tenant_id=p_tenant_id and id=p_engagement_id for share;
 select * into c from public.public_website_control_evidence where tenant_id=p_tenant_id and check_id=p_check_id for share;
 if c.check_id is null then return jsonb_build_object('error','website_recapture_required');end if;
 select * into s from public.public_website_checks where tenant_id=p_tenant_id and id=p_check_id for share;
 select * into lib from public.control_libraries where version=e.library_version and status in ('published','deprecated') and published_at<=clock_timestamp() for share;
 if lib.version is null then return jsonb_build_object('error','catalogue_unavailable');end if;
 select jsonb_agg(to_jsonb(v)-'created_at' order by v.id) into rows from public.controls v where library_version=e.library_version;
 return jsonb_build_object('tenantId',p_tenant_id,'engagementId',e.id,'checkId',s.id,'checkedAt',s.checked_at,
  'rootContentSha256',s.result->>'contentSha256','codec',c.codec,'payloadText',c.payload_text,'payloadSha256',c.payload_sha256,
  'pageSources',c.page_sources,'captureReceipt',c.capture_receipt::text,'libraryVersion',e.library_version,
  'library',to_jsonb(lib),'controls',rows);
end $$;
revoke all on function public.read_public_website_control_review(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.read_public_website_control_review(uuid,uuid,uuid,uuid) to service_role;
