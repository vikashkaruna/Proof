-- LOCAL public-control dispatch admission is separate from the cloud policy
-- kernel. It never turns a local key reference into an AWS/GCP reference.
-- Existing cloud functions, caller grants and historical source bytes remain
-- untouched. Only a new human request may create a local accepted-job grant.
create function public.enqueue_local_public_control_assessment_dispatch(
 p_job_id uuid,p_tenant_id uuid,p_actor_id uuid,p_workload_id uuid,p_estate_id uuid,p_engagement_id uuid,
 p_correlation_id uuid,p_input_hash text,p_proof_hash text,p_expires_at timestamptz,
 p_key_ref text,p_nonce bytea,p_ciphertext bytea,p_wrapped_key bytea,
 p_custody_policy_id uuid,p_custody_policy_sha256 text,p_key_policy_sha256 text,
 p_activation_event_id uuid,p_activation_epoch bigint,p_deployment_binding_sha256 text,
 p_review_id uuid,p_review_request_sha256 text,p_review_snapshot_sha256 text
) returns jsonb language plpgsql security definer set search_path='' as $$
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
   'workload_id',p_workload_id,'estate_id',p_estate_id,'engagement_id',p_engagement_id,'library_version','0.1.1',
   'custody_policy_id',p.id,'custody_policy_sha256',p.policy_sha256,
   'expected_questionnaire',jsonb_build_object('libraryVersion','0.1.1','questionnaireDigest',r.request_text::jsonb#>>'{expectedSource,questionnaireDigest}')));
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
end $$;

-- Separate from the key-service verifier credential: only the existing actual
-- controller transport principal may claim a job. Use wall time AFTER waits,
-- unlike the legacy stable statement-time helper; no global cloud change.
create function controller_security.local147_controller(t uuid,p_lock boolean default false) returns void
language plpgsql volatile security definer set search_path='' as $$
declare claims jsonb;i numeric;x numeric;c controller_security.credentials;
begin
 if current_setting('role',true) is distinct from 'axiom_assessment_controller' then raise exception 'controller identity required' using errcode='42501';end if;
 claims:=nullif(current_setting('request.jwt.claims',true),'')::jsonb;
 if claims->>'role' is distinct from 'axiom_assessment_controller' or jsonb_typeof(claims->'iat') is distinct from 'number' or jsonb_typeof(claims->'exp') is distinct from 'number' then raise exception 'controller identity refused' using errcode='42501';end if;
 i:=(claims->>'iat')::numeric;x:=(claims->>'exp')::numeric;
 if i<>trunc(i) or x<>trunc(x) or i>extract(epoch from clock_timestamp()) or x<=extract(epoch from clock_timestamp()) or x<=i or x-i>3600 then raise exception 'controller identity expired' using errcode='42501';end if;
 if p_lock then
  select * into c from controller_security.credentials where id=(claims->>'sub')::uuid and tenant_id=t and tenant_id=(claims->>'tenant_id')::uuid and revoked_at is null and expires_at>clock_timestamp() and extract(epoch from expires_at)>=x for share;
 else
  select * into c from controller_security.credentials where id=(claims->>'sub')::uuid and tenant_id=t and tenant_id=(claims->>'tenant_id')::uuid and revoked_at is null and expires_at>clock_timestamp() and extract(epoch from expires_at)>=x;
 end if;
 if c.id is null then raise exception 'controller identity refused' using errcode='42501';end if;
 if x<=extract(epoch from clock_timestamp()) or c.expires_at<=clock_timestamp() then raise exception 'controller identity expired' using errcode='42501';end if;
exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'controller identity refused' using errcode='42501';
end $$;

create function public.claim_local_assessment_dispatch(p_tenant_id uuid,p_job_id uuid,p_custody_policy_id uuid,p_custody_policy_sha256 text,p_key_policy_sha256 text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g public.assessment_local_custody_authorizations;j public.assessment_dispatch_jobs;
 t public.workload_task_delegations;p public.local_custody_policy_versions;h public.local_custody_policy_heads;v jsonb;reply jsonb;
begin
 perform controller_security.local147_controller(p_tenant_id);
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform pg_advisory_xact_lock(hashtextextended(p_job_id::text,44));
 select * into g from public.assessment_local_custody_authorizations where tenant_id=p_tenant_id and job_id=p_job_id;
 select * into j from public.assessment_dispatch_jobs where tenant_id=p_tenant_id and id=p_job_id;
 select * into t from public.workload_task_delegations where tenant_id=p_tenant_id and run_id=j.run_id;
 select * into p from public.local_custody_policy_versions where tenant_id=p_tenant_id and id=g.policy_id;
 select * into h from public.local_custody_policy_heads where tenant_id=p_tenant_id and policy_id=g.policy_id;
 if g.job_id is null or j.id is null or t.run_id is null or p.id is null or h.policy_id is null
  or g.policy_id is distinct from p_custody_policy_id or p.policy_sha256 is distinct from p_custody_policy_sha256 or p.key_policy_sha256 is distinct from p_key_policy_sha256
  or g.original_expires_at is distinct from t.expires_at or g.original_expires_at<=clock_timestamp() or t.revoked_at is not null
  or h.state not in ('active','revoked')
  or g.grant_text is distinct from controller_security.canonical_questionnaire_json(controller_security.local143_job_grant(g))
  or g.grant_sha256 is distinct from encode(sha256(convert_to(g.grant_text,'UTF8')),'hex')
 then return jsonb_build_object('error','local_dispatch_unavailable');end if;
 v:=controller_security.local143_policy(p.policy_text);
 if not exists(select 1 from jsonb_array_elements_text(v#>'{keyPolicy,readable}') ref where ref=j.key_ref) then return jsonb_build_object('error','local_dispatch_unavailable');end if;
 -- No current policy/head/source freshness is imposed on accepted work. The
 -- original kernel still checks actor, task, workload, stop and one-time claim.
 reply:=public.claim_assessment_dispatch_unfenced(p_tenant_id,p_job_id);
 -- Any refusal after claimed_at must raise, rather than commit an uncertain
 -- claim on behalf of an identity which expired/revoked while waiting.
 perform controller_security.local147_controller(p_tenant_id,true);
 if g.original_expires_at<=clock_timestamp() then raise exception 'task_expired' using errcode='42501';end if;
 if reply?'error' then return reply;end if;
 return reply||jsonb_build_object('local_custody',jsonb_build_object('policy_id',p.id,'policy_sha256',p.policy_sha256,'key_policy_sha256',p.key_policy_sha256,'grant_sha256',g.grant_sha256,'context_sha256',g.context_sha256,'activation_event_id',g.activation_event_id,'activation_epoch',g.activation_epoch,'original_expires_at',g.original_expires_at));
end $$;

revoke all on function controller_security.local147_controller(uuid,boolean) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller,axiom_local_custody_verifier,axiom_local_custody_issuer;
revoke all on function public.enqueue_local_public_control_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,uuid,text,text,uuid,bigint,text,uuid,text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller,axiom_local_custody_verifier,axiom_local_custody_issuer;
grant execute on function public.enqueue_local_public_control_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,uuid,text,text,uuid,bigint,text,uuid,text,text) to human_action_writer;
revoke all on function public.claim_local_assessment_dispatch(uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller,axiom_local_custody_verifier,axiom_local_custody_issuer;
grant execute on function public.claim_local_assessment_dispatch(uuid,uuid,uuid,text,text) to axiom_assessment_controller;
