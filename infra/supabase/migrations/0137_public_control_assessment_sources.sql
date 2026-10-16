-- Human-review provenance bound to the existing assessment dispatch. Worker
-- input/result codecs are unchanged; these are declarations, not verified evidence.
alter type public.ledger_action_type add value if not exists 'assessment.source_cancelled';
create table public.assessment_source_cancellations (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,actor_id uuid not null references public.users(id),
 job_id uuid not null,engagement_id uuid not null,request_text text not null check(octet_length(request_text)<=131072),
 request_sha256 text not null check(request_sha256=encode(sha256(convert_to(request_text,'UTF8')),'hex')),
 reason text not null check(length(reason) between 1 and 2000 and reason~'[^[:space:]]'),
 cancellation_text text not null check(octet_length(cancellation_text)<=16384),
 cancellation_sha256 text not null check(cancellation_sha256=encode(sha256(convert_to(cancellation_text,'UTF8')),'hex')),
 receipt_id bigint not null,created_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,actor_id,job_id),unique(tenant_id,receipt_id),
 foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id),
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id)
);
create trigger assessment_source_cancel_immutable before update or delete on public.assessment_source_cancellations for each row execute function public.evidence_receipt_immutable();
create trigger assessment_source_cancel_no_truncate before truncate on public.assessment_source_cancellations for each statement execute function public.evidence_receipt_immutable();
alter table public.assessment_source_cancellations enable row level security;
revoke all on public.assessment_source_cancellations from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
create table public.public_control_assessment_sources (
 job_id uuid primary key references public.assessment_dispatch_jobs(id),
 run_id uuid not null unique references public.workload_task_delegations(run_id),
 tenant_id uuid not null, actor_id uuid not null references public.users(id),
 engagement_id uuid not null, estate_id uuid, review_id uuid not null,
 request_sha256 text not null, snapshot_sha256 text not null,
 input_text text not null check(octet_length(input_text)<=131072),
 input_sha256 text not null check(input_sha256=encode(sha256(convert_to(input_text,'UTF8')),'hex')),
 requested_receipt bigint not null, review_receipt bigint not null, capture_receipt bigint not null,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id),
 foreign key(tenant_id,estate_id) references public.estates(tenant_id,id),
 foreign key(tenant_id,review_id) references public.public_control_review_sets(tenant_id,id),
 foreign key(tenant_id,requested_receipt) references public.audit_ledger(tenant_id,id),
 foreign key(tenant_id,review_receipt) references public.audit_ledger(tenant_id,id),
 foreign key(tenant_id,capture_receipt) references public.audit_ledger(tenant_id,id)
);
create trigger public_control_assessment_source_immutable before update or delete on public.public_control_assessment_sources for each row execute function public.evidence_receipt_immutable();
create trigger public_control_assessment_source_no_truncate before truncate on public.public_control_assessment_sources for each statement execute function public.evidence_receipt_immutable();
alter table public.public_control_assessment_sources enable row level security;
revoke all on public.public_control_assessment_sources from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;

-- Reciprocal provenance closure is checked at transaction commit as well as
-- by the dedicated writer; a valid-looking receipt cannot be swapped in.
create function controller_security.validate_public_control_assessment_source()
returns trigger language plpgsql security definer set search_path='' as $$
declare j public.assessment_dispatch_jobs;r public.public_control_review_sets;a public.audit_ledger;run public.agent_runs;snap jsonb;expected text;
begin
 select * into j from public.assessment_dispatch_jobs where id=new.job_id;
 select * into r from public.public_control_review_sets where tenant_id=new.tenant_id and id=new.review_id;
 select * into a from public.audit_ledger where tenant_id=new.tenant_id and id=new.requested_receipt;
 select * into run from public.agent_runs where tenant_id=new.tenant_id and id=new.run_id;
 snap:=r.snapshot_text::jsonb;
 expected:=controller_security.canonical_questionnaire_json(jsonb_build_object(
  'tenant_id',new.tenant_id,'engagement_id',new.engagement_id,'library_version','0.1.1',
  'answers',snap->'normalizedAnswers','sdf_self_attested',snap->'request'->'applicability'->'sdfSelfAttested',
  'processes_children',snap->'request'->'applicability'->'processesChildren','processes_health',snap->'request'->'applicability'->'processesHealth'));
 if j.id is null or r.id is null or a.id is null or run.id is null
  or j.tenant_id is distinct from new.tenant_id or j.actor_id is distinct from new.actor_id
  or j.run_id is distinct from new.run_id or j.engagement_id is distinct from new.engagement_id
  or j.estate_id is distinct from new.estate_id or j.input_hash is distinct from new.input_sha256
  or r.engagement_id is distinct from new.engagement_id or r.estate_id is distinct from new.estate_id
  or r.request_sha256 is distinct from new.request_sha256 or r.snapshot_sha256 is distinct from new.snapshot_sha256
  or r.receipt_id is distinct from new.review_receipt or (snap->>'captureReceipt')::bigint is distinct from new.capture_receipt
  or expected is distinct from new.input_text
  or a.action_type::text is distinct from 'assessment.requested' or a.actor_type::text is distinct from 'human'
  or a.actor_id is distinct from new.actor_id::text or a.target_ref is distinct from new.job_id::text
  or a.correlation_id is distinct from new.job_id or a.input_hash is distinct from new.input_sha256
  or a.result::text is distinct from 'pending' or a.detail->>'run_id' is distinct from new.run_id::text
  or run.metadata->>'assessment_request_receipt' is distinct from new.requested_receipt::text
 then raise exception 'assessment review provenance refused' using errcode='23514';end if;
 return new;
end $$;
revoke all on function controller_security.validate_public_control_assessment_source() from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
create constraint trigger public_control_assessment_source_closure after insert on public.public_control_assessment_sources deferrable initially deferred for each row execute function controller_security.validate_public_control_assessment_source();

create function public.resolve_public_control_assessment_source(
 p_tenant_id uuid,p_actor_id uuid,p_job_id uuid,p_engagement_id uuid,
 p_review_id uuid,p_request_sha256 text,p_snapshot_sha256 text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.public_control_review_sets; j public.assessment_dispatch_jobs;
 s public.public_control_assessment_sources; ctx jsonb; snap jsonb; input_text text;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501';end if;
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for share;
 if not public.workload_task_actor_allowed(p_tenant_id,p_actor_id,'parikshan') then return jsonb_build_object('error','forbidden');end if;
 if exists(select 1 from public.assessment_source_cancellations where tenant_id=p_tenant_id and actor_id=p_actor_id and job_id=p_job_id) then return jsonb_build_object('error','assessment_source_cancelled');end if;
 select * into r from public.public_control_review_sets where tenant_id=p_tenant_id and id=p_review_id for share;
 if not found or r.engagement_id is distinct from p_engagement_id or r.request_sha256 is distinct from p_request_sha256
 or r.snapshot_sha256 is distinct from p_snapshot_sha256 then return jsonb_build_object('error','review_source_refused');end if;
 select * into j from public.assessment_dispatch_jobs where id=p_job_id;
 if found then
  select * into s from public.public_control_assessment_sources where job_id=p_job_id;
  if s.job_id is null or s.tenant_id is distinct from p_tenant_id or s.actor_id is distinct from p_actor_id
   or s.run_id is distinct from j.run_id or s.engagement_id is distinct from p_engagement_id
   or s.review_id is distinct from p_review_id or s.request_sha256 is distinct from p_request_sha256
   or s.snapshot_sha256 is distinct from p_snapshot_sha256 or s.input_sha256 is distinct from j.input_hash
   or s.estate_id is distinct from j.estate_id or j.actor_id is distinct from p_actor_id or j.tenant_id is distinct from p_tenant_id
  then return jsonb_build_object('error','dispatch_conflict');end if;
  input_text:=s.input_text;
 else
  perform pg_advisory_xact_lock(hashtextextended('public-control-review:'||p_tenant_id::text,0));
  ctx:=controller_security.public_control_review_context(p_tenant_id,p_actor_id,p_engagement_id,r.check_id,true);
  if ctx?'error' then return ctx;end if;
  if r.estate_id is distinct from (ctx->>'estateId')::uuid
   or exists(select 1 from public.public_control_review_sets where previous_review_id=r.id)
   or not controller_security.public_control_review_request_valid(r.request_text::jsonb,ctx)
  then return jsonb_build_object('error','review_source_changed');end if;
  snap:=r.snapshot_text::jsonb;
  input_text:=controller_security.canonical_questionnaire_json(jsonb_build_object(
   'tenant_id',p_tenant_id,'engagement_id',p_engagement_id,'library_version','0.1.1',
   'answers',snap->'normalizedAnswers','sdf_self_attested',snap->'request'->'applicability'->'sdfSelfAttested',
   'processes_children',snap->'request'->'applicability'->'processesChildren','processes_health',snap->'request'->'applicability'->'processesHealth'));
 end if;
 return jsonb_build_object('review',to_jsonb(r)||jsonb_build_object('receipt_id',r.receipt_id::text),
  'inputText',input_text,'inputSha256',encode(sha256(convert_to(input_text,'UTF8')),'hex'));
end $$;
revoke all on function public.resolve_public_control_assessment_source(uuid,uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.resolve_public_control_assessment_source(uuid,uuid,uuid,uuid,uuid,text,text) to human_action_writer;

-- A generic reviewed retry cannot silently drop an existing review attachment.
alter function public.recover_reviewed_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text) set schema controller_security;
revoke all on function controller_security.recover_reviewed_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
create function public.recover_reviewed_assessment_dispatch(
 p_job_id uuid,p_tenant_id uuid,p_actor_id uuid,p_workload_id uuid,p_estate_id uuid,p_engagement_id uuid,p_correlation_id uuid,p_input_hash text,p_expected_library_version text,p_expected_questionnaire_digest text
) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501';end if;
 -- Serialize prechecks with both source attachment and actor-scoped cancellation.
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform pg_advisory_xact_lock(hashtextextended(p_job_id::text,44));
 if exists(select 1 from public.assessment_source_cancellations where tenant_id=p_tenant_id and actor_id=p_actor_id and job_id=p_job_id) then return jsonb_build_object('error','assessment_source_cancelled');end if;
 if exists(select 1 from public.public_control_assessment_sources where job_id=p_job_id) then return jsonb_build_object('error','dispatch_conflict');end if;
 return controller_security.recover_reviewed_assessment_dispatch(p_job_id,p_tenant_id,p_actor_id,p_workload_id,p_estate_id,p_engagement_id,p_correlation_id,p_input_hash,p_expected_library_version,p_expected_questionnaire_digest);
end $$;
revoke all on function public.recover_reviewed_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.recover_reviewed_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text) to human_action_writer;

create function public.recover_public_control_assessment_dispatch(p_job_id uuid,p_tenant_id uuid,p_actor_id uuid,p_workload_id uuid,p_estate_id uuid,p_engagement_id uuid,p_correlation_id uuid,p_input_hash text,p_review_id uuid,p_review_request_sha256 text,p_review_snapshot_sha256 text) returns jsonb language plpgsql security definer set search_path='' as $$
declare source jsonb;r jsonb;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform pg_advisory_xact_lock(hashtextextended(p_job_id::text,44));
 if exists(select 1 from public.assessment_source_cancellations where tenant_id=p_tenant_id and actor_id=p_actor_id and job_id=p_job_id) then return jsonb_build_object('error','assessment_source_cancelled');end if;
 -- No existing operation means no historical receipt, regardless of today's source.
 if not exists(select 1 from public.assessment_dispatch_jobs where id=p_job_id) then return null;end if;
 source:=public.resolve_public_control_assessment_source(p_tenant_id,p_actor_id,p_job_id,p_engagement_id,p_review_id,p_review_request_sha256,p_review_snapshot_sha256);
 if source?'error' then return source;end if;
 if source->>'inputSha256' is distinct from p_input_hash or (source->'review'->>'estate_id')::uuid is distinct from p_estate_id then return jsonb_build_object('error','dispatch_conflict');end if;
 -- Use the actual questionnaire commitment, not a browser value.
 return controller_security.recover_reviewed_assessment_dispatch(p_job_id,p_tenant_id,p_actor_id,p_workload_id,p_estate_id,p_engagement_id,p_correlation_id,p_input_hash,
 '0.1.1',((source->'review'->>'request_text')::jsonb)->'expectedSource'->>'questionnaireDigest');
end $$;

create function public.enqueue_public_control_assessment_dispatch(p_job_id uuid,p_tenant_id uuid,p_actor_id uuid,p_workload_id uuid,p_estate_id uuid,p_engagement_id uuid,p_correlation_id uuid,p_input_hash text,p_proof_hash text,p_expires_at timestamptz,p_key_ref text,p_nonce bytea,p_ciphertext bytea,p_wrapped_key bytea,p_policy_revision integer,p_policy_fingerprint text,p_review_id uuid,p_review_request_sha256 text,p_review_snapshot_sha256 text) returns jsonb language plpgsql security definer set search_path='' as $$
declare source jsonb;reply jsonb;r public.public_control_review_sets;requested bigint;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform pg_advisory_xact_lock(hashtextextended(p_job_id::text,44));
 reply:=public.recover_public_control_assessment_dispatch(p_job_id,p_tenant_id,p_actor_id,p_workload_id,p_estate_id,p_engagement_id,p_correlation_id,p_input_hash,p_review_id,p_review_request_sha256,p_review_snapshot_sha256);
 if reply is not null then return reply;end if;
 source:=public.resolve_public_control_assessment_source(p_tenant_id,p_actor_id,p_job_id,p_engagement_id,p_review_id,p_review_request_sha256,p_review_snapshot_sha256);
 if source?'error' then return source;end if;
 if source->>'inputSha256' is distinct from p_input_hash or (source->'review'->>'estate_id')::uuid is distinct from p_estate_id then return jsonb_build_object('error','dispatch_conflict');end if;
 reply:=public.enqueue_reviewed_assessment_dispatch(p_job_id,p_tenant_id,p_actor_id,p_workload_id,p_estate_id,p_engagement_id,p_correlation_id,p_input_hash,p_proof_hash,p_expires_at,p_key_ref,p_nonce,p_ciphertext,p_wrapped_key,p_policy_revision,p_policy_fingerprint,
 '0.1.1',((source->'review'->>'request_text')::jsonb)->'expectedSource'->>'questionnaireDigest');
 if reply?'error' then return reply;end if;
 select * into r from public.public_control_review_sets where id=p_review_id and tenant_id=p_tenant_id;
 select (metadata->>'assessment_request_receipt')::bigint into requested from public.agent_runs where id=(reply->>'run_id')::uuid and tenant_id=p_tenant_id;
 insert into public.public_control_assessment_sources(job_id,run_id,tenant_id,actor_id,engagement_id,estate_id,review_id,request_sha256,snapshot_sha256,input_text,input_sha256,requested_receipt,review_receipt,capture_receipt)
 values(p_job_id,(reply->>'run_id')::uuid,p_tenant_id,p_actor_id,p_engagement_id,p_estate_id,r.id,r.request_sha256,r.snapshot_sha256,source->>'inputText',p_input_hash,requested,r.receipt_id,(r.snapshot_text::jsonb->>'captureReceipt')::bigint);
 return reply;
end $$;
revoke all on function public.recover_public_control_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.recover_public_control_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,text,text) to human_action_writer;
revoke all on function public.enqueue_public_control_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text,uuid,text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.enqueue_public_control_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text,uuid,text,text) to human_action_writer;

-- Cancellation carries the same immutable reference. It never changes the
-- source attachment or permits a second dispatch; the existing unclaimed gate
-- remains the only cancellation authority.
alter function public.cancel_unclaimed_assessment_request(uuid,uuid,uuid,uuid,text,text) set schema controller_security;
revoke all on function controller_security.cancel_unclaimed_assessment_request(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
create function public.cancel_unclaimed_assessment_request(p_tenant_id uuid,p_actor_id uuid,p_job_id uuid,p_engagement_id uuid,p_library_version text,p_input_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform pg_advisory_xact_lock(hashtextextended(p_job_id::text,44));
 if exists(select 1 from public.public_control_assessment_sources where job_id=p_job_id) then return jsonb_build_object('error','cancellation_conflict');end if;
 return controller_security.cancel_unclaimed_assessment_request(p_tenant_id,p_actor_id,p_job_id,p_engagement_id,p_library_version,p_input_hash);
end $$;
revoke all on function public.cancel_unclaimed_assessment_request(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.cancel_unclaimed_assessment_request(uuid,uuid,uuid,uuid,text,text) to human_action_writer;
create function public.cancel_public_control_assessment_request(p_tenant_id uuid,p_actor_id uuid,p_job_id uuid,p_engagement_id uuid,p_library_version text,p_input_hash text,p_review_id uuid,p_review_request_sha256 text,p_review_snapshot_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare source jsonb;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform pg_advisory_xact_lock(hashtextextended(p_job_id::text,44));
 if not exists(select 1 from public.assessment_dispatch_jobs where id=p_job_id) then return jsonb_build_object('error','cancellation_conflict');end if;
 source:=public.resolve_public_control_assessment_source(p_tenant_id,p_actor_id,p_job_id,p_engagement_id,p_review_id,p_review_request_sha256,p_review_snapshot_sha256);
 if source?'error' then return source;end if;
 if p_library_version is distinct from '0.1.1' or source->>'inputSha256' is distinct from p_input_hash then return jsonb_build_object('error','cancellation_conflict');end if;
 return controller_security.cancel_unclaimed_assessment_request(p_tenant_id,p_actor_id,p_job_id,p_engagement_id,p_library_version,p_input_hash);
end $$;
revoke all on function public.cancel_public_control_assessment_request(uuid,uuid,uuid,uuid,text,text,uuid,text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.cancel_public_control_assessment_request(uuid,uuid,uuid,uuid,text,text,uuid,text,text) to human_action_writer;

-- Exact original source-only HTTP intent codec. Defaults are explicit; JSONB
-- normalization cannot hide duplicate keys, extra declarations or changed refs.
create function controller_security.assessment_source_intent(value text) returns jsonb
language plpgsql immutable set search_path='' as $$
declare v jsonb;
begin
 if value is null or octet_length(value)>131072 then return null;end if;
 begin v:=value::jsonb;exception when others then return null;end;
 if controller_security.canonical_questionnaire_json(v) is distinct from value
 or jsonb_typeof(v) is distinct from 'object' or not v?&array['operationKey','engagementId','answers','applicability','reviewRef']
 or v-array['operationKey','engagementId','answers','applicability','reviewRef']<>'{}'::jsonb
 or v->'answers' is distinct from '{}'::jsonb
 or v->'applicability' is distinct from '{"sdfSelfAttested":null,"processesChildren":null,"processesHealth":null}'::jsonb
 or jsonb_typeof(v->'reviewRef') is distinct from 'object' or not v->'reviewRef'?&array['reviewId','requestSha256','snapshotSha256']
 or (v->'reviewRef')-array['reviewId','requestSha256','snapshotSha256']<>'{}'::jsonb
 or (v->>'operationKey')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 or (v->>'engagementId')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 or (v->'reviewRef'->>'reviewId')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 or (v->'reviewRef'->>'requestSha256')!~'^[a-f0-9]{64}$' or (v->'reviewRef'->>'snapshotSha256')!~'^[a-f0-9]{64}$'
 or jsonb_typeof(v->'operationKey') is distinct from 'string' or jsonb_typeof(v->'engagementId') is distinct from 'string'
 or jsonb_typeof(v->'reviewRef'->'reviewId') is distinct from 'string' or jsonb_typeof(v->'reviewRef'->'requestSha256') is distinct from 'string' or jsonb_typeof(v->'reviewRef'->'snapshotSha256') is distinct from 'string'
 then return null;end if;
 return v;
end $$;
revoke all on function controller_security.assessment_source_intent(text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;

create function public.read_assessment_source_operation(p_tenant_id uuid,p_actor_id uuid,p_request_text text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v jsonb;c public.assessment_source_cancellations;j public.assessment_dispatch_jobs;s public.public_control_assessment_sources;expires timestamptz;role_name public.user_role;internal boolean;
begin
 v:=controller_security.assessment_source_intent(p_request_text);if v is null then return jsonb_build_object('error','invalid_source_intent');end if;
 select role into role_name from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 select is_axiom_internal into internal from public.users where id=p_actor_id for share;
 if role_name is null or role_name='agent' or internal is null or (role_name in ('founder','axiom_analyst') and internal is distinct from true) then return jsonb_build_object('error','forbidden');end if;
 select * into c from public.assessment_source_cancellations where tenant_id=p_tenant_id and actor_id=p_actor_id and job_id=(v->>'operationKey')::uuid;
 if found then
  if c.request_text is distinct from p_request_text then return jsonb_build_object('error','dispatch_conflict');end if;
  return jsonb_build_object('state','cancelled','data',to_jsonb(c)||jsonb_build_object('receipt_id',c.receipt_id::text));
 end if;
 select * into j from public.assessment_dispatch_jobs where id=(v->>'operationKey')::uuid;
 if not found then return jsonb_build_object('state','not_found');end if;
 select * into s from public.public_control_assessment_sources where job_id=j.id;
 if j.tenant_id is distinct from p_tenant_id or j.actor_id is distinct from p_actor_id or j.engagement_id is distinct from (v->>'engagementId')::uuid
 or s.job_id is null or s.tenant_id is distinct from p_tenant_id or s.actor_id is distinct from p_actor_id
 or s.review_id is distinct from (v->'reviewRef'->>'reviewId')::uuid
 or s.request_sha256 is distinct from v->'reviewRef'->>'requestSha256' or s.snapshot_sha256 is distinct from v->'reviewRef'->>'snapshotSha256'
 then return jsonb_build_object('error','dispatch_conflict');end if;
 select expires_at into expires from public.workload_task_delegations where run_id=j.run_id;
 return jsonb_build_object('state','recorded','jobId',j.id,'runId',j.run_id,'expiresAt',expires);
end $$;
revoke all on function public.read_assessment_source_operation(uuid,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.read_assessment_source_operation(uuid,uuid,text) to service_role,human_action_writer;

create function public.cancel_assessment_source_intent(p_tenant_id uuid,p_actor_id uuid,p_request_text text,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v jsonb;state jsonb;c public.assessment_source_cancellations;r public.public_control_review_sets;rid uuid:=gen_random_uuid();txt text;receipt bigint;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501';end if;
 v:=controller_security.assessment_source_intent(p_request_text);
 if v is null or p_reason is null or length(p_reason) not between 1 and 2000 or p_reason!~'[^[:space:]]' then return jsonb_build_object('error','invalid_source_intent');end if;
 -- Same policy/job lock order as enqueue; actor-scoped fencing cannot preempt
 -- another actor's independent same-UUID intent.
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform pg_advisory_xact_lock(hashtextextended((v->>'operationKey'),44));
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for share;
 if not public.workload_task_actor_allowed(p_tenant_id,p_actor_id,'parikshan') then return jsonb_build_object('error','forbidden');end if;
 -- Only actual same-tenant historical references qualify; current head/estate
 -- need not match when abandoning a never-recorded old intent.
 select * into r from public.public_control_review_sets where tenant_id=p_tenant_id and engagement_id=(v->>'engagementId')::uuid and id=(v->'reviewRef'->>'reviewId')::uuid for share;
 if not found or r.request_sha256 is distinct from v->'reviewRef'->>'requestSha256' or r.snapshot_sha256 is distinct from v->'reviewRef'->>'snapshotSha256' then return jsonb_build_object('error','review_source_refused');end if;
 state:=public.read_assessment_source_operation(p_tenant_id,p_actor_id,p_request_text);
 if state->>'state'='recorded' or state?'error' then return state;end if;
 if state->>'state'='cancelled' then
  if state->'data'->>'reason' is distinct from p_reason then return jsonb_build_object('error','dispatch_conflict');end if;
  return state;
 end if;
 txt:=controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'tenantId',p_tenant_id,'actorId',p_actor_id,'jobId',v->'operationKey','engagementId',v->'engagementId','requestSha256',encode(sha256(convert_to(p_request_text,'UTF8')),'hex'),'reason',p_reason));
 receipt:=public.append_ledger(p_tenant_id,(v->>'operationKey')::uuid,'human',p_actor_id::text,null,null,null,'assessment.source_cancelled',rid::text,encode(sha256(convert_to(p_request_text,'UTF8')),'hex'),encode(sha256(convert_to(txt,'UTF8')),'hex'),null,null,null,null,'success',jsonb_build_object('engagement_id',v->'engagementId','review_id',r.id,'assessment_never_dispatched',true));
 insert into public.assessment_source_cancellations(id,tenant_id,actor_id,job_id,engagement_id,request_text,request_sha256,reason,cancellation_text,cancellation_sha256,receipt_id)
 values(rid,p_tenant_id,p_actor_id,(v->>'operationKey')::uuid,(v->>'engagementId')::uuid,p_request_text,encode(sha256(convert_to(p_request_text,'UTF8')),'hex'),p_reason,txt,encode(sha256(convert_to(txt,'UTF8')),'hex'),receipt);
 return public.read_assessment_source_operation(p_tenant_id,p_actor_id,p_request_text);
end $$;
revoke all on function public.cancel_assessment_source_intent(uuid,uuid,text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.cancel_assessment_source_intent(uuid,uuid,text,text) to human_action_writer;

create function controller_security.assessment_source_cancel_receipt_binding() returns trigger
language plpgsql security definer set search_path='' as $$
declare c public.assessment_source_cancellations;l public.audit_ledger;receipt bigint;v jsonb;expected text;
begin
 if tg_table_name='audit_ledger' then receipt:=new.id;else receipt:=new.receipt_id;end if;
 select * into c from public.assessment_source_cancellations where receipt_id=receipt;
 select * into l from public.audit_ledger where id=receipt;
 v:=controller_security.assessment_source_intent(c.request_text);
 expected:=controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'tenantId',c.tenant_id,'actorId',c.actor_id,'jobId',c.job_id,'engagementId',c.engagement_id,'requestSha256',c.request_sha256,'reason',c.reason));
 if c.id is null or l.id is null or v is null or c.job_id is distinct from (v->>'operationKey')::uuid or c.engagement_id is distinct from (v->>'engagementId')::uuid
 or c.cancellation_text is distinct from expected or l.tenant_id is distinct from c.tenant_id or l.actor_type::text is distinct from 'human'
 or l.actor_id is distinct from c.actor_id::text or l.target_ref is distinct from c.id::text or l.correlation_id is distinct from c.job_id
 or l.action_type::text is distinct from 'assessment.source_cancelled' or l.input_hash is distinct from c.request_sha256 or l.output_hash is distinct from c.cancellation_sha256 or l.result::text is distinct from 'success'
 then raise exception 'source cancellation receipt binding refused' using errcode='42501';end if;
 return new;
end $$;
revoke all on function controller_security.assessment_source_cancel_receipt_binding() from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
create constraint trigger assessment_source_cancel_receipt after insert on public.assessment_source_cancellations deferrable initially deferred for each row execute function controller_security.assessment_source_cancel_receipt_binding();
create constraint trigger assessment_source_cancel_ledger_receipt after insert on public.audit_ledger deferrable initially deferred for each row when(new.action_type::text='assessment.source_cancelled') execute function controller_security.assessment_source_cancel_receipt_binding();

-- Preserve every existing producer restriction while fencing the new human
-- cancellation receipt; the reciprocal trigger also rejects generic forgeries.
alter function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) set schema controller_security;
alter function controller_security.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) rename to append_agent_ledger_before_0137;
revoke all on function controller_security.append_agent_ledger_before_0137(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
create function public.append_agent_ledger(p_tenant_id uuid,p_correlation_id uuid,p_actor_type public.actor_type,p_actor_id text,p_agent_version text,p_model_id text,p_prompt_hash text,p_action_type public.ledger_action_type,p_target_ref text,p_input_hash text,p_output_hash text,p_approval_token_id uuid,p_approver_id uuid,p_pre_state_ref text,p_post_state_ref text,p_result public.ledger_result,p_detail jsonb)
returns bigint language plpgsql security definer set search_path='' as $$
begin
 if p_action_type::text='assessment.source_cancelled' then raise exception 'human source cancellation required' using errcode='42501';end if;
 return controller_security.append_agent_ledger_before_0137(p_tenant_id,p_correlation_id,p_actor_type,p_actor_id,p_agent_version,p_model_id,p_prompt_hash,p_action_type,p_target_ref,p_input_hash,p_output_hash,p_approval_token_id,p_approver_id,p_pre_state_ref,p_post_state_ref,p_result,p_detail);
end $$;
revoke all on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) to agent_ledger_writer;
