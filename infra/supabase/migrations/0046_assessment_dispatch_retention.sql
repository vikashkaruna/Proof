-- Configurable retention applies only to private dispatch ciphertext, measured
-- from independently confirmed completion. Job identity, receipts and evidence
-- survive. This is neither key destruction nor physical backup/WAL erasure.
alter type public.ledger_action_type add value if not exists 'workload.dispatch_payload_purged';
alter table public.assessment_dispatch_jobs
 alter column nonce drop not null,
 alter column ciphertext drop not null,
 alter column wrapped_key drop not null,
 add column payload_purged_at timestamptz,
 add column payload_purge_receipt bigint references public.audit_ledger(id) on delete restrict,
 add column payload_retention_days integer,
 add constraint assessment_dispatch_payload_consistent check (
  (payload_purged_at is null and payload_purge_receipt is null and payload_retention_days is null
   and nonce is not null and ciphertext is not null and wrapped_key is not null)
  or (payload_purged_at is not null and payload_purge_receipt is not null
   and payload_retention_days is not null and payload_retention_days between 1 and 36500
   and nonce is null and ciphertext is null and wrapped_key is null)
 );
create index assessment_dispatch_retention_pending on public.assessment_dispatch_jobs(run_id)
 where payload_purged_at is null and claimed_at is not null;
create index assessment_finalized_retention on public.workload_assessment_packets(finalized_at,run_id)
 where finalized_receipt is not null;

create function public.purge_next_assessment_dispatch_payload(p_retention_days integer default 90,p_tenant_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare task public.workload_task_delegations; run public.agent_runs;
 packet public.workload_assessment_packets; job public.assessment_dispatch_jobs;
 cutoff timestamptz; confirmed jsonb; receipt bigint; purged_at timestamptz;
begin
 if p_retention_days is null or p_retention_days not between 1 and 36500
 then return jsonb_build_object('error','retention_refused'); end if;
 cutoff:=clock_timestamp()-make_interval(secs=>p_retention_days::double precision*86400);
 -- One candidate/tenant ledger per transaction. Same task -> run -> packet ->
 -- job order as confirmation/claim. Concurrent maintenance skips a busy task.
 select t.* into task from public.workload_task_delegations t
 join public.assessment_dispatch_jobs d on d.run_id=t.run_id and d.tenant_id=t.tenant_id
 join public.workload_assessment_packets p on p.run_id=t.run_id and p.tenant_id=t.tenant_id
 join public.agent_runs r on r.id=t.run_id and r.tenant_id=t.tenant_id
 where d.payload_purged_at is null and d.claimed_at is not null
  and p.finalized_receipt is not null and p.finalized_at<=cutoff and r.status='succeeded'
  and (p_tenant_id is null or t.tenant_id=p_tenant_id)
 order by p.finalized_at,d.id limit 1 for update of t skip locked;
 if not found then return jsonb_build_object('status','idle'); end if;
 select * into run from public.agent_runs where tenant_id=task.tenant_id and id=task.run_id for update;
 select * into packet from public.workload_assessment_packets where tenant_id=task.tenant_id and run_id=task.run_id for update;
 select * into job from public.assessment_dispatch_jobs where tenant_id=task.tenant_id and run_id=task.run_id for update;
 if job.id is null or job.payload_purged_at is not null or job.claimed_at is null
  or packet.finalized_receipt is null or packet.finalized_at is null or packet.finalized_at>cutoff
 then return jsonb_build_object('status','idle'); end if;
 if run.status<>'succeeded' or task.agent_name<>'parikshan'
  or job.actor_id is distinct from task.created_by or job.workload_id is distinct from task.workload_identity_id
  or job.estate_id is distinct from task.estate_id or job.engagement_id is distinct from task.engagement_id
  or job.correlation_id is distinct from task.correlation_id or job.input_hash is distinct from task.input_hash
 then return jsonb_build_object('status','review','tenantId',job.tenant_id,'jobId',job.id); end if;
 -- This branch can only recheck an EXISTING finalization: it never finalizes a
 -- missing result to manufacture cleanup eligibility. Digests and all three
 -- immutable execution receipts must still match the task and run.
 confirmed:=public.confirm_workload_assessment(task.tenant_id,task.run_id);
 if confirmed ? 'error' or confirmed->>'status' is distinct from 'succeeded'
 then return jsonb_build_object('status','review','tenantId',job.tenant_id,'jobId',job.id); end if;
 purged_at:=clock_timestamp();
 receipt:=public.append_ledger(job.tenant_id,job.correlation_id,'system','assessment-retention',null,null,null,
  'workload.dispatch_payload_purged',job.id::text,job.input_hash,null,null,null,null,null,'success',
  jsonb_build_object('run_id',job.run_id,'retention_days',p_retention_days,
   'confirmed_at',packet.finalized_at,'finalized_receipt',packet.finalized_receipt::text));
 update public.assessment_dispatch_jobs set nonce=null,ciphertext=null,wrapped_key=null,
  payload_purged_at=purged_at,payload_purge_receipt=receipt,payload_retention_days=p_retention_days
 where id=job.id;
 return jsonb_build_object('status','purged','tenantId',job.tenant_id,'jobId',job.id,
  'receipt',receipt::text,'purgedAt',purged_at,'retentionDays',p_retention_days);
end $$;
revoke all on function public.purge_next_assessment_dispatch_payload(integer,uuid) from public,anon,authenticated;
grant execute on function public.purge_next_assessment_dispatch_payload(integer,uuid) to service_role;
