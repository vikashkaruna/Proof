-- Private controller outbox. Ciphertext contains exact input + task proof, never
-- plaintext. A stable job UUID identifies one request and one delegated run.
create table public.assessment_dispatch_jobs (
 id uuid primary key,
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 run_id uuid not null unique references public.workload_task_delegations(run_id) on delete restrict,
 actor_id uuid not null references public.users(id) on delete restrict,
 workload_id uuid not null,
 estate_id uuid,
 engagement_id uuid not null,
 correlation_id uuid not null,
 input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),
 key_ref text not null check(length(key_ref) between 1 and 500 and key_ref ~ '^[a-zA-Z0-9:/_.-]+$'),
 nonce bytea not null check(octet_length(nonce)=12),
 ciphertext bytea not null check(octet_length(ciphertext) between 60 and 1048635),
 wrapped_key bytea not null check(octet_length(wrapped_key) between 1 and 16384),
 created_at timestamptz not null default clock_timestamp(),
 claimed_at timestamptz,
 foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id) on delete restrict,
 foreign key(tenant_id,estate_id) references public.estates(tenant_id,id) on delete restrict
);
alter table public.assessment_dispatch_jobs enable row level security;
revoke all on public.assessment_dispatch_jobs from public,anon,authenticated,service_role;
grant select on public.assessment_dispatch_jobs to service_role;
create policy backend_dispatch_read on public.assessment_dispatch_jobs for select to service_role using(true);

create function public.enqueue_assessment_dispatch(
 p_job_id uuid,p_tenant_id uuid,p_actor_id uuid,p_workload_id uuid,p_estate_id uuid,p_engagement_id uuid,
 p_correlation_id uuid,p_input_hash text,p_proof_hash text,p_expires_at timestamptz,
 p_key_ref text,p_nonce bytea,p_ciphertext bytea,p_wrapped_key bytea
) returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.assessment_dispatch_jobs; delegated jsonb; task public.workload_task_delegations;
begin
 if p_job_id is null or p_engagement_id is null then return jsonb_build_object('error','invalid_dispatch'); end if;
 -- Same request serializes before delegation; no second task/audit on retries.
 perform pg_advisory_xact_lock(hashtextextended(p_job_id::text,44));
 lock table public.kill_switch_state in share mode;
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for share;
 if not public.workload_task_actor_allowed(p_tenant_id,p_actor_id,'parikshan')
 then return jsonb_build_object('error','forbidden'); end if;
 select * into job from public.assessment_dispatch_jobs where id=p_job_id;
 if found then
  if job.tenant_id is distinct from p_tenant_id or job.actor_id is distinct from p_actor_id
   or job.workload_id is distinct from p_workload_id or job.estate_id is distinct from p_estate_id
   or job.engagement_id is distinct from p_engagement_id or job.correlation_id is distinct from p_correlation_id
   or job.input_hash is distinct from p_input_hash
  then return jsonb_build_object('error','dispatch_conflict'); end if;
  -- Returning an existing receipt does not revive an expired/revoked task.
  select * into task from public.workload_task_delegations where run_id=job.run_id;
  return jsonb_build_object('job_id',job.id,'run_id',job.run_id,'expires_at',task.expires_at);
 end if;
 delegated:=public.delegate_workload_task(p_tenant_id,p_actor_id,p_workload_id,'parikshan',p_estate_id,p_engagement_id,
  p_correlation_id,p_input_hash,p_proof_hash,array['control_library.read','findings.write'],p_expires_at);
 if delegated ? 'error' then return delegated; end if;
 -- Constraint/audit failure rolls the entire delegation+outbox transaction back.
 insert into public.assessment_dispatch_jobs(id,tenant_id,run_id,actor_id,workload_id,estate_id,engagement_id,
  correlation_id,input_hash,key_ref,nonce,ciphertext,wrapped_key)
 values(p_job_id,p_tenant_id,(delegated->>'run_id')::uuid,p_actor_id,p_workload_id,p_estate_id,p_engagement_id,
  p_correlation_id,p_input_hash,p_key_ref,p_nonce,p_ciphertext,p_wrapped_key);
 if p_expires_at<=clock_timestamp() then raise exception 'task_expired' using errcode='42501'; end if;
 return jsonb_build_object('job_id',p_job_id,'run_id',delegated->>'run_id','expires_at',delegated->>'expires_at');
end $$;
revoke all on function public.enqueue_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea) from public,anon,authenticated;
grant execute on function public.enqueue_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea) to service_role;

create function public.claim_assessment_dispatch(p_tenant_id uuid,p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.assessment_dispatch_jobs; task public.workload_task_delegations; locked_task public.workload_task_delegations;
begin
 select * into job from public.assessment_dispatch_jobs where tenant_id=p_tenant_id and id=p_job_id;
 if not found then return jsonb_build_object('error','dispatch_unavailable'); end if;
 select * into task from public.workload_task_delegations where tenant_id=p_tenant_id and run_id=job.run_id;
 -- Controller claim checks delegated authority, not workload identity. Actual
 -- tools still require a fresh worker-acquired SVID. This helper's deadline is
 -- the task's own expiry here; it must never be represented as SVID validation.
 locked_task:=public.lock_assessment_workload_task(p_tenant_id,task.run_id,task.workload_identity_id,
  task.proof_hash,'control_library.read',task.expires_at);
 if locked_task.run_id is null or not ('findings.write'=any(locked_task.scopes))
 then return jsonb_build_object('error','dispatch_unavailable'); end if;
 select * into job from public.assessment_dispatch_jobs where tenant_id=p_tenant_id and id=p_job_id for update;
 if job.claimed_at is not null then return jsonb_build_object('error','dispatch_reconciliation_required'); end if;
 if task.created_by is distinct from job.actor_id or task.workload_identity_id is distinct from job.workload_id
  or task.engagement_id is distinct from job.engagement_id or task.estate_id is distinct from job.estate_id
  or task.correlation_id is distinct from job.correlation_id or task.input_hash is distinct from job.input_hash
 then return jsonb_build_object('error','dispatch_unavailable'); end if;
 update public.assessment_dispatch_jobs set claimed_at=clock_timestamp() where id=job.id;
 if locked_task.expires_at<=clock_timestamp() then raise exception 'task_expired' using errcode='42501'; end if;
 return jsonb_build_object('job_id',job.id,'tenant_id',job.tenant_id,'run_id',job.run_id,'actor_id',job.actor_id,
  'workload_id',job.workload_id,'estate_id',job.estate_id,'engagement_id',job.engagement_id,'correlation_id',job.correlation_id,
  'input_hash',job.input_hash,'expires_at',task.expires_at,'proof_hash',task.proof_hash,
  'key_ref',job.key_ref,'nonce',encode(job.nonce,'hex'),'ciphertext',encode(job.ciphertext,'hex'),'wrapped_key',encode(job.wrapped_key,'hex'));
end $$;
revoke all on function public.claim_assessment_dispatch(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_assessment_dispatch(uuid,uuid) to service_role;
