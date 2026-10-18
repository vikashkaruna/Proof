-- 0160 (item 8a, step 2): the downstream public-control functions stop
-- pinning catalogue 0.1.1. Each now takes the library version from the
-- recorded human review request (expectedSource.libraryVersion, already
-- checked against public.approved_catalogue_versions by the 0159 gate when the
-- review was recorded) and checks membership in the registry where it used to
-- compare with a literal. Report provenance reads the questionnaire digest,
-- rows hash and mapping version from the registry row. The public-evidence-1
-- mapping manifest is still checked by digest, so a version with another
-- mapping is refused until its manifest is added (8b). For 0.1.1 the
-- behaviour is unchanged. The two validators that now read the registry are
-- STABLE instead of IMMUTABLE.
create function controller_security.catalogue_approved(p_library_version text, p_mapping_version text)
returns boolean language sql stable security definer set search_path='' as $$
 select p_library_version is not null and exists(
  select 1 from public.approved_catalogue_versions
  where library_version=p_library_version
    and (p_mapping_version is null or mapping_version=p_mapping_version));
$$;
revoke all on function controller_security.catalogue_approved(text,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

CREATE OR REPLACE FUNCTION controller_security.coverage144_original(kind text, txt text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare v jsonb;keys text[];
begin
 if kind not in ('board','auditor') or txt is null or octet_length(txt)>4194304
  or not controller_security.coverage144_unique(txt::json,0) then
  raise exception 'coverage source refused' using errcode='22023';end if;
 v:=txt::jsonb; -- PostgreSQL rejects unrepresentable/lone surrogate scalar escapes.
 keys:=array['schema_version','serialization','kind','request_id','tenant_id','engagement_id',
 'assessment_run_id','library_version','controls_text','controls_sha256','result_text','result_sha256',
 'finalized_at','receipts','completed_at','limitations','human_control_review'];
 if kind='auditor' then keys:=keys||array['report_kind'];end if;
 if jsonb_typeof(v) is distinct from 'object' or not(v?&keys) or v-keys<>'{}'::jsonb
  or v->'schema_version' not in ('2'::jsonb,'3'::jsonb)
  or v->>'serialization' is distinct from 'postgres-jsonb-text-v1'
  or v->>'kind' is distinct from (case kind when 'board' then 'board_source' else 'statutory_source' end)
  or (kind='auditor' and v->>'report_kind' is distinct from 'auditor')
  or not controller_security.catalogue_approved(v->>'library_version',null)
  or v->'human_control_review'->'schema_version' is distinct from
     (case when v->'schema_version'='3'::jsonb then '2'::jsonb else '1'::jsonb end)
  or v->'human_control_review'->'declarations_verified' is distinct from 'false'::jsonb
  or v->'human_control_review'->'evidence_verified' is distinct from 'false'::jsonb
  or v->'human_control_review'->'review_required' is distinct from 'true'::jsonb
  or v->>'controls_sha256' is distinct from encode(sha256(convert_to(v->>'controls_text','UTF8')),'hex')
  or v->>'result_sha256' is distinct from encode(sha256(convert_to(v->>'result_text','UTF8')),'hex')
 then raise exception 'coverage source refused' using errcode='22023';end if;
 return v;
end $function$;

CREATE OR REPLACE FUNCTION controller_security.public_control_review_request_shape(v jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare k text;kv record;q record;j jsonb;ord jsonb;counted integer:=0;uuid_pattern text:='^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$';
begin
 if jsonb_typeof(v) is distinct from 'object' or not v?&array['version','operationKey','engagementId','checkId','expectedEstateId','expectedPreviousReviewId','expectedSource','answers','applicability'] or v-array['version','operationKey','engagementId','checkId','expectedEstateId','expectedPreviousReviewId','expectedSource','answers','applicability']<>'{}'::jsonb or v->'version' is distinct from '1'::jsonb then return false;end if;
 foreach k in array array['operationKey','engagementId','checkId','expectedEstateId','expectedPreviousReviewId'] loop
 if v->k='null'::jsonb and k in ('expectedEstateId','expectedPreviousReviewId') then continue;end if;
 if jsonb_typeof(v->k) is distinct from 'string' or v->>k !~ uuid_pattern then return false;end if;end loop;
 j:=v->'expectedSource';
 if jsonb_typeof(j) is distinct from 'object' or not j?&array['payloadSha256','catalogueManifestSha256','mappingVersion','libraryVersion','questionnaireDigest'] or j-array['payloadSha256','catalogueManifestSha256','mappingVersion','libraryVersion','questionnaireDigest']<>'{}'::jsonb or not controller_security.catalogue_approved(j->>'libraryVersion',coalesce(j->>'mappingVersion','')) then return false;end if;
 foreach k in array array['payloadSha256','catalogueManifestSha256','questionnaireDigest'] loop if jsonb_typeof(j->k) is distinct from 'string' or j->>k !~'^[a-f0-9]{64}$' then return false;end if;end loop;
 j:=v->'applicability';
 if jsonb_typeof(j) is distinct from 'object' or not j?&array['sdfSelfAttested','processesChildren','processesHealth','rationale'] or j-array['sdfSelfAttested','processesChildren','processesHealth','rationale']<>'{}'::jsonb or jsonb_typeof(j->'rationale') is distinct from 'string' or length(j->>'rationale') not between 1 and 2000 or j->>'rationale'!~'[^[:space:]]' then return false;end if;
 foreach k in array array['sdfSelfAttested','processesChildren','processesHealth'] loop if jsonb_typeof(j->k) not in ('boolean','null') then return false;end if;end loop;
 if jsonb_typeof(v->'answers') is distinct from 'object' or (select count(*)>46 from jsonb_object_keys(v->'answers')) then return false;end if;
 for kv in select * from jsonb_each(v->'answers') loop
 if length(kv.key) not between 1 and 200 or jsonb_typeof(kv.value) is distinct from 'object' then return false;end if;
 for q in select * from jsonb_each(kv.value) loop
 counted:=counted+1;j:=q.value;
 if counted>5000 or length(q.key) not between 1 and 200 or jsonb_typeof(j) is distinct from 'object' or not j?&array['answer','rationale','candidateOrdinals'] or j-array['answer','rationale','candidateOrdinals']<>'{}'::jsonb or jsonb_typeof(j->'answer') not in ('boolean','null') or jsonb_typeof(j->'rationale') is distinct from 'string' or length(j->>'rationale') not between 1 and 2000 or j->>'rationale'!~'[^[:space:]]' or jsonb_typeof(j->'candidateOrdinals') is distinct from 'array' then return false;end if;
 if jsonb_array_length(j->'candidateOrdinals')>128 or (select count(*)<>count(distinct value) from jsonb_array_elements(j->'candidateOrdinals')) then return false;end if;
 for ord in select value from jsonb_array_elements(j->'candidateOrdinals') loop if jsonb_typeof(ord) is distinct from 'number' or ord::text!~'^[1-9][0-9]{0,2}$' or ord::text::integer>128 then return false;end if;end loop;
 end loop;end loop;return true;
end $function$;

CREATE OR REPLACE FUNCTION controller_security.validate_public_control_assessment_source()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare j public.assessment_dispatch_jobs;r public.public_control_review_sets;a public.audit_ledger;run public.agent_runs;snap jsonb;expected text;
begin
 select * into j from public.assessment_dispatch_jobs where id=new.job_id;
 select * into r from public.public_control_review_sets where tenant_id=new.tenant_id and id=new.review_id;
 select * into a from public.audit_ledger where tenant_id=new.tenant_id and id=new.requested_receipt;
 select * into run from public.agent_runs where tenant_id=new.tenant_id and id=new.run_id;
 snap:=r.snapshot_text::jsonb;
 expected:=controller_security.canonical_questionnaire_json(jsonb_build_object(
  'tenant_id',new.tenant_id,'engagement_id',new.engagement_id,'library_version',snap->'request'->'expectedSource'->>'libraryVersion',
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
end $function$;

CREATE OR REPLACE FUNCTION public.resolve_public_control_assessment_source(p_tenant_id uuid, p_actor_id uuid, p_job_id uuid, p_engagement_id uuid, p_review_id uuid, p_request_sha256 text, p_snapshot_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.public_control_review_sets; j public.assessment_dispatch_jobs;
 s public.public_control_assessment_sources; ctx jsonb; snap jsonb; input_text text;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform pg_advisory_xact_lock(hashtextextended(p_job_id::text,44));
 lock table public.kill_switch_state in share mode;
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
  perform controller_security.review141_prelock(p_tenant_id,p_actor_id,p_engagement_id,r.estate_id,r.request_text::jsonb,false);
  perform pg_advisory_xact_lock(hashtextextended('public-control-review:'||p_tenant_id::text,0));
  ctx:=controller_security.public_control_review_context(p_tenant_id,p_actor_id,p_engagement_id,r.check_id,true);
  if ctx?'error' then return ctx;end if;
  if r.estate_id is distinct from (ctx->>'estateId')::uuid
   or exists(select 1 from public.public_control_review_sets where previous_review_id=r.id)
   or not controller_security.public_control_review_request_valid(case when r.request_codec='axiom-public-control-review-request-canonical-json-2' then controller_security.review141_v1_request(r.request_text::jsonb) else r.request_text::jsonb end,ctx)
  then return jsonb_build_object('error','review_source_changed');end if;
  snap:=r.snapshot_text::jsonb;
  input_text:=controller_security.canonical_questionnaire_json(jsonb_build_object(
   'tenant_id',p_tenant_id,'engagement_id',p_engagement_id,'library_version',snap->'request'->'expectedSource'->>'libraryVersion',
   'answers',snap->'normalizedAnswers','sdf_self_attested',snap->'request'->'applicability'->'sdfSelfAttested',
   'processes_children',snap->'request'->'applicability'->'processesChildren','processes_health',snap->'request'->'applicability'->'processesHealth'));
 end if;
 return jsonb_build_object('review',to_jsonb(r)||jsonb_build_object('receipt_id',r.receipt_id::text),
  'inputText',input_text,'inputSha256',encode(sha256(convert_to(input_text,'UTF8')),'hex'));
end $function$;

CREATE OR REPLACE FUNCTION public.cancel_public_control_assessment_request(p_tenant_id uuid, p_actor_id uuid, p_job_id uuid, p_engagement_id uuid, p_library_version text, p_input_hash text, p_review_id uuid, p_review_request_sha256 text, p_review_snapshot_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare source jsonb;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform pg_advisory_xact_lock(hashtextextended(p_job_id::text,44));
 if not exists(select 1 from public.assessment_dispatch_jobs where id=p_job_id) then return jsonb_build_object('error','cancellation_conflict');end if;
 source:=public.resolve_public_control_assessment_source(p_tenant_id,p_actor_id,p_job_id,p_engagement_id,p_review_id,p_review_request_sha256,p_review_snapshot_sha256);
 if source?'error' then return source;end if;
 if p_library_version is distinct from ((source->'review'->>'request_text')::jsonb)->'expectedSource'->>'libraryVersion' or not controller_security.catalogue_approved(p_library_version,null) or source->>'inputSha256' is distinct from p_input_hash then return jsonb_build_object('error','cancellation_conflict');end if;
 return controller_security.cancel_unclaimed_assessment_request(p_tenant_id,p_actor_id,p_job_id,p_engagement_id,p_library_version,p_input_hash);
end $function$;

CREATE OR REPLACE FUNCTION public.enqueue_public_control_assessment_dispatch(p_job_id uuid, p_tenant_id uuid, p_actor_id uuid, p_workload_id uuid, p_estate_id uuid, p_engagement_id uuid, p_correlation_id uuid, p_input_hash text, p_proof_hash text, p_expires_at timestamp with time zone, p_key_ref text, p_nonce bytea, p_ciphertext bytea, p_wrapped_key bytea, p_policy_revision integer, p_policy_fingerprint text, p_review_id uuid, p_review_request_sha256 text, p_review_snapshot_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare source jsonb;reply jsonb;r public.public_control_review_sets;requested bigint;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform pg_advisory_xact_lock(hashtextextended(p_job_id::text,44));
 reply:=public.recover_public_control_assessment_dispatch(p_job_id,p_tenant_id,p_actor_id,p_workload_id,p_estate_id,p_engagement_id,p_correlation_id,p_input_hash,p_review_id,p_review_request_sha256,p_review_snapshot_sha256);
 if reply is not null then return reply;end if;
 select * into r from public.public_control_review_sets where tenant_id=p_tenant_id and id=p_review_id;
 lock table public.kill_switch_state in share mode;
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for share;
 if not public.workload_task_actor_allowed(p_tenant_id,p_actor_id,'parikshan') then return jsonb_build_object('error','forbidden');end if;
 if r.id is null then return jsonb_build_object('error','review_source_refused');end if;
 perform controller_security.review141_prelock(p_tenant_id,p_actor_id,p_engagement_id,r.estate_id,r.request_text::jsonb,true);
 source:=public.resolve_public_control_assessment_source(p_tenant_id,p_actor_id,p_job_id,p_engagement_id,p_review_id,p_review_request_sha256,p_review_snapshot_sha256);
 if source?'error' then return source;end if;
 if source->>'inputSha256' is distinct from p_input_hash or (source->'review'->>'estate_id')::uuid is distinct from p_estate_id then return jsonb_build_object('error','dispatch_conflict');end if;
 reply:=public.enqueue_reviewed_assessment_dispatch(p_job_id,p_tenant_id,p_actor_id,p_workload_id,p_estate_id,p_engagement_id,p_correlation_id,p_input_hash,p_proof_hash,p_expires_at,p_key_ref,p_nonce,p_ciphertext,p_wrapped_key,p_policy_revision,p_policy_fingerprint,
 ((source->'review'->>'request_text')::jsonb)->'expectedSource'->>'libraryVersion',((source->'review'->>'request_text')::jsonb)->'expectedSource'->>'questionnaireDigest');
 if reply?'error' then return reply;end if;
 select * into r from public.public_control_review_sets where id=p_review_id and tenant_id=p_tenant_id;
 select (metadata->>'assessment_request_receipt')::bigint into requested from public.agent_runs where id=(reply->>'run_id')::uuid and tenant_id=p_tenant_id;
 insert into public.public_control_assessment_sources(job_id,run_id,tenant_id,actor_id,engagement_id,estate_id,review_id,request_sha256,snapshot_sha256,input_text,input_sha256,requested_receipt,review_receipt,capture_receipt)
 values(p_job_id,(reply->>'run_id')::uuid,p_tenant_id,p_actor_id,p_engagement_id,p_estate_id,r.id,r.request_sha256,r.snapshot_sha256,source->>'inputText',p_input_hash,requested,r.receipt_id,(r.snapshot_text::jsonb->>'captureReceipt')::bigint);
 return reply;
end $function$;

CREATE OR REPLACE FUNCTION public.recover_public_control_assessment_dispatch(p_job_id uuid, p_tenant_id uuid, p_actor_id uuid, p_workload_id uuid, p_estate_id uuid, p_engagement_id uuid, p_correlation_id uuid, p_input_hash text, p_review_id uuid, p_review_request_sha256 text, p_review_snapshot_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
 ((source->'review'->>'request_text')::jsonb)->'expectedSource'->>'libraryVersion',((source->'review'->>'request_text')::jsonb)->'expectedSource'->>'questionnaireDigest');
end $function$;

CREATE OR REPLACE FUNCTION public.enqueue_local_public_control_assessment_dispatch(p_job_id uuid, p_tenant_id uuid, p_actor_id uuid, p_workload_id uuid, p_estate_id uuid, p_engagement_id uuid, p_correlation_id uuid, p_input_hash text, p_proof_hash text, p_expires_at timestamp with time zone, p_key_ref text, p_nonce bytea, p_ciphertext bytea, p_wrapped_key bytea, p_custody_policy_id uuid, p_custody_policy_sha256 text, p_key_policy_sha256 text, p_activation_event_id uuid, p_activation_epoch bigint, p_deployment_binding_sha256 text, p_review_id uuid, p_review_request_sha256 text, p_review_snapshot_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare p public.local_custody_policy_versions;h public.local_custody_policy_heads;
 a public.local_custody_policy_events;r public.public_control_review_sets;
 g public.assessment_local_custody_authorizations;v jsonb;source jsonb;reply jsonb;
 requested bigint;context_text text;actors uuid[];
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then
  raise exception 'human assessment writer required' using errcode='42501';end if;
 if p_job_id is null or p_tenant_id is null or p_actor_id is null or p_workload_id is null
  or p_engagement_id is null or p_correlation_id is distinct from p_job_id
  or p_input_hash is null or p_input_hash !~ '^[a-f0-9]{64}$'
  or p_review_id is null or p_review_request_sha256 is null or p_review_request_sha256 !~ '^[a-f0-9]{64}$'
  or p_review_snapshot_sha256 is null or p_review_snapshot_sha256 !~ '^[a-f0-9]{64}$'
 then return jsonb_build_object('error','invalid_dispatch');end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform pg_advisory_xact_lock(hashtextextended(p_job_id::text,44));
 -- A historical receipt is not a NEW admission: no grant backfill, key switch,
 -- deadline extension or new current-source requirement is introduced here.
 reply:=public.recover_public_control_assessment_dispatch(p_job_id,p_tenant_id,p_actor_id,p_workload_id,p_estate_id,p_engagement_id,p_correlation_id,p_input_hash,p_review_id,p_review_request_sha256,p_review_snapshot_sha256);
 if reply is not null then return reply;end if;
 lock table public.kill_switch_state in share mode;
 select * into p from public.local_custody_policy_versions where tenant_id=p_tenant_id and id=p_custody_policy_id;
 select * into h from public.local_custody_policy_heads where tenant_id=p_tenant_id and policy_id=p_custody_policy_id;
 select * into a from public.local_custody_policy_events where tenant_id=p_tenant_id and policy_id=p_custody_policy_id and id=p_activation_event_id and transition='activate';
 if p.id is null or h.policy_id is null or a.id is null then return jsonb_build_object('error','local_policy_required');end if;
 v:=controller_security.local143_policy(p.policy_text);
 select array_agg(distinct actor order by actor) into actors from (
  select p_actor_id actor union select p.nominated_operator_id union
  select actor_id from public.local_custody_policy_events where tenant_id=p_tenant_id and policy_id=p.id and transition in ('request','approve')
 ) ids;
 -- Match policy transitions' strongest actor lock in sorted order; never
 -- acquire requester SHARE then upgrade another policy actor after review HEAD.
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=any(actors) order by user_id for share;
 perform 1 from public.users where id=any(actors) order by id for no key update;
 perform 1 from public.tenants where id=p_tenant_id for share;
 if not public.workload_task_actor_allowed(p_tenant_id,p_actor_id,'parikshan') then return jsonb_build_object('error','forbidden');end if;
 if h.state is distinct from 'active' or p.policy_sha256 is distinct from p_custody_policy_sha256
  or p.key_policy_sha256 is distinct from p_key_policy_sha256 or h.activation_epoch is distinct from p_activation_epoch
  or a.activation_epoch is distinct from p_activation_epoch
  or v->>'deploymentBindingSha256' is distinct from p_deployment_binding_sha256
  or v->>'targetWorkloadId' is distinct from p_workload_id::text
  or v#>>'{keyPolicy,primary}' is distinct from p_key_ref
  or (p.mode='local_demo' and not exists(select 1 from public.tenants where id=p_tenant_id and is_demo))
  or exists(select 1 from public.assessment_dispatch_key_policies where tenant_id=p_tenant_id)
  or not controller_security.local143_actor(p_tenant_id,p.nominated_operator_id,'activate',v)
  or not exists(select 1 from public.local_custody_policy_events e where e.tenant_id=p_tenant_id and e.policy_id=p.id and e.transition='request' and controller_security.local143_actor(p_tenant_id,e.actor_id,'request',v))
  or not exists(select 1 from public.local_custody_policy_events e where e.tenant_id=p_tenant_id and e.policy_id=p.id and e.transition='approve' and controller_security.local143_actor(p_tenant_id,e.actor_id,'approve',v))
 then return jsonb_build_object('error','local_policy_stale');end if;
 -- This reuses current review1/2, catalogue, estate and registered-asset gates.
 select * into r from public.public_control_review_sets where tenant_id=p_tenant_id and id=p_review_id;
 if r.id is null then return jsonb_build_object('error','review_source_refused');end if;
 perform controller_security.review141_prelock(p_tenant_id,p_actor_id,p_engagement_id,r.estate_id,r.request_text::jsonb,true);
 source:=public.resolve_public_control_assessment_source(p_tenant_id,p_actor_id,p_job_id,p_engagement_id,p_review_id,p_review_request_sha256,p_review_snapshot_sha256);
 if source?'error' then return source;end if;
 if source->>'inputSha256' is distinct from p_input_hash or (source->'review'->>'estate_id')::uuid is distinct from p_estate_id then return jsonb_build_object('error','dispatch_conflict');end if;
 -- The original0044 kernel delegates only Parikshan read/findings scopes and
 -- repeats stop, actor, workload, context and original deadline checks. Its ACL
 -- remains revoked; only this narrowly admitted SECURITY DEFINER may call it.
 reply:=public.enqueue_assessment_dispatch_unfenced(p_job_id,p_tenant_id,p_actor_id,p_workload_id,p_estate_id,p_engagement_id,p_correlation_id,p_input_hash,p_proof_hash,p_expires_at,p_key_ref,p_nonce,p_ciphertext,p_wrapped_key);
 if reply?'error' then return reply;end if;
 requested:=public.append_ledger(p_tenant_id=>p_tenant_id,p_correlation_id=>p_correlation_id,
  p_actor_type=>'human',p_actor_id=>p_actor_id::text,p_agent_version=>null,p_model_id=>null,p_prompt_hash=>null,
  p_action_type=>'assessment.requested',p_target_ref=>p_job_id::text,p_input_hash=>p_input_hash,p_output_hash=>null,
  p_approval_token_id=>null,p_approver_id=>null,p_pre_state_ref=>null,p_post_state_ref=>null,p_result=>'pending',
  p_detail=>jsonb_build_object('purpose','durable_assessment','job_id',p_job_id,'run_id',reply->>'run_id',
   'workload_id',p_workload_id,'estate_id',p_estate_id,'engagement_id',p_engagement_id,'library_version',r.request_text::jsonb#>>'{expectedSource,libraryVersion}',
   'custody_policy_id',p.id,'custody_policy_sha256',p.policy_sha256,
   'expected_questionnaire',jsonb_build_object('libraryVersion',r.request_text::jsonb#>>'{expectedSource,libraryVersion}','questionnaireDigest',r.request_text::jsonb#>>'{expectedSource,questionnaireDigest}')));
 update public.agent_runs set metadata=metadata||jsonb_build_object('assessment_request_receipt',requested::text,'request_kind','durable_assessment_v1') where tenant_id=p_tenant_id and id=(reply->>'run_id')::uuid;
 insert into public.public_control_assessment_sources(job_id,run_id,tenant_id,actor_id,engagement_id,estate_id,review_id,request_sha256,snapshot_sha256,input_text,input_sha256,requested_receipt,review_receipt,capture_receipt)
 values(p_job_id,(reply->>'run_id')::uuid,p_tenant_id,p_actor_id,p_engagement_id,p_estate_id,r.id,r.request_sha256,r.snapshot_sha256,source->>'inputText',p_input_hash,requested,r.receipt_id,(r.snapshot_text::jsonb->>'captureReceipt')::bigint);
 g.tenant_id:=p_tenant_id;g.job_id:=p_job_id;g.policy_id:=p.id;g.activation_event_id:=a.id;g.activation_epoch:=a.activation_epoch;
 g.request_receipt_id:=requested;g.original_expires_at:=p_expires_at;
 context_text:=controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.assessment.dispatch.dek',1,p_job_id,p_tenant_id,p_actor_id,p_workload_id,p_estate_id,p_engagement_id,p_correlation_id,p_input_hash));
 g.context_sha256:=encode(sha256(convert_to(context_text,'UTF8')),'hex');
 g.grant_text:=controller_security.canonical_questionnaire_json(controller_security.local143_job_grant(g));
 g.grant_sha256:=encode(sha256(convert_to(g.grant_text,'UTF8')),'hex');
 insert into public.assessment_local_custody_authorizations select (g).*;
 -- Deferred reciprocal constraints also check all four durable objects. A
 -- late expiry raises and rolls back every write, including both ledger rows.
 if p_expires_at<=clock_timestamp() then raise exception 'task_expired' using errcode='42501';end if;
 return reply;
end $function$;

CREATE OR REPLACE FUNCTION controller_security.public_control_report_provenance(p_tenant_id uuid, p_run_id uuid, p_engagement_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 s public.public_control_assessment_sources;j public.assessment_dispatch_jobs;
 r public.public_control_review_sets;c public.public_website_control_evidence;
 w public.public_website_checks;p public.workload_assessment_packets;t public.workload_task_delegations;
 requested public.audit_ledger;reviewed public.audit_ledger;captured public.audit_ledger;
 cat public.approved_catalogue_versions;snap jsonb;req jsonb;input jsonb;expected text;manifest text;provenance jsonb;asset jsonb;
 ctrl jsonb;observed jsonb;questions jsonb;field text;declaration_value jsonb;rows_digest text;total integer;affirmed integer;denied integer;unknowns integer;answer_state text;applicability_state text;
begin
 select * into s from public.public_control_assessment_sources where run_id=p_run_id;
 if not found then return null;end if;
 if s.tenant_id is distinct from p_tenant_id or s.engagement_id is distinct from p_engagement_id
 or not public.board_assessment_source_valid(p_tenant_id,p_run_id,p_engagement_id)
 then raise exception 'human review report source refused' using errcode='23514';end if;
 select * into j from public.assessment_dispatch_jobs where id=s.job_id;
 select * into t from public.workload_task_delegations where run_id=s.run_id;
 select * into r from public.public_control_review_sets where tenant_id=p_tenant_id and id=s.review_id;
 select * into c from public.public_website_control_evidence where tenant_id=p_tenant_id and check_id=r.check_id;
 select * into w from public.public_website_checks where tenant_id=p_tenant_id and id=r.check_id;
 select * into p from public.workload_assessment_packets where tenant_id=p_tenant_id and run_id=s.run_id;
 select * into requested from public.audit_ledger where tenant_id=p_tenant_id and id=s.requested_receipt;
 select * into reviewed from public.audit_ledger where tenant_id=p_tenant_id and id=s.review_receipt;
 select * into captured from public.audit_ledger where tenant_id=p_tenant_id and id=s.capture_receipt;
 snap:=r.snapshot_text::jsonb;req:=r.request_text::jsonb;input:=s.input_text::jsonb;
 select * into cat from public.approved_catalogue_versions where library_version=req->'expectedSource'->>'libraryVersion';
 if not found then raise exception 'human review report binding refused' using errcode='23514';end if;
 expected:=controller_security.canonical_questionnaire_json(jsonb_build_object(
  'tenant_id',p_tenant_id,'engagement_id',p_engagement_id,'library_version',cat.library_version,
  'answers',snap->'normalizedAnswers','sdf_self_attested',req->'applicability'->'sdfSelfAttested',
  'processes_children',req->'applicability'->'processesChildren','processes_health',req->'applicability'->'processesHealth'));
 if j.id is null or t.run_id is null or r.id is null or c.check_id is null or w.id is null
 or j.tenant_id is distinct from p_tenant_id or j.actor_id is distinct from s.actor_id
 or j.run_id is distinct from s.run_id or j.engagement_id is distinct from p_engagement_id
 or j.estate_id is distinct from s.estate_id or j.input_hash is distinct from s.input_sha256
 or t.tenant_id is distinct from p_tenant_id or t.created_by is distinct from s.actor_id
 or t.engagement_id is distinct from p_engagement_id or t.estate_id is distinct from s.estate_id
 or t.input_hash is distinct from s.input_sha256 or t.correlation_id is distinct from j.correlation_id
 or r.engagement_id is distinct from p_engagement_id or r.estate_id is distinct from s.estate_id
 or r.request_sha256 is distinct from s.request_sha256 or r.snapshot_sha256 is distinct from s.snapshot_sha256
 or r.receipt_id is distinct from s.review_receipt or c.capture_receipt is distinct from s.capture_receipt
 or s.input_text is distinct from expected
 or s.input_sha256 is distinct from encode(sha256(convert_to(s.input_text,'UTF8')),'hex')
 or r.request_sha256 is distinct from encode(sha256(convert_to(r.request_text,'UTF8')),'hex')
 or r.snapshot_sha256 is distinct from encode(sha256(convert_to(r.snapshot_text,'UTF8')),'hex')
 or snap->'request' is distinct from req or snap->>'tenantId' is distinct from p_tenant_id::text
 or snap->>'engagementId' is distinct from p_engagement_id::text or (snap->>'estateId')::uuid is distinct from s.estate_id
 or snap->>'checkId' is distinct from r.check_id::text or snap->>'captureReceipt' is distinct from c.capture_receipt::text
 or (snap->>'checkedAt')::timestamptz is distinct from w.checked_at
 or snap->'declarationsVerified' is distinct from 'false'::jsonb or snap->'requiresHumanReview' is distinct from 'true'::jsonb
 or req->'expectedSource'->>'payloadSha256' is distinct from c.payload_sha256
 or req->'expectedSource'->>'mappingVersion' is distinct from cat.mapping_version
 or req->'expectedSource'->>'questionnaireDigest' is distinct from cat.questionnaire_digest
 or c.codec is distinct from 'axiom-public-evidence-v2-canonical-json-1'
 or c.payload_sha256 is distinct from encode(sha256(convert_to(c.payload_text,'UTF8')),'hex')
 or requested.id is null or requested.action_type::text is distinct from 'assessment.requested'
 or requested.actor_type::text is distinct from 'human' or requested.actor_id is distinct from s.actor_id::text
 or requested.correlation_id is distinct from s.job_id or requested.target_ref is distinct from s.job_id::text
 or requested.input_hash is distinct from s.input_sha256 or requested.result::text is distinct from 'pending'
 or requested.detail->>'run_id' is distinct from s.run_id::text
 or reviewed.id is null or reviewed.action_type::text is distinct from 'public_control.review_recorded'
 or reviewed.actor_type::text is distinct from 'human' or reviewed.actor_id is distinct from r.actor_id::text
 or reviewed.correlation_id is distinct from r.operation_key or reviewed.target_ref is distinct from r.id::text
 or reviewed.input_hash is distinct from r.request_sha256 or reviewed.output_hash is distinct from r.snapshot_sha256
 or reviewed.result::text is distinct from 'success'
 or captured.id is null or captured.action_type::text is distinct from 'connector.website.evidence_captured'
 or captured.actor_type::text is distinct from 'human' or captured.actor_id is distinct from w.actor_id::text
 or captured.correlation_id is distinct from w.correlation_id or w.status is distinct from 'checked'
 or captured.target_ref is distinct from w.id::text or captured.input_hash is distinct from c.payload_sha256
 or captured.output_hash is distinct from encode(sha256(convert_to(c.page_sources::text,'UTF8')),'hex')
 or captured.result::text is distinct from 'success'
 then raise exception 'human review report binding refused' using errcode='23514';end if;
 -- The normal worker already emits these declarations. A report may not imply
 -- they came from this review unless the finalized packet agrees exactly.
 select encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_agg(v-'created_at' order by v->>'id')),'UTF8')),'hex') into rows_digest from jsonb_array_elements(p.controls)v;
 if rows_digest is distinct from cat.rows_hash
 then raise exception 'human review frozen catalogue refused' using errcode='23514';end if;
 provenance:=p.result->'questionnaire_provenance';
 if p.library_version is distinct from cat.library_version or provenance->>'source_library_version' is distinct from p.library_version
 or provenance->>'source_library_digest' is distinct from p.library_digest
 or provenance->'version' is distinct from '1'::jsonb or provenance->>'estimates' is distinct from 'provisional'
 or provenance->'review_required' is distinct from 'true'::jsonb
 or jsonb_typeof(provenance->'controls') is distinct from 'array'
 or jsonb_array_length(provenance->'controls') is distinct from jsonb_array_length(p.controls)
 then raise exception 'human review computation provenance refused' using errcode='23514';end if;
 for ctrl in select value from jsonb_array_elements(p.controls) loop
  select value into observed from jsonb_array_elements(provenance->'controls') where value->>'control_id'=ctrl->>'id';
  select coalesce(jsonb_agg(jsonb_build_object('question_id',value->>'id','declaration',case input->'answers'->(ctrl->>'id')->(value->>'id') when 'true'::jsonb then 'caller_affirmed' when 'false'::jsonb then 'caller_denied' else 'unknown' end) order by value->>'id'),'[]'::jsonb)
   into questions from jsonb_array_elements(ctrl->'assessment_questions') where value->>'type'='boolean';
  select count(*),count(*) filter(where value->>'declaration'='caller_affirmed'),count(*) filter(where value->>'declaration'='caller_denied'),count(*) filter(where value->>'declaration'='unknown') into total,affirmed,denied,unknowns from jsonb_array_elements(questions);
  answer_state:=case when total=0 then 'not_boolean_assessable' when unknowns=total then 'unknown' when unknowns>0 then 'partially_answered' else 'caller_declared_unverified' end;
  applicability_state:=case when ctrl->>'sdf_only'<>'true' and ctrl->>'children_only'<>'true' then 'unconditional' when (ctrl->>'sdf_only'='true' and input->'sdf_self_attested'='false'::jsonb) or (ctrl->>'children_only'='true' and input->'processes_children'='false'::jsonb) then 'caller_declared_not_applicable_unverified' when (ctrl->>'sdf_only'='true' and input->'sdf_self_attested'='null'::jsonb) or (ctrl->>'children_only'='true' and input->'processes_children'='null'::jsonb) then 'unknown' else 'caller_declared_applicable_unverified' end;
  if observed is null or observed->'questions' is distinct from questions
   or observed->'known_boolean_question_count' is distinct from to_jsonb(total) or observed->'caller_affirmed_count' is distinct from to_jsonb(affirmed) or observed->'caller_denied_count' is distinct from to_jsonb(denied) or observed->'unknown_count' is distinct from to_jsonb(unknowns)
   or observed->>'answer_state' is distinct from answer_state or observed->>'applicability_state' is distinct from applicability_state
   or (select count(*) from jsonb_array_elements(provenance->'controls') where value->>'control_id'=ctrl->>'id')<>1
  then raise exception 'human review answer provenance refused' using errcode='23514';end if;
 end loop;
 foreach field in array array['sdf_self_attested','processes_children','processes_health'] loop
  declaration_value:=input->field;
  if provenance->'applicability'->field is distinct from jsonb_build_object('value',declaration_value,'provenance',case when declaration_value='null'::jsonb then 'unknown' else 'caller_declared_unverified' end)
  then raise exception 'human review applicability provenance refused' using errcode='23514';end if;
 end loop;
 manifest:=controller_security.public_control_report_mapping_manifest();
 if req->'expectedSource'->>'catalogueManifestSha256' is distinct from encode(sha256(convert_to(manifest,'UTF8')),'hex')
 then raise exception 'human review mapping provenance refused' using errcode='23514';end if;
 -- Frozen139 rows and their actual receipts only: no current inventory,
 -- withdrawal, role, or review-head lookup may invalidate an accepted run.
 if r.request_codec='axiom-public-control-review-request-canonical-json-2' then
  if r.snapshot_codec is distinct from 'axiom-public-control-review-snapshot-pg-canonical-json-2'
   or req->'version' is distinct from '2'::jsonb or snap->'version' is distinct from '2'::jsonb
  then raise exception 'asset report review codec refused' using errcode='23514';end if;
  asset:=controller_security.review141_assets(p_tenant_id,req);
  if snap->'assetProvenance' is distinct from asset
   or asset->>'estate_id' is distinct from s.estate_id::text
  then raise exception 'asset report provenance refused' using errcode='23514';end if;
 end if;
 return jsonb_build_object(
  'schema_version',case when asset is null then 1 else 2 end,'kind','public_control_review','tenant_id',p_tenant_id,'engagement_id',p_engagement_id,'estate_id',s.estate_id,
  'job_id',s.job_id,'assessment_run_id',s.run_id,'requested_by',s.actor_id,
  'worker_input',jsonb_build_object('codec','axiom-assessment-input-canonical-json-1','text',s.input_text,'sha256',s.input_sha256),
  'requested_receipt',jsonb_build_object('id',requested.id::text,'entry_hash',requested.entry_hash),
  'review',jsonb_build_object('id',r.id,'actor_id',r.actor_id,'operation_key',r.operation_key,'request_codec',r.request_codec,'request_text',r.request_text,'request_sha256',r.request_sha256,'snapshot_codec',r.snapshot_codec,'snapshot_text',r.snapshot_text,'snapshot_sha256',r.snapshot_sha256,'receipt',jsonb_build_object('id',reviewed.id::text,'entry_hash',reviewed.entry_hash),'created_at',r.created_at),
  'capture',jsonb_build_object('check_id',c.check_id,'checked_at',w.checked_at,'codec',c.codec,'payload_text',c.payload_text,'payload_sha256',c.payload_sha256,'page_sources',c.page_sources,'page_sources_text',c.page_sources::text,'page_sources_sha256',captured.output_hash,'capture_receipt',jsonb_build_object('id',captured.id::text,'entry_hash',captured.entry_hash)),
  'catalogue',jsonb_build_object('library_version',cat.library_version,'questionnaire_digest',req->'expectedSource'->'questionnaireDigest','mapping_version',cat.mapping_version,'manifest_text',manifest,'manifest_sha256',encode(sha256(convert_to(manifest,'UTF8')),'hex')),
  'declarations_verified',false,'evidence_verified',false,'review_required',true
 );
end $function$;
