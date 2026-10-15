-- Human metadata intake: no execution approval is issued by this operation.
alter type public.ledger_action_type add value if not exists 'engagement.created';

create table public.engagement_intake_receipts (
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 actor_id uuid not null references public.users(id) on delete restrict,
 operation_key text not null check(octet_length(operation_key) between 8 and 1024),
 engagement_id uuid not null references public.engagements(id) on delete restrict,
 request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
 request_body jsonb not null,
 correlation_id uuid not null,
 ledger_receipt bigint not null,
 created_at timestamptz not null default clock_timestamp(),
 primary key(tenant_id,actor_id,operation_key),unique(engagement_id),
 foreign key(tenant_id,ledger_receipt) references public.audit_ledger(tenant_id,id) on delete restrict,
 check(request_sha256=encode(sha256(convert_to(request_body::text,'UTF8')),'hex'))
);
alter table public.engagement_intake_receipts enable row level security;
revoke all on public.engagement_intake_receipts from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
create trigger engagement_intake_immutable before update or delete on public.engagement_intake_receipts
 for each row execute function public.evidence_receipt_immutable();
create trigger engagement_intake_no_truncate before truncate on public.engagement_intake_receipts
 for each statement execute function public.evidence_receipt_immutable();

-- Operational key bindings include historical reconciliation without inventing a
-- creation receipt. Distinct HTTP keys may truthfully read the same original PK.
create table public.engagement_intake_operations (
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 actor_id uuid not null references public.users(id) on delete restrict,
 operation_key text not null check(length(operation_key) between 8 and 256 and octet_length(operation_key)<=1024),
 request_body jsonb not null,request_sha256 text not null,
 engagement_id uuid not null references public.engagements(id) on delete restrict,
 ledger_receipt bigint,
 primary key(tenant_id,actor_id,operation_key),
 foreign key(tenant_id,ledger_receipt) references public.audit_ledger(tenant_id,id) on delete restrict,
 check(request_sha256=encode(sha256(convert_to(request_body::text,'UTF8')),'hex'))
);
alter table public.engagement_intake_operations enable row level security;
revoke all on public.engagement_intake_operations from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
create trigger engagement_intake_operation_immutable before update or delete on public.engagement_intake_operations
 for each row execute function public.evidence_receipt_immutable();
create trigger engagement_intake_operation_no_truncate before truncate on public.engagement_intake_operations
 for each statement execute function public.evidence_receipt_immutable();

-- Bind both sides; a generic human/producer ledger call cannot forge a receipt.
create function controller_security.intake135_binding() returns trigger
language plpgsql security definer set search_path='' as $$
declare r public.engagement_intake_receipts;l public.audit_ledger;
begin
 if tg_table_name='audit_ledger' then
  if new.action_type::text<>'engagement.created' then return null;end if;
  select * into r from public.engagement_intake_receipts where tenant_id=new.tenant_id and ledger_receipt=new.id;
  l:=new;
 else
  r:=new;
  select * into l from public.audit_ledger where tenant_id=r.tenant_id and id=r.ledger_receipt;
 end if;
 if r.engagement_id is null or l.id is null or l.action_type::text<>'engagement.created'
 or l.actor_type::text<>'human' or l.actor_id is distinct from r.actor_id::text
 or l.target_ref is distinct from r.engagement_id::text or l.input_hash is distinct from r.request_sha256
 or l.correlation_id is distinct from r.correlation_id or l.result::text<>'success'
 or l.detail is distinct from jsonb_build_object('request',r.request_body,'operation_key',r.operation_key)
 then raise exception 'intake receipt binding refused' using errcode='23514';end if;
 return null;
end $$;
revoke all on function controller_security.intake135_binding() from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
create constraint trigger intake_receipt_binding after insert on public.engagement_intake_receipts
 deferrable initially deferred for each row execute function controller_security.intake135_binding();
create constraint trigger intake_ledger_binding after insert on public.audit_ledger
 deferrable initially deferred for each row execute function controller_security.intake135_binding();

create function public.create_engagement_intake(
 p_tenant_id uuid,p_actor_id uuid,p_operation_key text,p_request_key uuid,
 p_title text,p_library_version text,p_estate_id uuid,p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare role_name public.user_role;internal boolean;body jsonb;digest text;r public.engagement_intake_receipts;
 o public.engagement_intake_operations;e public.engagements;lib public.control_libraries;estate public.estates;receipt bigint;
begin
 -- Same capability set as ENGAGEMENT_CREATE, locked against concurrent revocation.
 select role into role_name from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 select is_axiom_internal into internal from public.users where id=p_actor_id for share;
 if role_name is null or role_name not in ('founder','axiom_analyst','owner','admin','reviewer')
 or internal is null or (role_name in ('founder','axiom_analyst') and internal is distinct from true)
 then return jsonb_build_object('error','forbidden');end if;
 if p_operation_key is null or length(p_operation_key) not between 8 and 256 or octet_length(p_operation_key)>1024
 or p_title is null or length(p_title) not between 3 and 200
 or p_library_version is null or length(p_library_version) not between 1 and 200 or p_correlation_id is null
 then return jsonb_build_object('error','validation_failed');end if;
 body:=jsonb_build_object('title',p_title,'libraryVersion',p_library_version,'estateId',p_estate_id,'requestKey',p_request_key);
 digest:=encode(sha256(convert_to(body::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended('engagement-intake-operation:'||p_tenant_id::text||':'||p_actor_id::text||':'||p_operation_key,0));
 if p_request_key is not null then
  perform pg_advisory_xact_lock(hashtextextended('engagement-intake-resource:'||p_request_key::text,0));
 end if;
 select * into o from public.engagement_intake_operations where tenant_id=p_tenant_id and actor_id=p_actor_id and operation_key=p_operation_key;
 if o.engagement_id is not null then
  if o.request_sha256<>digest then return jsonb_build_object('error','request_key_conflict');end if;
  return jsonb_build_object('id',o.engagement_id,'receipt',o.ledger_receipt::text,'legacy',o.ledger_receipt is null,'replayed',true);
 end if;
 if p_request_key is not null then select * into r from public.engagement_intake_receipts where engagement_id=p_request_key;end if;
 if r.engagement_id is not null then
  if r.tenant_id<>p_tenant_id or r.actor_id<>p_actor_id or r.request_sha256<>digest
  then return jsonb_build_object('error','request_key_conflict');end if;
  insert into public.engagement_intake_operations values(p_tenant_id,p_actor_id,p_operation_key,body,digest,r.engagement_id,r.ledger_receipt);
  return jsonb_build_object('id',r.engagement_id,'receipt',r.ledger_receipt::text,'legacy',false,'replayed',true);
 end if;
 -- Preserve pre-migration exact primary-key readback without inventing history.
 if p_request_key is not null then
  select * into e from public.engagements where id=p_request_key for share;
  if e.id is not null then
   if e.tenant_id<>p_tenant_id or e.lead_reviewer_id is distinct from p_actor_id or e.title is distinct from p_title
    or e.library_version is distinct from p_library_version or e.estate_id is distinct from p_estate_id
   then return jsonb_build_object('error','request_key_conflict');end if;
   insert into public.engagement_intake_operations values(p_tenant_id,p_actor_id,p_operation_key,body,digest,e.id,null);
   return jsonb_build_object('id',e.id,'receipt',null,'legacy',true,'replayed',true);
  end if;
 end if;
 select * into lib from public.control_libraries where version=p_library_version for share;
 if lib.version is null or lib.status<>'published' or lib.is_current is distinct from true
 then return jsonb_build_object('error','invalid_library');end if;
 if p_estate_id is not null then
  select * into estate from public.estates where tenant_id=p_tenant_id and id=p_estate_id for share;
  if estate.id is null then return jsonb_build_object('error','invalid_reference');end if;
  if estate.status<>'active' then return jsonb_build_object('error','estate_archived');end if;
 end if;
 insert into public.engagements(id,tenant_id,library_version,estate_id,title,lead_reviewer_id,status)
 values(coalesce(p_request_key,gen_random_uuid()),p_tenant_id,p_library_version,p_estate_id,p_title,p_actor_id,'intake') returning * into e;
 receipt:=public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
 'engagement.created',e.id::text,digest,null,null,null,null,null,'success',jsonb_build_object('request',body,'operation_key',p_operation_key));
 insert into public.engagement_intake_receipts(tenant_id,actor_id,operation_key,engagement_id,request_sha256,request_body,correlation_id,ledger_receipt)
 values(p_tenant_id,p_actor_id,p_operation_key,e.id,digest,body,p_correlation_id,receipt);
 insert into public.engagement_intake_operations values(p_tenant_id,p_actor_id,p_operation_key,body,digest,e.id,receipt);
 return jsonb_build_object('id',e.id,'receipt',receipt::text,'legacy',false,'replayed',false);
end $$;
revoke all on function public.create_engagement_intake(uuid,uuid,text,uuid,text,text,uuid,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.create_engagement_intake(uuid,uuid,text,uuid,text,text,uuid,uuid) to human_action_writer;

create or replace function public.append_agent_ledger(p_tenant_id uuid,p_correlation_id uuid,p_actor_type public.actor_type,p_actor_id text,
 p_agent_version text,p_model_id text,p_prompt_hash text,p_action_type public.ledger_action_type,p_target_ref text,p_input_hash text,
 p_output_hash text,p_approval_token_id uuid,p_approver_id uuid,p_pre_state_ref text,p_post_state_ref text,p_result public.ledger_result,p_detail jsonb)
returns bigint language plpgsql security definer set search_path='' as $$
begin
 if p_action_type::text in ('engagement.created','public_control.review_recorded','public_control.review_cancelled','prativedan.draft.requested','prativedan.draft.claimed','prativedan.draft.settled','prativedan.draft.reviewed')
  or (p_action_type::text='report.generated' and exists(select 1 from public.prativedan_draft_requests
   where tenant_id=p_tenant_id and run_id::text=p_detail->>'run_id'))
 then raise exception 'dedicated controller receipt required' using errcode='42501';end if;
 return controller_security.append_agent_ledger_before_0126(p_tenant_id,p_correlation_id,p_actor_type,p_actor_id,
  p_agent_version,p_model_id,p_prompt_hash,p_action_type,p_target_ref,p_input_hash,p_output_hash,p_approval_token_id,p_approver_id,
  p_pre_state_ref,p_post_state_ref,p_result,p_detail);
end $$;
revoke all on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
grant execute on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) to agent_ledger_writer;
