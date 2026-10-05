-- Human-origin processing records and measured delivery tasks. Nullable fields
-- stay unknown; linking public HTML is provenance, not proof of private facts.
-- Policy wrappers retain the existing founder-only state machine and bytes.
alter type public.ledger_action_type add value if not exists 'operator.request.cancelled';
alter table public.policy_drafts drop constraint policy_drafts_category_check;
alter table public.policy_drafts add constraint policy_drafts_category_check check(category in
 ('data_protection','retention','breach_response','access_control','vendor_management','acceptable_use','privacy_notice','consent_notice','dpa_template'));

create or replace function public.create_policy_draft(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_title text,
  p_category text,
  p_summary text,
  p_content text,
  p_citations text[],
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_role text;
  v_hash text;
  v_draft public.policy_drafts;
begin
  select role into v_role from public.tenant_users where tenant_id = p_tenant_id and user_id = p_actor_id;
  if (v_role is null or v_role not in ('owner', 'admin', 'founder')) and not exists (select 1 from public.users where id = p_actor_id and is_axiom_internal) then
    return jsonb_build_object('error', 'forbidden');
  end if;

  if p_title is null or length(btrim(p_title)) not between 1 and 300
     or p_category is null or p_category not in ('data_protection', 'retention', 'breach_response', 'access_control', 'vendor_management', 'acceptable_use', 'privacy_notice', 'consent_notice', 'dpa_template')
     or p_summary is null or length(btrim(p_summary)) not between 1 and 2000
     or p_content is null or octet_length(p_content) not between 1 and 5242880
     or p_correlation_id is null then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  v_hash := encode(sha256(convert_to(p_content, 'UTF8')), 'hex');

  insert into public.policy_drafts (
    tenant_id, title, category, summary, content, content_sha256,
    control_citations, created_by
  ) values (
    p_tenant_id, p_title, p_category, p_summary, p_content, v_hash,
    coalesce(p_citations, '{}'), p_actor_id
  ) returning * into v_draft;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_actor_id::text, null, null, null,
    'policy.drafted'::public.ledger_action_type, v_draft.id::text,
    null, null, null, null, null, null, 'success',
    jsonb_build_object(
      'title', v_draft.title,
      'category', v_draft.category,
      'content_hash', v_hash
    )
  );

  return jsonb_build_object(
    'draftId', v_draft.id,
    'status', v_draft.status,
    'contentHash', v_hash,
    'version', v_draft.version
  );
end $$;


create function public.review_policy_draft(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_draft_id uuid,
  p_decision text,
  p_expected_hash text,
  p_correlation_id uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_draft public.policy_drafts;
  v_new_status text;
begin
  if not public.report_founder_allowed(p_tenant_id, p_actor_id) then
    return jsonb_build_object('error', 'founder_authority_required');
  end if;

  if p_draft_id is null or p_decision is null or p_decision not in ('approved', 'rejected') or p_expected_hash is null or p_correlation_id is null or p_reason is null or length(btrim(p_reason)) not between 1 and 2000 or p_reason !~ '[^[:space:]]' then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  select * into v_draft from public.policy_drafts
   where tenant_id = p_tenant_id and id = p_draft_id for update;

  if not found then
    return jsonb_build_object('error', 'draft_not_found');
  end if;

  if v_draft.content_sha256 is distinct from p_expected_hash then
    return jsonb_build_object('error', 'digest_mismatch');
  end if;

  if v_draft.status not in ('draft', 'under_review') then
    return jsonb_build_object('error', 'invalid_draft_state');
  end if;

  v_new_status := case when p_decision = 'approved' then 'approved' else 'deprecated' end;

  update public.policy_drafts
     set status = v_new_status,
         reviewed_by = p_actor_id,
         reviewed_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where tenant_id = p_tenant_id and id = v_draft.id
   returning * into v_draft;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_actor_id::text, null, null, null,
    'policy.reviewed'::public.ledger_action_type, v_draft.id::text,
    null, null, null, null, null, null, 'success',
    jsonb_build_object(
      'decision', p_decision,
      'status', v_new_status,
      'content_hash', v_draft.content_sha256, 'reason', p_reason
    )
  );

  return jsonb_build_object(
    'draftId', v_draft.id,
    'status', v_draft.status,
    'reviewedAt', v_draft.reviewed_at
  );
end $$;


revoke all on function public.review_policy_draft(uuid,uuid,uuid,text,text,uuid,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.review_policy_draft(uuid,uuid,uuid,text,text,uuid,text) to human_action_writer;

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
    'classification.reviewed','policy.reviewed','ropa.recorded','policy.drafted','playbook.created','operator.request.cancelled',
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

create table public.operator_workflow_records(
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete restrict,
 operation_key uuid not null, kind text not null check(kind in ('ropa','delivery_task','policy_draft','policy_review')),
 payload jsonb not null check(jsonb_typeof(payload)='object'),
 content_sha256 text check(content_sha256 ~ '^[a-f0-9]{64}$'),
 created_by uuid not null references public.users(id) on delete restrict,
 engagement_id uuid, source_observation_id uuid, source_output_sha256 text,
 policy_draft_id uuid, receipt_id bigint not null, created_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,id), unique(tenant_id,operation_key),
 foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id) on delete restrict,
 foreign key(tenant_id,source_observation_id) references public.public_source_observations(tenant_id,id) on delete restrict,
 foreign key(tenant_id,policy_draft_id) references public.policy_drafts(tenant_id,id) on delete restrict,
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id) on delete restrict,
 check((kind in ('ropa','delivery_task') and content_sha256 is null and policy_draft_id is null)
   or (kind in ('policy_draft','policy_review') and content_sha256 is not null and policy_draft_id is not null)),
 check((source_observation_id is null and source_output_sha256 is null)
   or (source_observation_id is not null and source_output_sha256 ~ '^[a-f0-9]{64}$' and engagement_id is not null)),
 check(kind<>'policy_draft' or id=policy_draft_id)
);
create index operator_workflow_page on public.operator_workflow_records(tenant_id,kind,created_at desc,id desc);
create index operator_delivery_rank on public.operator_workflow_records(tenant_id,
 (((payload->>'durationMinutes')::bigint)*((payload->>'repetitions')::bigint)) desc,created_at desc,id desc)
 where kind='delivery_task';
create trigger operator_workflow_immutable before update or delete on public.operator_workflow_records
 for each row execute function public.evidence_receipt_immutable();
alter table public.operator_workflow_records enable row level security;
revoke all on public.operator_workflow_records from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

-- A negative recovery read is not a durable fence against an in-flight POST.
-- Cancellation records the exact request commitment under the same key lock.
create table public.operator_workflow_cancellations(
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 operation_key uuid not null, created_by uuid not null references public.users(id) on delete restrict,
 kind text not null check(kind in ('ropa','delivery_task','policy_draft','policy_review')),
 payload_sha256 text not null check(payload_sha256 ~ '^[a-f0-9]{64}$'),
 receipt_id bigint not null, created_at timestamptz not null default clock_timestamp(),
 primary key(tenant_id,operation_key),
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id) on delete restrict
);
create trigger operator_workflow_cancellation_immutable before update or delete on public.operator_workflow_cancellations
 for each row execute function public.evidence_receipt_immutable();
alter table public.operator_workflow_cancellations enable row level security;
revoke all on public.operator_workflow_cancellations from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

create function public.operator_workflow_text(v jsonb,max_len integer,nullable boolean)
returns boolean language sql immutable set search_path='' as $$
 select coalesce((nullable and v='null'::jsonb) or
  (jsonb_typeof(v)='string' and length(v#>>'{}') between 1 and max_len and (v#>>'{}') ~ '[^[:space:]]'),false)
$$;
create function public.operator_workflow_uuid(v jsonb,nullable boolean)
returns boolean language sql immutable set search_path='' as $$
 select coalesce((nullable and v='null'::jsonb) or (jsonb_typeof(v)='string' and
 (v#>>'{}') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),false)
$$;
create function public.operator_workflow_valid(k text,p jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare required text[]; allowed text[]; key text; item jsonb;
begin
 if k is null or p is null or jsonb_typeof(p)<>'object' then return false;end if;
 if k='ropa' then
  required:=array['engagementId','sourceNote','system','purpose','legalBasis','retentionMonths','dataCategories','processors',
   'region','crossBorder','securityMeasures','dataPrincipals','recipients','destinationCountries','transferSafeguards','dpiaRequired'];
 elsif k='delivery_task' then
  required:=array['engagementId','taskName','source','durationMinutes','repetitions','notes'];
 elsif k='policy_draft' then
  required:=array['engagementId','sourceNote','title','category','content','sourceRopaId'];
 elsif k='policy_review' then
  required:=array['draftId','expectedHash','decision','reason'];
 else return false;end if;
 allowed:=required;
 if k in ('ropa','policy_draft') then allowed:=allowed||array['source'];end if;
 if not p ?& required or p-allowed<>'{}'::jsonb then return false;end if;
 if k<>'policy_review' and not public.operator_workflow_uuid(p->'engagementId',true) then return false;end if;
 if k in ('ropa','policy_draft') then
  if not public.operator_workflow_text(p->'sourceNote',2000,false) then return false;end if;
  if p?'source' then
   if jsonb_typeof(p->'source')<>'object' or not (p->'source') ?& array['observationId','outputSha256']
    or (p->'source')-array['observationId','outputSha256']<>'{}'::jsonb
    or not public.operator_workflow_uuid(p->'source'->'observationId',false)
    or jsonb_typeof(p->'source'->'outputSha256')<>'string'
    or p->'source'->>'outputSha256' !~ '^[a-f0-9]{64}$' or p->'engagementId'='null'::jsonb then return false;end if;
  end if;
 end if;
 if k='ropa' then
  if not public.operator_workflow_text(p->'system',200,false)
    or not public.operator_workflow_text(p->'purpose',2000,true)
    or not public.operator_workflow_text(p->'legalBasis',200,true)
    or not public.operator_workflow_text(p->'region',100,true)
    or not public.operator_workflow_text(p->'securityMeasures',2000,true)
    or not public.operator_workflow_text(p->'transferSafeguards',2000,true) then return false;end if;
  foreach key in array array['crossBorder','dpiaRequired'] loop
   if jsonb_typeof(p->key) not in ('boolean','null') then return false;end if;
  end loop;
  if p->'retentionMonths'<>'null'::jsonb and
   (jsonb_typeof(p->'retentionMonths')<>'number' or p->>'retentionMonths' !~ '^[0-9]+$'
    or (p->>'retentionMonths')::numeric not between 1 and 1200) then return false;end if;
  foreach key in array array['dataCategories','processors','dataPrincipals','recipients','destinationCountries'] loop
   if p->key='null'::jsonb then continue;end if;
   if jsonb_typeof(p->key)<>'array' then return false;end if;
   if jsonb_array_length(p->key)>50 then return false;end if;
   for item in select value from jsonb_array_elements(p->key) loop
    if not public.operator_workflow_text(item,200,false) then return false;end if;
   end loop;
  end loop;
 elsif k='delivery_task' then
  if not public.operator_workflow_text(p->'taskName',200,false) or not public.operator_workflow_text(p->'source',200,false)
   or jsonb_typeof(p->'notes')<>'string' or length(p->>'notes')>2000 then return false;end if;
  foreach key in array array['durationMinutes','repetitions'] loop
   if jsonb_typeof(p->key)<>'number' or p->>key !~ '^[0-9]+$' or (p->>key)::numeric>1000000
    or (p->>key)::numeric<(case when key='durationMinutes' then 0 else 1 end) then return false;end if;
  end loop;
 elsif k='policy_draft' then
  if not public.operator_workflow_text(p->'title',300,false) or not public.operator_workflow_text(p->'content',100000,false)
   or octet_length(p->>'content')>100000 or not public.operator_workflow_uuid(p->'sourceRopaId',true)
   or jsonb_typeof(p->'category')<>'string' or p->>'category' not in
    ('data_protection','retention','breach_response','access_control','vendor_management','acceptable_use','privacy_notice','consent_notice','dpa_template') then return false;end if;
 else
  if not public.operator_workflow_uuid(p->'draftId',false) or jsonb_typeof(p->'expectedHash')<>'string'
   or p->>'expectedHash' !~ '^[a-f0-9]{64}$' or p->>'decision' not in ('approved','rejected')
   or jsonb_typeof(p->'decision')<>'string' or not public.operator_workflow_text(p->'reason',2000,false) then return false;end if;
 end if;
 return true;
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end $$;

create function public.operator_workflow_context(t uuid,a uuid,k text,w boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.user_role;i boolean;
begin
 if t is null or a is null or w is null then return jsonb_build_object('error','invalid_record');end if;
 select role into r from public.tenant_users where tenant_id=t and user_id=a for share;
 select is_axiom_internal into i from public.users where id=a for share;
 if r is null or i is null or r not in ('founder','axiom_analyst','owner','admin','approver','reviewer','viewer','partner')
  or (r in ('founder','axiom_analyst') and i is distinct from true)
  or (w and k<>'policy_review' and r not in ('founder','owner','admin')) then return jsonb_build_object('error','forbidden');end if;
 if w and k='policy_review' and not public.report_founder_allowed(t,a) then return jsonb_build_object('error','founder_authority_required');end if;
 return '{}'::jsonb;
end $$;
create function public.operator_workflow_source(t uuid,p jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e uuid;o public.public_source_observations;s jsonb;
begin
 e:=(p->>'engagementId')::uuid;
 if e is not null then
  perform 1 from public.engagements where tenant_id=t and id=e and status<>'cancelled' for share;
  if not found then return jsonb_build_object('error','context_refused');end if;
 end if;
 if jsonb_typeof(p->'source')='object' then
  select * into o from public.public_source_observations where tenant_id=t and engagement_id=e
   and id=(p->'source'->>'observationId')::uuid;
  if not found then return jsonb_build_object('error','source_refused');end if;
  s:=public.public_source_review_source(t,e,o.binding_id,o.id,false);
  if s?'error' then return jsonb_build_object('error','source_refused');end if;
  if o.output_sha256 is distinct from p->'source'->>'outputSha256' then return jsonb_build_object('error','digest_mismatch');end if;
 end if;
 if p?'sourceRopaId' and p->'sourceRopaId'<>'null'::jsonb then
  perform 1 from public.operator_workflow_records where tenant_id=t and kind='ropa' and id=(p->>'sourceRopaId')::uuid
   and engagement_id is not distinct from e;
  if not found then return jsonb_build_object('error','source_refused');end if;
 end if;
 return '{}'::jsonb;
end $$;
create function public.operator_workflow_metadata(r public.operator_workflow_records)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',r.id,'tenant_id',r.tenant_id,'operation_key',r.operation_key,'kind',r.kind,'payload',r.payload,
  'content_sha256',r.content_sha256,'created_by',r.created_by,
  'created_at',to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'receipt_id',r.receipt_id::text)
$$;

create function public.record_operator_workflow(p_tenant_id uuid,p_actor_id uuid,p_operation_key uuid,p_kind text,p_payload jsonb,p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c jsonb;prior public.operator_workflow_records;r public.operator_workflow_records;result jsonb;source_payload jsonb;
 cancelled public.operator_workflow_cancellations;
 v_record_id uuid:=gen_random_uuid();draft uuid;h text;receipt bigint;action public.ledger_action_type;
begin
 if p_operation_key is null or p_correlation_id is null or not public.operator_workflow_valid(p_kind,p_payload)
  then return jsonb_build_object('error','invalid_record');end if;
 c:=public.operator_workflow_context(p_tenant_id,p_actor_id,p_kind,true);if c?'error' then return c;end if;
 c:=public.operator_workflow_source(p_tenant_id,p_payload);if c?'error' then return c;end if;
 if p_kind='policy_review' then
  select payload into source_payload from public.operator_workflow_records where tenant_id=p_tenant_id
   and id=(p_payload->>'draftId')::uuid and kind='policy_draft';
  if not found then return jsonb_build_object('error','draft_not_found');end if;
  c:=public.operator_workflow_source(p_tenant_id,source_payload);if c?'error' then return c;end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('operator-workflow/'||p_tenant_id::text||'/'||p_operation_key::text,0));
 select * into cancelled from public.operator_workflow_cancellations where tenant_id=p_tenant_id and operation_key=p_operation_key;
 if found then
  if cancelled.created_by<>p_actor_id or cancelled.kind<>p_kind
   or cancelled.payload_sha256 is distinct from encode(sha256(convert_to(p_payload::text,'UTF8')),'hex')
   then return jsonb_build_object('error','idempotency_conflict');end if;
  return jsonb_build_object('error','operation_cancelled');
 end if;
 select * into prior from public.operator_workflow_records where tenant_id=p_tenant_id and operation_key=p_operation_key;
 if found then
  if prior.created_by<>p_actor_id or prior.kind<>p_kind or prior.payload is distinct from p_payload
   then return jsonb_build_object('error','idempotency_conflict');end if;
  if p_kind in ('policy_draft','policy_review') and not exists(select 1 from public.policy_drafts d
   where d.tenant_id=p_tenant_id and d.id=prior.policy_draft_id and d.content_sha256=prior.content_sha256
    and (p_kind<>'policy_review' or (d.reviewed_by=p_actor_id and d.status=(case when p_payload->>'decision'='approved' then 'approved' else 'deprecated' end))))
   then return jsonb_build_object('error','invalid_draft_state');end if;
  return jsonb_build_object('data',public.operator_workflow_metadata(prior),'replayed',true);
 end if;
 if p_kind='policy_draft' then
  result:=public.create_policy_draft(p_tenant_id,p_actor_id,p_payload->>'title',p_payload->>'category',p_payload->>'sourceNote',
   p_payload->>'content',array[]::text[],p_correlation_id);
  if result?'error' then return result;end if;
  v_record_id:=(result->>'draftId')::uuid;draft:=v_record_id;h:=result->>'contentHash';action:='policy.drafted';
 elsif p_kind='policy_review' then
  draft:=(p_payload->>'draftId')::uuid;
  -- Only a retained wrapper draft can acquire a new-format review, avoiding
  -- accidental association of review provenance with untracked legacy content.
  perform 1 from public.operator_workflow_records where tenant_id=p_tenant_id and id=draft and kind='policy_draft';
  if not found then return jsonb_build_object('error','draft_not_found');end if;
  result:=public.review_policy_draft(p_tenant_id,p_actor_id,draft,p_payload->>'decision',p_payload->>'expectedHash',p_correlation_id,p_payload->>'reason');
  if result?'error' then return result;end if;
  h:=p_payload->>'expectedHash';action:='policy.reviewed';
 else
  action:=case when p_kind='ropa' then 'ropa.recorded'::public.ledger_action_type else 'playbook.created'::public.ledger_action_type end;
  receipt:=public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,action,v_record_id::text,
   null,null,null,null,null,null,'success',jsonb_build_object('kind',p_kind,'operation_key',p_operation_key,'review_required',true,
    'payload_sha256',encode(sha256(convert_to(p_payload::text,'UTF8')),'hex')));
 end if;
 if p_kind in ('policy_draft','policy_review') then
  select l.id into strict receipt from public.audit_ledger l where l.tenant_id=p_tenant_id and l.correlation_id=p_correlation_id
   and l.action_type=action and l.actor_type='human' and l.actor_id=p_actor_id::text and l.target_ref=draft::text and l.result='success';
 end if;
 insert into public.operator_workflow_records(id,tenant_id,operation_key,kind,payload,content_sha256,created_by,engagement_id,
  source_observation_id,source_output_sha256,policy_draft_id,receipt_id)
 values(v_record_id,p_tenant_id,p_operation_key,p_kind,p_payload,h,p_actor_id,(p_payload->>'engagementId')::uuid,
  (p_payload->'source'->>'observationId')::uuid,p_payload->'source'->>'outputSha256',draft,receipt) returning * into r;
 return jsonb_build_object('data',public.operator_workflow_metadata(r),'replayed',false);
end $$;
create function public.cancel_operator_workflow(p_tenant_id uuid,p_actor_id uuid,p_operation_key uuid,p_kind text,p_payload jsonb,p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c jsonb;r public.operator_workflow_records;cancelled public.operator_workflow_cancellations;
 h text;receipt bigint;
begin
 if p_operation_key is null or p_correlation_id is null or not public.operator_workflow_valid(p_kind,p_payload)
  then return jsonb_build_object('error','invalid_record');end if;
 c:=public.operator_workflow_context(p_tenant_id,p_actor_id,null,false);if c?'error' then return c;end if;
 h:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended('operator-workflow/'||p_tenant_id::text||'/'||p_operation_key::text,0));
 select * into r from public.operator_workflow_records where tenant_id=p_tenant_id and operation_key=p_operation_key;
 if found then
  if r.created_by<>p_actor_id or r.kind<>p_kind or r.payload is distinct from p_payload
   then return jsonb_build_object('error','idempotency_conflict');end if;
  return jsonb_build_object('data',public.operator_workflow_metadata(r),'cancelled',false);
 end if;
 select * into cancelled from public.operator_workflow_cancellations where tenant_id=p_tenant_id and operation_key=p_operation_key;
 if found then
  if cancelled.created_by<>p_actor_id or cancelled.kind<>p_kind or cancelled.payload_sha256 is distinct from h
   then return jsonb_build_object('error','idempotency_conflict');end if;
  return jsonb_build_object('data',null,'cancelled',true);
 end if;
 receipt:=public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
  'operator.request.cancelled',p_operation_key::text,null,null,null,null,null,null,'success',
  jsonb_build_object('operation_key',p_operation_key,'kind',p_kind,'payload_sha256',h));
 insert into public.operator_workflow_cancellations(tenant_id,operation_key,created_by,kind,payload_sha256,receipt_id)
  values(p_tenant_id,p_operation_key,p_actor_id,p_kind,h,receipt);
 return jsonb_build_object('data',null,'cancelled',true);
end $$;
create function public.list_operator_workflows(p_tenant_id uuid,p_actor_id uuid,p_kind text,p_limit integer,p_offset integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c jsonb;rows jsonb;n bigint;
begin
 if p_kind is null or p_kind not in ('ropa','delivery_task','policy_draft','policy_review') or p_limit is null or p_limit not between 1 and 50
  or p_offset is null or p_offset not between 0 and 100000 then return jsonb_build_object('error','invalid_record');end if;
 c:=public.operator_workflow_context(p_tenant_id,p_actor_id,p_kind,false);if c?'error' then return c;end if;
 select count(*) into n from public.operator_workflow_records where tenant_id=p_tenant_id and kind=p_kind;
 select coalesce(jsonb_agg(public.operator_workflow_metadata(q)), '[]'::jsonb) into rows from
  (select * from public.operator_workflow_records where tenant_id=p_tenant_id and kind=p_kind
   order by case when p_kind='delivery_task' then (payload->>'durationMinutes')::bigint*(payload->>'repetitions')::bigint else null end desc,
    created_at desc,id desc limit p_limit offset p_offset) q;
 return jsonb_build_object('data',rows,'meta',jsonb_build_object('limit',p_limit,'offset',p_offset,'hasMore',n>p_offset+p_limit));
end $$;
create function public.reconcile_operator_workflow(p_tenant_id uuid,p_actor_id uuid,p_operation_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c jsonb;r public.operator_workflow_records;
begin
 if p_operation_key is null then return jsonb_build_object('error','invalid_record');end if;
 c:=public.operator_workflow_context(p_tenant_id,p_actor_id,null,false);if c?'error' then return c;end if;
 select * into r from public.operator_workflow_records where tenant_id=p_tenant_id and operation_key=p_operation_key and created_by=p_actor_id;
 if not found then return jsonb_build_object('data',null);end if;
 c:=public.operator_workflow_source(p_tenant_id,r.payload);if c?'error' then return c;end if;
 return jsonb_build_object('data',public.operator_workflow_metadata(r));
end $$;
create function public.read_operator_workflow(p_tenant_id uuid,p_actor_id uuid,p_record_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c jsonb;r public.operator_workflow_records;
begin
 if p_record_id is null then return jsonb_build_object('error','invalid_record');end if;
 c:=public.operator_workflow_context(p_tenant_id,p_actor_id,null,false);if c?'error' then return c;end if;
 select * into r from public.operator_workflow_records where tenant_id=p_tenant_id and id=p_record_id;
 if not found then return jsonb_build_object('error','record_not_found');end if;
 c:=public.operator_workflow_source(p_tenant_id,r.payload);if c?'error' then return c;end if;
 return jsonb_build_object('data',public.operator_workflow_metadata(r));
end $$;
-- A page of drafts must not mistake globally truncated review history for a
-- pending decision. Resolve each draft through its own terminal state.
create function public.read_operator_policy_review(p_tenant_id uuid,p_actor_id uuid,p_draft_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c jsonb;draft_record public.operator_workflow_records;review_record public.operator_workflow_records;
 d public.policy_drafts;rows jsonb:='[]'::jsonb;
begin
 if p_draft_id is null then return jsonb_build_object('error','invalid_record');end if;
 c:=public.operator_workflow_context(p_tenant_id,p_actor_id,null,false);if c?'error' then return c;end if;
 select * into draft_record from public.operator_workflow_records where tenant_id=p_tenant_id and id=p_draft_id and kind='policy_draft';
 if not found then return jsonb_build_object('error','draft_not_found');end if;
 c:=public.operator_workflow_source(p_tenant_id,draft_record.payload);if c?'error' then return c;end if;
 select * into d from public.policy_drafts where tenant_id=p_tenant_id and id=p_draft_id for share;
 if not found or d.content_sha256 is distinct from draft_record.content_sha256
  or d.content is distinct from draft_record.payload->>'content' then return jsonb_build_object('error','digest_mismatch');end if;
 select * into review_record from public.operator_workflow_records where tenant_id=p_tenant_id and kind='policy_review' and policy_draft_id=p_draft_id;
 if found then
  if review_record.payload->>'draftId' is distinct from p_draft_id::text
   or review_record.content_sha256 is distinct from d.content_sha256
   or review_record.payload->>'expectedHash' is distinct from d.content_sha256
   or d.reviewed_by is distinct from review_record.created_by
   or d.status is distinct from (case when review_record.payload->>'decision'='approved' then 'approved' else 'deprecated' end)
   then return jsonb_build_object('error','invalid_draft_state');end if;
  rows:=jsonb_build_array(public.operator_workflow_metadata(review_record));
 elsif d.status not in ('draft','under_review') then
  return jsonb_build_object('error','legacy_review_history_unavailable');
 end if;
 return jsonb_build_object('data',rows,'meta',jsonb_build_object('limit',1,'offset',0,'hasMore',false));
end $$;
revoke all on function public.operator_workflow_text(jsonb,integer,boolean),public.operator_workflow_uuid(jsonb,boolean),
 public.operator_workflow_valid(text,jsonb),public.operator_workflow_context(uuid,uuid,text,boolean),public.operator_workflow_source(uuid,jsonb),
 public.operator_workflow_metadata(public.operator_workflow_records),public.record_operator_workflow(uuid,uuid,uuid,text,jsonb,uuid),
 public.list_operator_workflows(uuid,uuid,text,integer,integer),public.reconcile_operator_workflow(uuid,uuid,uuid),public.read_operator_workflow(uuid,uuid,uuid),
 public.read_operator_policy_review(uuid,uuid,uuid),public.cancel_operator_workflow(uuid,uuid,uuid,text,jsonb,uuid)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.record_operator_workflow(uuid,uuid,uuid,text,jsonb,uuid),public.list_operator_workflows(uuid,uuid,text,integer,integer),
 public.reconcile_operator_workflow(uuid,uuid,uuid),public.read_operator_workflow(uuid,uuid,uuid),public.read_operator_policy_review(uuid,uuid,uuid),
 public.cancel_operator_workflow(uuid,uuid,uuid,text,jsonb,uuid) to human_action_writer;
