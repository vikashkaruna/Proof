-- Human cancellation of an EXISTING, never-claimed human assessment request.
-- This proves revoked dispatch authority, not Temporal deletion or worker cleanup.
alter type public.ledger_action_type add value if not exists 'assessment.request_cancelled';

create table public.assessment_request_resolutions (
 job_id uuid primary key references public.assessment_dispatch_jobs(id) on delete restrict,
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 run_id uuid not null unique references public.agent_runs(id) on delete restrict,
 actor_id uuid not null references public.users(id) on delete restrict,
 engagement_id uuid not null,
 correlation_id uuid not null,
 input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),
 library_version text not null check(length(library_version) between 1 and 200),
 requested_receipt bigint not null references public.audit_ledger(id) on delete restrict,
 cancellation_receipt bigint not null unique references public.audit_ledger(id) on delete restrict,
 resolved_at timestamptz not null,
 kind text not null check(kind='cancelled_unclaimed'),
 foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id) on delete restrict,
 check(correlation_id=job_id)
);
alter table public.assessment_request_resolutions enable row level security;
revoke all on public.assessment_request_resolutions from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant select on public.assessment_request_resolutions to service_role;
create policy backend_assessment_resolution_read on public.assessment_request_resolutions for select to service_role using(true);
create trigger assessment_resolution_immutable before update or delete on public.assessment_request_resolutions
 for each row execute function public.evidence_receipt_immutable();

-- Narrow wrappers retain every pre-existing validation and human/agent grant.
-- Private originals are callable only by these owner-controlled definers.
alter function public.append_human_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) set schema controller_security;
alter function controller_security.append_human_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) rename to append_human_ledger_before_0113;
revoke all on function controller_security.append_human_ledger_before_0113(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
create function public.append_human_ledger(
 p_tenant_id uuid,p_correlation_id uuid,p_actor_type public.actor_type,p_actor_id text,
 p_agent_version text,p_model_id text,p_prompt_hash text,p_action_type public.ledger_action_type,
 p_target_ref text,p_input_hash text,p_output_hash text,p_approval_token_id uuid,p_approver_id uuid,
 p_pre_state_ref text,p_post_state_ref text,p_result public.ledger_result,p_detail jsonb
) returns bigint language plpgsql security definer set search_path='' as $$
begin
 if p_action_type::text='assessment.request_cancelled'
 then raise exception 'assessment cancellation requires atomic resolution' using errcode='42501'; end if;
 return controller_security.append_human_ledger_before_0113(p_tenant_id,p_correlation_id,p_actor_type,p_actor_id,
  p_agent_version,p_model_id,p_prompt_hash,p_action_type,p_target_ref,p_input_hash,p_output_hash,
  p_approval_token_id,p_approver_id,p_pre_state_ref,p_post_state_ref,p_result,p_detail);
end $$;
revoke all on function public.append_human_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.append_human_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) to human_action_writer;

alter function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) set schema controller_security;
alter function controller_security.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) rename to append_agent_ledger_before_0113;
revoke all on function controller_security.append_agent_ledger_before_0113(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
create function public.append_agent_ledger(
 p_tenant_id uuid,p_correlation_id uuid,p_actor_type public.actor_type,p_actor_id text,
 p_agent_version text,p_model_id text,p_prompt_hash text,p_action_type public.ledger_action_type,
 p_target_ref text,p_input_hash text,p_output_hash text,p_approval_token_id uuid,p_approver_id uuid,
 p_pre_state_ref text,p_post_state_ref text,p_result public.ledger_result,p_detail jsonb
) returns bigint language plpgsql security definer set search_path='' as $$
begin
 if p_action_type::text='assessment.request_cancelled'
 then raise exception 'human-authority assessment cancellation refused for producer' using errcode='42501'; end if;
 return controller_security.append_agent_ledger_before_0113(p_tenant_id,p_correlation_id,p_actor_type,p_actor_id,
  p_agent_version,p_model_id,p_prompt_hash,p_action_type,p_target_ref,p_input_hash,p_output_hash,
  p_approval_token_id,p_approver_id,p_pre_state_ref,p_post_state_ref,p_result,p_detail);
end $$;
revoke all on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) to agent_ledger_writer;

create function public.cancel_unclaimed_assessment_request(
 p_tenant_id uuid,p_actor_id uuid,p_job_id uuid,p_engagement_id uuid,p_library_version text,p_input_hash text
) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare job public.assessment_dispatch_jobs; task public.workload_task_delegations; run public.agent_runs;
 prior public.assessment_request_resolutions; requested public.audit_ledger; cancelled public.audit_ledger;
 stamp timestamptz; receipt bigint;
begin
 if current_setting('role',true) is distinct from 'human_action_writer'
 then raise exception 'human assessment writer required' using errcode='42501'; end if;
 if p_tenant_id is null or p_actor_id is null or p_job_id is null or p_engagement_id is null
  or p_library_version is null or length(p_library_version) not between 1 and 200
  or p_input_hash is null or p_input_hash !~ '^[a-f0-9]{64}$'
 then return jsonb_build_object('error','invalid_cancellation'); end if;
 -- Same stable-ID fence as human enqueue/recovery; task -> run -> packet -> job
 -- is then shared with claim/start/complete/controller confirmation.
 perform pg_advisory_xact_lock(hashtextextended(p_job_id::text,44));
 lock table public.kill_switch_state in share mode;
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for share;
 if not public.workload_task_actor_allowed(p_tenant_id,p_actor_id,'parikshan')
 then return jsonb_build_object('error','forbidden'); end if;
 if not exists(select 1 from public.kill_switch_state where scope_key='global' and not engaged)
  or exists(select 1 from public.kill_switch_state where engaged and (scope='global' or tenant_id=p_tenant_id))
 then return jsonb_build_object('error','kill_switch_engaged'); end if;
 select * into job from public.assessment_dispatch_jobs where tenant_id=p_tenant_id and id=p_job_id;
 if not found then return jsonb_build_object('error','assessment_job_not_found'); end if;
 if job.actor_id is distinct from p_actor_id or job.engagement_id is distinct from p_engagement_id
  or job.correlation_id is distinct from p_job_id or job.input_hash is distinct from p_input_hash
 then return jsonb_build_object('error','cancellation_conflict'); end if;
 select * into task from public.workload_task_delegations where tenant_id=p_tenant_id and run_id=job.run_id for update;
 if not found then return jsonb_build_object('error','cancellation_unavailable'); end if;
 select * into run from public.agent_runs where tenant_id=p_tenant_id and id=job.run_id for update;
 if not found then return jsonb_build_object('error','cancellation_unavailable'); end if;
 perform 1 from public.workload_assessment_packets where tenant_id=p_tenant_id and run_id=job.run_id for update;
 if found then return jsonb_build_object('error','assessment_already_started'); end if;
 select * into job from public.assessment_dispatch_jobs where tenant_id=p_tenant_id and id=p_job_id for update;
 if task.agent_name<>'parikshan' or run.agent<>'parikshan'
  or task.created_by is distinct from job.actor_id or task.workload_identity_id is distinct from job.workload_id
  or task.engagement_id is distinct from job.engagement_id or task.estate_id is distinct from job.estate_id
  or task.correlation_id is distinct from job.correlation_id or task.input_hash is distinct from job.input_hash
  or run.engagement_id is distinct from job.engagement_id or run.correlation_id is distinct from job.correlation_id
  or run.input_redacted_hash is distinct from job.input_hash
  or run.metadata->>'request_kind' is distinct from 'durable_assessment_v1'
  or coalesce(run.metadata->>'assessment_request_receipt','') !~ '^[1-9][0-9]{0,18}$'
 then return jsonb_build_object('error','cancellation_conflict'); end if;
 select * into requested from public.audit_ledger where tenant_id=p_tenant_id and id=(run.metadata->>'assessment_request_receipt')::bigint;
 if not found or requested.actor_type<>'human' or requested.actor_id<>p_actor_id::text
  or requested.action_type::text<>'assessment.requested' or requested.result<>'pending'
  or requested.target_ref is distinct from p_job_id::text or requested.correlation_id is distinct from p_job_id
  or requested.input_hash is distinct from p_input_hash or requested.output_hash is not null
  or requested.detail->>'purpose' is distinct from 'durable_assessment'
  or requested.detail->>'job_id' is distinct from p_job_id::text or requested.detail->>'run_id' is distinct from job.run_id::text
  or requested.detail->>'workload_id' is distinct from job.workload_id::text
  or requested.detail->>'estate_id' is distinct from job.estate_id::text
  or requested.detail->>'engagement_id' is distinct from p_engagement_id::text
  or requested.detail->>'library_version' is distinct from p_library_version
 then return jsonb_build_object('error','cancellation_conflict'); end if;
 if exists(select 1 from public.audit_ledger where tenant_id=p_tenant_id and action_type='assessment.started' and detail->>'run_id'=job.run_id::text)
 then return jsonb_build_object('error','assessment_already_started'); end if;
 select * into prior from public.assessment_request_resolutions where job_id=p_job_id;
 if found then
  select * into cancelled from public.audit_ledger where tenant_id=p_tenant_id and id=prior.cancellation_receipt;
  if prior.tenant_id is distinct from p_tenant_id or prior.run_id is distinct from job.run_id
   or prior.actor_id is distinct from p_actor_id or prior.engagement_id is distinct from p_engagement_id
   or prior.input_hash is distinct from p_input_hash or prior.library_version is distinct from p_library_version
   or prior.requested_receipt is distinct from requested.id or prior.correlation_id is distinct from p_job_id
   or run.status<>'cancelled' or run.completed_at is distinct from prior.resolved_at
   or run.error is not null or run.output_redacted_hash is not null or job.claimed_at is not null
   or task.revoked_at is distinct from prior.resolved_at
   or cancelled.id is null or cancelled.actor_type<>'human' or cancelled.actor_id<>p_actor_id::text
   or cancelled.action_type::text<>'assessment.request_cancelled' or cancelled.result<>'success'
   or cancelled.target_ref is distinct from p_job_id::text or cancelled.correlation_id is distinct from p_job_id
   or cancelled.input_hash is distinct from p_input_hash or cancelled.output_hash is not null
   or cancelled.detail->>'purpose' is distinct from 'cancel_unclaimed_assessment'
   or cancelled.sequence_no<=requested.sequence_no
   or cancelled.detail->>'job_id' is distinct from job.id::text
   or cancelled.detail->>'workload_id' is distinct from job.workload_id::text
   or cancelled.detail->>'engagement_id' is distinct from p_engagement_id::text
   or cancelled.detail->>'library_version' is distinct from p_library_version
   or cancelled.detail->>'resolution' is distinct from 'cancelled_unclaimed'
   or cancelled.detail->>'run_id' is distinct from job.run_id::text
   or cancelled.detail->>'requested_receipt' is distinct from requested.id::text
  then return jsonb_build_object('error','cancellation_conflict'); end if;
  return jsonb_build_object('job_id',job.id,'run_id',run.id,'cancellation_receipt',prior.cancellation_receipt::text,'resolved_at',prior.resolved_at);
 end if;
 if job.claimed_at is not null or task.revoked_at is not null or run.status<>'queued'
  or run.completed_at is not null or run.error is not null or run.output_redacted_hash is not null
 then return jsonb_build_object('error','assessment_not_unclaimed'); end if;
 stamp:=clock_timestamp();
 receipt:=public.append_ledger(p_tenant_id,p_job_id,'human',p_actor_id::text,null,null,null,
  'assessment.request_cancelled',p_job_id::text,p_input_hash,null,null,null,null,null,'success',
  jsonb_build_object('purpose','cancel_unclaimed_assessment','job_id',job.id,'run_id',run.id,
   'workload_id',job.workload_id,'engagement_id',p_engagement_id,'library_version',p_library_version,
   'requested_receipt',requested.id::text,'resolution','cancelled_unclaimed'));
 update public.workload_task_delegations set revoked_at=stamp where run_id=run.id;
 update public.agent_runs set status='cancelled',completed_at=stamp where id=run.id;
 insert into public.assessment_request_resolutions(job_id,tenant_id,run_id,actor_id,engagement_id,correlation_id,input_hash,library_version,
  requested_receipt,cancellation_receipt,resolved_at,kind)
 values(job.id,p_tenant_id,run.id,p_actor_id,p_engagement_id,p_job_id,p_input_hash,p_library_version,requested.id,receipt,stamp,'cancelled_unclaimed');
 return jsonb_build_object('job_id',job.id,'run_id',run.id,'cancellation_receipt',receipt::text,'resolved_at',stamp);
end $$;
revoke all on function public.cancel_unclaimed_assessment_request(uuid,uuid,uuid,uuid,text,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.cancel_unclaimed_assessment_request(uuid,uuid,uuid,uuid,text,text) to human_action_writer;
