-- Human-requested durable assessment enqueue. No worker/controller mutation
-- authority, automatic registration, policy publication or plaintext is added.
alter type public.ledger_action_type add value if not exists 'assessment.requested';

alter function public.enqueue_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text) set schema controller_security;
revoke all on function controller_security.enqueue_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
revoke all on function public.enqueue_assessment_dispatch_unfenced(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;

create function public.enqueue_assessment_dispatch(
 p_job_id uuid,p_tenant_id uuid,p_actor_id uuid,p_workload_id uuid,p_estate_id uuid,p_engagement_id uuid,
 p_correlation_id uuid,p_input_hash text,p_proof_hash text,p_expires_at timestamptz,
 p_key_ref text,p_nonce bytea,p_ciphertext bytea,p_wrapped_key bytea,
 p_policy_revision integer default null,p_policy_fingerprint text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare policy public.assessment_dispatch_key_policies; existed boolean; reply jsonb; receipt bigint; version text;
begin
 -- ACL plus actual SQL role: an arbitrary copied actor/tenant claim under the
 -- shared service role can never create a human-labelled request receipt.
 if current_setting('role',true) is distinct from 'human_action_writer'
 then raise exception 'human assessment writer required' using errcode='42501'; end if;
 if p_tenant_id is null or p_job_id is null or p_engagement_id is null
 then return jsonb_build_object('error','invalid_dispatch'); end if;
 -- Preserve policy -> stable job lock order used by the prior fenced wrapper.
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform pg_advisory_xact_lock(hashtextextended(p_job_id::text,44));
 lock table public.kill_switch_state in share mode;
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for share;
 if not public.workload_task_actor_allowed(p_tenant_id,p_actor_id,'parikshan')
 then return jsonb_build_object('error','forbidden'); end if;
 if not exists(select 1 from public.kill_switch_state where scope_key='global' and not engaged)
  or exists(select 1 from public.kill_switch_state where engaged and (scope='global' or tenant_id=p_tenant_id))
 then return jsonb_build_object('error','kill_switch_engaged'); end if;
 select exists(select 1 from public.assessment_dispatch_jobs where id=p_job_id) into existed;
 if not existed then
  select * into policy from public.assessment_dispatch_key_policies where tenant_id=p_tenant_id;
  if policy.tenant_id is null then return jsonb_build_object('error','policy_required'); end if;
  if p_policy_revision is distinct from policy.revision or p_policy_fingerprint is distinct from policy.fingerprint
   or p_key_ref is distinct from policy.primary_ref
  then return jsonb_build_object('error','policy_stale'); end if;
 end if;
 -- Existing implementation locks current membership/user, kill switch,
 -- estate/engagement and registration, validates exact context on stable-ID
 -- retries, and atomically inserts the delegated run/task/encrypted outbox.
 reply:=controller_security.enqueue_assessment_dispatch(p_job_id,p_tenant_id,p_actor_id,p_workload_id,p_estate_id,p_engagement_id,
  p_correlation_id,p_input_hash,p_proof_hash,p_expires_at,p_key_ref,p_nonce,p_ciphertext,p_wrapped_key,p_policy_revision,p_policy_fingerprint);
 if reply ? 'error' then return reply; end if;
 if not existed then
  select library_version into version from public.engagements where tenant_id=p_tenant_id and id=p_engagement_id;
  receipt:=public.append_ledger(p_tenant_id=>p_tenant_id,p_correlation_id=>p_correlation_id,
   p_actor_type=>'human',p_actor_id=>p_actor_id::text,p_agent_version=>null,p_model_id=>null,p_prompt_hash=>null,
   p_action_type=>'assessment.requested',p_target_ref=>p_job_id::text,p_input_hash=>p_input_hash,p_output_hash=>null,
   p_approval_token_id=>null,p_approver_id=>null,p_pre_state_ref=>null,p_post_state_ref=>null,p_result=>'pending',
   p_detail=>jsonb_build_object('purpose','durable_assessment','job_id',p_job_id,'run_id',reply->>'run_id',
    'workload_id',p_workload_id,'estate_id',p_estate_id,'engagement_id',p_engagement_id,'library_version',version,
    'policy_revision',policy.revision,'policy_fingerprint',policy.fingerprint));
  update public.agent_runs set metadata=metadata||jsonb_build_object('assessment_request_receipt',receipt::text,
   'request_kind','durable_assessment_v1') where tenant_id=p_tenant_id and id=(reply->>'run_id')::uuid;
 end if;
 -- Historical receipt recovery neither changes ciphertext/proof nor extends
 -- expiry, emits another request receipt, claims work or renews authority.
 return reply;
end $$;
revoke all on function public.enqueue_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.enqueue_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text) to human_action_writer;

-- Receipt-only recovery intentionally precedes encryption/policy preflight.
-- It never grants proof, ciphertext, task authority or another audit receipt.
create function public.recover_assessment_dispatch(
 p_job_id uuid,p_tenant_id uuid,p_actor_id uuid,p_workload_id uuid,p_estate_id uuid,p_engagement_id uuid,
 p_correlation_id uuid,p_input_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.assessment_dispatch_jobs; task public.workload_task_delegations;
begin
 if current_setting('role',true) is distinct from 'human_action_writer'
 then raise exception 'human assessment writer required' using errcode='42501'; end if;
 if p_job_id is null or p_tenant_id is null or p_actor_id is null or p_workload_id is null
  or p_engagement_id is null or p_correlation_id is null or p_input_hash is null or p_input_hash !~ '^[a-f0-9]{64}$'
 then return jsonb_build_object('error','invalid_dispatch'); end if;
 perform pg_advisory_xact_lock(hashtextextended(p_job_id::text,44));
 lock table public.kill_switch_state in share mode;
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for share;
 if not public.workload_task_actor_allowed(p_tenant_id,p_actor_id,'parikshan')
 then return jsonb_build_object('error','forbidden'); end if;
 if not exists(select 1 from public.kill_switch_state where scope_key='global' and not engaged)
  or exists(select 1 from public.kill_switch_state where engaged and (scope='global' or tenant_id=p_tenant_id))
 then return jsonb_build_object('error','kill_switch_engaged'); end if;
 select * into job from public.assessment_dispatch_jobs where id=p_job_id;
 if not found then return null; end if;
 if job.tenant_id is distinct from p_tenant_id or job.actor_id is distinct from p_actor_id
  or job.workload_id is distinct from p_workload_id or job.estate_id is distinct from p_estate_id
  or job.engagement_id is distinct from p_engagement_id or job.correlation_id is distinct from p_correlation_id
  or job.input_hash is distinct from p_input_hash
 then return jsonb_build_object('error','dispatch_conflict'); end if;
 select * into task from public.workload_task_delegations where run_id=job.run_id;
 if not found then return jsonb_build_object('error','dispatch_incomplete'); end if;
 return jsonb_build_object('job_id',job.id,'run_id',job.run_id,'expires_at',task.expires_at);
end $$;
revoke all on function public.recover_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.recover_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text) to human_action_writer;

-- A dedicated atomic enqueue, never a generic human/agent ledger append,
-- is the sole recorder of this request class. Keep every prior producer fence.
create or replace function public.append_human_ledger(
  p_tenant_id uuid,p_correlation_id uuid,p_actor_type public.actor_type,
  p_actor_id text,p_agent_version text,p_model_id text,p_prompt_hash text,
  p_action_type public.ledger_action_type,p_target_ref text,p_input_hash text,
  p_output_hash text,p_approval_token_id uuid,p_approver_id uuid,
  p_pre_state_ref text,p_post_state_ref text,p_result public.ledger_result,
  p_detail jsonb
) returns bigint language plpgsql security definer set search_path='' as $$
declare v_actor uuid;
begin
  if p_action_type::text='assessment.requested'
  then raise exception 'assessment request requires atomic enqueue' using errcode='42501'; end if;
  if p_actor_type <> 'human' or p_actor_id is null
    or p_actor_id !~ '^[0-9a-fA-F-]{36}$' then
    raise exception 'human ledger actor refused' using errcode='42501';
  end if;
  v_actor:=p_actor_id::uuid;
  if not exists(select 1 from public.tenant_users
    where tenant_id=p_tenant_id and user_id=v_actor) then
    raise exception 'human ledger membership refused' using errcode='42501';
  end if;
  return public.append_ledger(p_tenant_id,p_correlation_id,p_actor_type,p_actor_id,
    p_agent_version,p_model_id,p_prompt_hash,p_action_type,p_target_ref,
    p_input_hash,p_output_hash,p_approval_token_id,p_approver_id,
    p_pre_state_ref,p_post_state_ref,p_result,p_detail);
end $$;

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
    'classification.reviewed','policy.reviewed','ropa.recorded','policy.drafted','playbook.created','operator.request.cancelled','assessment.requested',
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
