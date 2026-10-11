-- Immutable public HTML source snapshots, not a claim about private systems.
-- Digest codec v1: SHA256(UTF8(PostgreSQL JSONB::text)); clients echo preview.
alter type public.ledger_action_type add value if not exists 'public_source.bound';
alter table public.public_website_checks add constraint public_website_checks_tenant_identity unique(tenant_id,id);
alter table public.engagements add constraint engagements_tenant_estate_identity unique(tenant_id,id,estate_id);
alter table public.audit_ledger add constraint audit_ledger_tenant_identity unique(tenant_id,id);

create function public.public_source_count_valid(v jsonb) returns boolean
language sql immutable set search_path='' as $$
 select case when jsonb_typeof(v)='number'
 then v::text::numeric between 0 and 524288 and trunc(v::text::numeric)=v::text::numeric else false end
$$;
revoke all on function public.public_source_count_valid(jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

-- Mirrors shared publicFormMetadataSchema v1: strict keys, bounded counts,
-- monotonic ordinals, eligible control lengths, exact truncation and booleans.
create function public.public_source_form_metadata_valid(m jsonb,digest text) returns boolean
language plpgsql immutable set search_path='' as $$
declare f jsonb;c jsonb;fn integer:=0;cn integer;last_ordinal integer;eligible integer;
begin
 if jsonb_typeof(m) is distinct from 'object'
 or not m ?& array['version','scope','sourceSha256','observedFormCount','formsTruncated','forms']
 or m-array['version','scope','sourceSha256','observedFormCount','formsTruncated','forms']<>'{}'::jsonb
 or m->'version' is distinct from '1'::jsonb
 or m->>'scope' is distinct from 'static_html_form_descendants'
 or jsonb_typeof(m->'sourceSha256') is distinct from 'string'
 or m->>'sourceSha256' is distinct from digest
 or digest is null or digest !~ '^[a-f0-9]{64}$'
 or not public.public_source_count_valid(m->'observedFormCount')
 or jsonb_typeof(m->'formsTruncated') is distinct from 'boolean'
 or jsonb_typeof(m->'forms') is distinct from 'array' then return false;end if;
 if jsonb_array_length(m->'forms')<>least((m->>'observedFormCount')::numeric::integer,3)
 or (m->>'formsTruncated')::boolean is distinct from ((m->>'observedFormCount')::numeric::integer>3)
 then return false;end if;
 for f in select value from jsonb_array_elements(m->'forms') loop
  fn:=fn+1;
  if jsonb_typeof(f) is distinct from 'object'
  or not f ?& array['ordinal','method','observedControlCount','excludedControlCount','controlsTruncated','controls']
  or f-array['ordinal','method','observedControlCount','excludedControlCount','controlsTruncated','controls']<>'{}'::jsonb
  or f->'ordinal' is distinct from to_jsonb(fn)
  or f->>'method' is null or f->>'method' not in ('get','post','dialog')
  or not public.public_source_count_valid(f->'observedControlCount')
  or not public.public_source_count_valid(f->'excludedControlCount')
  or jsonb_typeof(f->'controlsTruncated') is distinct from 'boolean'
  or jsonb_typeof(f->'controls') is distinct from 'array' then return false;end if;
  eligible:=(f->>'observedControlCount')::numeric::integer-(f->>'excludedControlCount')::numeric::integer;
  if eligible<0 or jsonb_array_length(f->'controls')<>least(eligible,12)
  or (f->>'controlsTruncated')::boolean is distinct from (eligible>12) then return false;end if;
  last_ordinal:=0;
  for c in select value from jsonb_array_elements(f->'controls') loop
   if jsonb_typeof(c) is distinct from 'object'
   or not c ?& array['ordinal','element','requiredAttribute','disabledAttribute']
   or c-array['ordinal','element','inputType','requiredAttribute','disabledAttribute']<>'{}'::jsonb
   or not public.public_source_count_valid(c->'ordinal')
   or c->>'element' is null or c->>'element' not in ('input','select','textarea')
   or jsonb_typeof(c->'requiredAttribute') is distinct from 'boolean'
   or jsonb_typeof(c->'disabledAttribute') is distinct from 'boolean' then return false;end if;
   cn:=(c->>'ordinal')::numeric::integer;
   if cn<=last_ordinal or cn>(f->>'observedControlCount')::numeric::integer then return false;end if;
   last_ordinal:=cn;
   if c->>'element'='input' then
    if jsonb_typeof(c->'inputType') is distinct from 'string' or c->>'inputType' not in
     ('text','email','tel','url','search','number','date','datetime-local','time','month','week','color','range','checkbox','radio') then return false;end if;
   elsif c?'inputType' then return false;end if;
  end loop;
 end loop;
 return true;
end $$;
revoke all on function public.public_source_form_metadata_valid(jsonb,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

create table public.public_source_bindings (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,
 engagement_id uuid not null,estate_id uuid,check_id uuid not null,
 projection_version integer not null check(projection_version=1),
 root_content_sha256 text not null check(root_content_sha256 ~ '^[a-f0-9]{64}$'),
 projection jsonb not null check(jsonb_typeof(projection)='object' and octet_length(projection::text)<=32768),
 projection_sha256 text not null check(projection_sha256=encode(sha256(convert_to(projection::text,'UTF8')),'hex')),
 actor_id uuid not null references public.users(id) on delete restrict,
 correlation_id uuid not null,creation_receipt bigint not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,id),unique(tenant_id,engagement_id,check_id,projection_version),unique(tenant_id,correlation_id),
 constraint public_source_binding_tenant_engagement_fk foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id) on delete restrict,
 foreign key(tenant_id,engagement_id,estate_id) references public.engagements(tenant_id,id,estate_id) on delete restrict,
 foreign key(tenant_id,estate_id) references public.estates(tenant_id,id) on delete restrict,
 foreign key(tenant_id,check_id) references public.public_website_checks(tenant_id,id) on delete restrict,
 foreign key(tenant_id,creation_receipt) references public.audit_ledger(tenant_id,id) on delete restrict
);
create trigger public_source_binding_immutable before update or delete on public.public_source_bindings
 for each row execute function public.evidence_receipt_immutable();
alter table public.public_source_bindings enable row level security;
revoke all on public.public_source_bindings from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant select on public.public_source_bindings to service_role;
create policy bff_read on public.public_source_bindings for select to service_role using(true);

create function public.get_public_source_projection(p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_check_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare role_name public.user_role;internal boolean;e public.engagements;s public.public_website_checks;
 pages jsonb;page jsonb;entry jsonb;projection jsonb;seen text[]:=array[]::text[];kind text;digest text;r public.public_source_bindings;outcome jsonb;
begin
 if p_tenant_id is null or p_actor_id is null or p_engagement_id is null or p_check_id is null
 then return jsonb_build_object('error','invalid_record');end if;
 select role into role_name from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 select is_axiom_internal into internal from public.users where id=p_actor_id for share;
 if role_name is null or role_name='agent' or internal is null
 or (role_name in ('founder','axiom_analyst') and internal is distinct from true)
 then return jsonb_build_object('error','forbidden');end if;
 select * into e from public.engagements where tenant_id=p_tenant_id and id=p_engagement_id and status<>'cancelled' for share;
 if e.id is null then return jsonb_build_object('error','context_refused');end if;
 -- Intake may have no assigned estate. Capture that absence, never infer one.
 if e.estate_id is not null then
  perform 1 from public.estates where tenant_id=p_tenant_id and id=e.estate_id for share;
  if not found then return jsonb_build_object('error','context_refused');end if;
 end if;
 select * into s from public.public_website_checks where tenant_id=p_tenant_id and id=p_check_id and status='checked' for share;
 if s.id is null then return jsonb_build_object('error','source_refused');end if;
 digest:=s.result->>'contentSha256';
 if jsonb_typeof(s.result->'contentSha256') is distinct from 'string' or digest is null or digest !~ '^[a-f0-9]{64}$' then return jsonb_build_object('error','source_refused');end if;
 entry:=jsonb_build_object('page','root','status','checked','content_sha256',digest);
 if s.result?'formMetadata' then
  if not public.public_source_form_metadata_valid(s.result->'formMetadata',digest) then return jsonb_build_object('error','source_refused');end if;
  entry:=entry||jsonb_build_object('form_metadata',s.result->'formMetadata');
 end if;
 pages:=jsonb_build_array(entry);
 if s.result?'auditPages' then
  if jsonb_typeof(s.result->'auditPages') is distinct from 'array' then return jsonb_build_object('error','source_refused');end if;
  if jsonb_array_length(s.result->'auditPages')>3 then return jsonb_build_object('error','source_refused');end if;
  for page in select value from jsonb_array_elements(s.result->'auditPages') loop
   kind:=page->>'kind';
   if jsonb_typeof(page) is distinct from 'object' or kind is null or kind not in ('privacy','contact','terms') or kind=any(seen)
   or page->>'status' is null or page->>'status' not in ('checked','unavailable') then return jsonb_build_object('error','source_refused');end if;
   seen:=array_append(seen,kind);
   entry:=jsonb_build_object('page',kind,'status',page->>'status');
   if page->>'status'='checked' then
    digest:=page->>'contentSha256';
    if jsonb_typeof(page->'contentSha256') is distinct from 'string' or digest is null or digest !~ '^[a-f0-9]{64}$' then return jsonb_build_object('error','source_refused');end if;
    entry:=entry||jsonb_build_object('content_sha256',digest);
    if page?'formMetadata' then
     if not public.public_source_form_metadata_valid(page->'formMetadata',digest) then return jsonb_build_object('error','source_refused');end if;
     entry:=entry||jsonb_build_object('form_metadata',page->'formMetadata');
    end if;
   elsif page?'contentSha256' or page?'formMetadata' then return jsonb_build_object('error','source_refused');end if;
   pages:=pages||jsonb_build_array(entry);
  end loop;
 end if;
 projection:=jsonb_build_object('version',1,'pages',pages);
 outcome:=jsonb_build_object('runtime_binding',jsonb_build_object('tenant_id',p_tenant_id,'engagement_id',p_engagement_id,'check_id',p_check_id,
  'root_content_sha256',s.result->>'contentSha256','projection_sha256',encode(sha256(convert_to(projection::text,'UTF8')),'hex'),'projection_version',1),'projection',projection);
 select * into r from public.public_source_bindings where tenant_id=p_tenant_id and engagement_id=p_engagement_id and check_id=p_check_id and projection_version=1;
 if found then
  if r.projection is distinct from projection or r.root_content_sha256 is distinct from s.result->>'contentSha256'
  or r.projection_sha256 is distinct from outcome->'runtime_binding'->>'projection_sha256' then return jsonb_build_object('error','source_refused');end if;
  outcome:=outcome||jsonb_build_object('binding_id',r.id,'creation_receipt',r.creation_receipt::text);
 end if;
 return outcome;
end $$;
revoke all on function public.get_public_source_projection(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.get_public_source_projection(uuid,uuid,uuid,uuid) to service_role,human_action_writer;

create function public.record_public_source_binding(p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_check_id uuid,
 p_expected_root_sha256 text,p_expected_projection_sha256 text,p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare role_name public.user_role;internal boolean;e public.engagements;preview jsonb;r public.public_source_bindings;rid uuid:=gen_random_uuid();receipt bigint;
begin
 if p_tenant_id is null or p_actor_id is null or p_engagement_id is null or p_check_id is null or p_correlation_id is null
 or p_expected_root_sha256 is null or p_expected_root_sha256 !~ '^[a-f0-9]{64}$'
 or p_expected_projection_sha256 is null or p_expected_projection_sha256 !~ '^[a-f0-9]{64}$'
 then return jsonb_build_object('error','invalid_record');end if;
 -- Same authority-before-context lock order as generic lifecycle/task issuance.
 select role into role_name from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 if role_name is null or role_name not in ('owner','admin','founder','axiom_analyst') then return jsonb_build_object('error','forbidden');end if;
 select is_axiom_internal into internal from public.users where id=p_actor_id for share;
 if not found or (role_name in ('founder','axiom_analyst') and internal is distinct from true) then return jsonb_build_object('error','forbidden');end if;
 select * into e from public.engagements where tenant_id=p_tenant_id and id=p_engagement_id and status<>'cancelled' for share;
 if e.id is null then return jsonb_build_object('error','context_refused');end if;
 if e.estate_id is not null then
  perform 1 from public.estates where tenant_id=p_tenant_id and id=e.estate_id for share;
  if not found then return jsonb_build_object('error','context_refused');end if;
 end if;
 perform 1 from public.public_website_checks where tenant_id=p_tenant_id and id=p_check_id for share;
 if not found then return jsonb_build_object('error','source_refused');end if;
 preview:=public.get_public_source_projection(p_tenant_id,p_actor_id,p_engagement_id,p_check_id);
 if preview?'error' then return preview;end if;
 if preview->'runtime_binding'->>'root_content_sha256' is distinct from p_expected_root_sha256
 or preview->'runtime_binding'->>'projection_sha256' is distinct from p_expected_projection_sha256
 then return jsonb_build_object('error','stale_source');end if;
 -- Serialize snapshot and correlation identity together before the ledger lock.
 perform pg_advisory_xact_lock(hashtextextended('public-source-binding-v1:'||p_tenant_id::text,0));
 select * into r from public.public_source_bindings where tenant_id=p_tenant_id and
  (correlation_id=p_correlation_id or (engagement_id=p_engagement_id and check_id=p_check_id and projection_version=1));
 if found then
  if r.actor_id is distinct from p_actor_id or r.engagement_id is distinct from p_engagement_id or r.check_id is distinct from p_check_id
  or r.correlation_id is distinct from p_correlation_id or r.root_content_sha256 is distinct from p_expected_root_sha256
  or r.projection_sha256 is distinct from p_expected_projection_sha256 then return jsonb_build_object('error','binding_conflict');end if;
  return preview||jsonb_build_object('binding_id',r.id,'created',false,'replayed',true,'creation_receipt',r.creation_receipt::text);
 end if;
 receipt:=public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,'public_source.bound',rid::text,
  p_expected_root_sha256,p_expected_projection_sha256,null,null,null,null,'success',
  jsonb_build_object('engagement_id',p_engagement_id,'check_id',p_check_id,'projection_version',1));
 insert into public.public_source_bindings(id,tenant_id,engagement_id,estate_id,check_id,projection_version,root_content_sha256,projection,projection_sha256,actor_id,correlation_id,creation_receipt)
 values(rid,p_tenant_id,p_engagement_id,e.estate_id,p_check_id,1,p_expected_root_sha256,preview->'projection',preview->'runtime_binding'->>'projection_sha256',p_actor_id,p_correlation_id,receipt) returning * into r;
 return preview||jsonb_build_object('binding_id',r.id,'created',true,'replayed',false,'creation_receipt',receipt::text);
end $$;
revoke all on function public.record_public_source_binding(uuid,uuid,uuid,uuid,text,text,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.record_public_source_binding(uuid,uuid,uuid,uuid,text,text,uuid) to human_action_writer;

-- A producer credential cannot forge this human source approval.
create or replace function public.append_agent_ledger(
  p_tenant_id uuid,p_correlation_id uuid,p_actor_type public.actor_type,
  p_actor_id text,p_agent_version text,p_model_id text,p_prompt_hash text,
  p_action_type public.ledger_action_type,p_target_ref text,p_input_hash text,
  p_output_hash text,p_approval_token_id uuid,p_approver_id uuid,
  p_pre_state_ref text,p_post_state_ref text,p_result public.ledger_result,
  p_detail jsonb
) returns bigint language plpgsql security definer set search_path='' as $$
begin
  if p_actor_type not in ('agent','system') or p_actor_id is null
    or btrim(p_actor_id)='' then
    raise exception 'producer ledger actor refused' using errcode='42501';
  end if;
  -- Only a recorded human may decide, release or seal. A leaked producer key
  -- must not be able to append these under an agent or system label either.
  if p_action_type::text = any(array[
    'public_source.bound','agent.invocation.requested','agent.invocation.settled',
    'plan.rejected','plan.published','report.approved','report.rejected',
    'report.released','evidence_pack.exported','approval.exported',
    'approval.archive.reviewed','approval.archive.released',
    'closure.pramaan.sealed','execution.kill_switch.released',
    'user.role.changed','mfa.factor.activated','mfa.factor.revoked',
    'tenant.invitation.accepted','breach.notification.reviewed',
    'consent.withdrawn','consent.legal_hold.set'
  ]) then
    raise exception 'human-authority ledger event refused for producer'
      using errcode='42501';
  end if;
  return public.append_ledger(p_tenant_id,p_correlation_id,p_actor_type,p_actor_id,
    p_agent_version,p_model_id,p_prompt_hash,p_action_type,p_target_ref,
    p_input_hash,p_output_hash,p_approval_token_id,p_approver_id,
    p_pre_state_ref,p_post_state_ref,p_result,p_detail);
end $$;

