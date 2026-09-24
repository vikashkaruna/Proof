-- Durable metadata for outbox -> Temporal submission. This lease is not task
-- authority; it never resets claimed_at, extends expiry or exposes ciphertext.
alter type public.ledger_action_type add value if not exists 'workload.dispatch_scheduled';
alter type public.ledger_action_type add value if not exists 'workload.dispatch_schedule_review';
alter table public.assessment_dispatch_jobs
 add column scheduling_status text not null default 'pending' check(scheduling_status in ('pending','submitted','needs_review')),
 add column scheduling_attempts integer not null default 0 check(scheduling_attempts between 0 and 8),
 add column scheduling_next_at timestamptz not null default clock_timestamp(),
 add column scheduling_lease_id uuid,
 add column scheduling_lease_until timestamptz,
 add column workflow_namespace text check(length(workflow_namespace) between 1 and 255 and workflow_namespace ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$'),
 add column workflow_id text,
 add column workflow_run_id uuid,
 add column scheduling_closed_at timestamptz,
 add column scheduling_receipt bigint references public.audit_ledger(id) on delete restrict,
 add constraint assessment_scheduling_lease_consistent check((scheduling_lease_id is null)=(scheduling_lease_until is null) and (scheduling_lease_id is null or workflow_namespace is not null)),
 add constraint assessment_scheduling_receipt_consistent check(
  (scheduling_status='pending' and scheduling_receipt is null and scheduling_closed_at is null and workflow_id is null and workflow_run_id is null)
  or (scheduling_status='submitted' and scheduling_receipt is not null and scheduling_closed_at is not null and workflow_namespace is not null and workflow_run_id is not null and workflow_id is not null and workflow_id='assessment-'||tenant_id::text||'-'||id::text)
  or (scheduling_status='needs_review' and scheduling_receipt is not null and scheduling_closed_at is not null and workflow_id is null and workflow_run_id is null)
 );
create index assessment_schedule_due on public.assessment_dispatch_jobs(scheduling_next_at,id) where scheduling_status='pending';

create function public.reserve_assessment_schedules(p_namespace text,p_tenant_id uuid default null,p_limit integer default 1)
returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.assessment_dispatch_jobs; task public.workload_task_delegations;
 lease uuid; deadline timestamptz; start_before timestamptz; receipt bigint; jobs jsonb:='[]'::jsonb;
begin
 if p_namespace is null or length(p_namespace) not between 1 and 255 or p_namespace !~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$'
  or p_limit is null or p_limit not between 1 and 10 then return jsonb_build_object('error','scheduling_refused'); end if;
 for job in select * from public.assessment_dispatch_jobs d
  where d.scheduling_status='pending' and d.scheduling_next_at<=clock_timestamp()
   and (d.scheduling_lease_until is null or d.scheduling_lease_until<=clock_timestamp())
   and (d.workflow_namespace is null or d.workflow_namespace=p_namespace)
   and (p_tenant_id is null or d.tenant_id=p_tenant_id)
  order by d.scheduling_next_at,d.id limit p_limit for update skip locked
 loop
  if job.scheduling_attempts>=8 then
   receipt:=public.append_ledger(job.tenant_id,job.correlation_id,'system','assessment-scheduler',null,null,null,
    'workload.dispatch_schedule_review',job.id::text,null,null,null,null,null,null,'pending',
    jsonb_build_object('run_id',job.run_id,'namespace',job.workflow_namespace,'reason','submission_unconfirmed','attempts',job.scheduling_attempts));
   update public.assessment_dispatch_jobs set scheduling_status='needs_review',scheduling_receipt=receipt,scheduling_closed_at=clock_timestamp() where id=job.id;
   -- Acquire at most one tenant ledger counter per polling transaction.
   -- A later poll closes the next exhausted job without reversing lock order.
   return jsonb_build_object('jobs',jobs);
  end if;
  select * into task from public.workload_task_delegations where tenant_id=job.tenant_id and run_id=job.run_id;
  start_before:=null;
  -- Snapshot eligibility only. Controller claim/tool transactions repeat live
  -- authority checks. Existing/expired/terminal work may only be looked up.
  if job.claimed_at is null
   and exists(select 1 from public.agent_runs where tenant_id=job.tenant_id and id=job.run_id and status='queued' and completed_at is null)
   and public.read_workload_task(job.tenant_id,job.run_id,job.workload_id,'parikshan',task.proof_hash,'control_library.read') is not null
  then start_before:=task.expires_at; end if;
  lease:=gen_random_uuid(); deadline:=clock_timestamp()+interval '3 minutes';
  update public.assessment_dispatch_jobs set workflow_namespace=p_namespace,scheduling_attempts=scheduling_attempts+1,
   scheduling_lease_id=lease,scheduling_lease_until=deadline,scheduling_next_at=deadline where id=job.id;
  jobs:=jobs||jsonb_build_array(jsonb_build_object('tenantId',job.tenant_id,'jobId',job.id,'namespace',p_namespace,
   'workflowId','assessment-'||job.tenant_id::text||'-'||job.id::text,'leaseId',lease,'leaseUntil',deadline,'startBefore',start_before));
 end loop;
 return jsonb_build_object('jobs',jobs);
end $$;
revoke all on function public.reserve_assessment_schedules(text,uuid,integer) from public,anon,authenticated;
grant execute on function public.reserve_assessment_schedules(text,uuid,integer) to service_role;

create function public.acknowledge_assessment_schedule(p_tenant_id uuid,p_job_id uuid,p_lease_id uuid,p_namespace text,p_workflow_id text,p_workflow_run_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.assessment_dispatch_jobs; receipt bigint;
begin
 select * into job from public.assessment_dispatch_jobs where tenant_id=p_tenant_id and id=p_job_id for update;
 if not found or p_lease_id is null or p_workflow_run_id is null or job.scheduling_lease_id is distinct from p_lease_id
  or job.workflow_namespace is distinct from p_namespace or p_workflow_id is distinct from 'assessment-'||job.tenant_id::text||'-'||job.id::text
 then return jsonb_build_object('error','scheduling_refused'); end if;
 if job.scheduling_status='submitted' then
  if job.workflow_id is distinct from p_workflow_id or job.workflow_run_id is distinct from p_workflow_run_id
  then return jsonb_build_object('error','scheduling_conflict'); end if;
  receipt:=job.scheduling_receipt;
 else
  if job.scheduling_status<>'pending' or job.scheduling_lease_until<=clock_timestamp()
  then return jsonb_build_object('error','scheduling_refused'); end if;
  -- This records the trusted producer's submission acknowledgement, NOT
  -- assessment completion, worker authority, successful execution or rollback.
  receipt:=public.append_ledger(job.tenant_id,job.correlation_id,'system','assessment-scheduler',null,null,null,
   'workload.dispatch_scheduled',job.id::text,null,null,null,null,null,null,'success',
   jsonb_build_object('run_id',job.run_id,'namespace',p_namespace,'workflow_id',p_workflow_id,'workflow_run_id',p_workflow_run_id));
  update public.assessment_dispatch_jobs set scheduling_status='submitted',workflow_id=p_workflow_id,workflow_run_id=p_workflow_run_id,
   scheduling_receipt=receipt,scheduling_closed_at=clock_timestamp() where id=job.id;
 end if;
 return jsonb_build_object('tenantId',job.tenant_id,'jobId',job.id,'namespace',p_namespace,'workflowId',p_workflow_id,
  'workflowRunId',p_workflow_run_id,'receipt',receipt::text);
end $$;
revoke all on function public.acknowledge_assessment_schedule(uuid,uuid,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.acknowledge_assessment_schedule(uuid,uuid,uuid,text,text,uuid) to service_role;
