-- Controller-only reconciliation of a result that 0042 already committed.
-- This grants no new worker/tool/client authority, even after task expiry.
alter type public.ledger_action_type add value if not exists 'workload.task_completed';
alter table public.workload_assessment_packets
 add column finalized_receipt bigint references public.audit_ledger(id) on delete restrict,
 add column finalized_at timestamptz,
 add constraint assessment_finalization_consistent check (
  (finalized_receipt is null)=(finalized_at is null)
  and (finalized_receipt is null or completed_receipt is not null)
 );

create function public.confirm_workload_assessment(p_tenant_id uuid,p_run_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare task public.workload_task_delegations; run public.agent_runs;
 packet public.workload_assessment_packets; started public.audit_ledger; completed public.audit_ledger;
 finalized public.audit_ledger; receipt bigint; elapsed_ms numeric;
begin
 -- Same task -> run -> packet order as 0042, without acquiring any later
 -- membership/estate locks: this records a past result, not a new action.
 select * into task from public.workload_task_delegations where tenant_id=p_tenant_id and run_id=p_run_id for update;
 if not found or task.agent_name<>'parikshan' then return jsonb_build_object('error','confirmation_unavailable'); end if;
 select * into run from public.agent_runs where tenant_id=p_tenant_id and id=p_run_id for update;
 if not found or run.agent<>'parikshan' or run.engagement_id is distinct from task.engagement_id
  or run.correlation_id is distinct from task.correlation_id or run.input_redacted_hash is distinct from task.input_hash
 then return jsonb_build_object('error','confirmation_conflict'); end if;
 select * into packet from public.workload_assessment_packets where tenant_id=p_tenant_id and run_id=p_run_id for update;
 if not found or packet.completed_receipt is null then return jsonb_build_object('error','result_unconfirmed'); end if;
 if packet.engagement_id is distinct from task.engagement_id
  or packet.result_digest is distinct from encode(sha256(convert_to(packet.result::text,'UTF8')),'hex')
  or packet.library_digest is distinct from encode(sha256(convert_to(packet.controls::text,'UTF8')),'hex')
  or packet.result->>'library_version' is distinct from packet.library_version
 then return jsonb_build_object('error','confirmation_conflict'); end if;
 select * into started from public.audit_ledger where tenant_id=p_tenant_id and id=packet.started_receipt;
 select * into completed from public.audit_ledger where tenant_id=p_tenant_id and id=packet.completed_receipt;
 if started.id is null or completed.id is null or started.id=completed.id
  or started.actor_type<>'agent' or completed.actor_type<>'agent'
  or started.actor_id<>'parikshan' or completed.actor_id<>'parikshan'
  or started.action_type<>'assessment.started' or completed.action_type<>'assessment.scored'
  or started.result<>'pending' or completed.result<>'success'
  or started.correlation_id is distinct from task.correlation_id or completed.correlation_id is distinct from task.correlation_id
  or started.target_ref is distinct from packet.engagement_id::text or completed.target_ref is distinct from packet.engagement_id::text
  or started.input_hash is distinct from task.input_hash or completed.input_hash is distinct from task.input_hash
  or completed.output_hash is distinct from packet.result_digest
  or started.detail->>'run_id' is distinct from p_run_id::text or completed.detail->>'run_id' is distinct from p_run_id::text
  or started.detail->>'workload_id' is distinct from task.workload_identity_id::text or completed.detail->>'workload_id' is distinct from task.workload_identity_id::text
  or started.detail->>'library_digest' is distinct from packet.library_digest or completed.detail->>'library_digest' is distinct from packet.library_digest
 then return jsonb_build_object('error','confirmation_conflict'); end if;
 if packet.finalized_receipt is not null then
  select * into finalized from public.audit_ledger where tenant_id=p_tenant_id and id=packet.finalized_receipt;
  if run.status<>'succeeded' or run.completed_at is distinct from packet.completed_at
   or run.output_redacted_hash is distinct from packet.result_digest or run.error is not null
   or finalized.id is null or finalized.action_type<>'workload.task_completed' or finalized.result<>'success'
   or finalized.actor_type<>'system' or finalized.actor_id<>'assessment-controller'
   or finalized.target_ref is distinct from p_run_id::text or finalized.correlation_id is distinct from task.correlation_id
   or finalized.input_hash is distinct from task.input_hash or finalized.output_hash is distinct from packet.result_digest
  then return jsonb_build_object('error','confirmation_conflict'); end if;
  receipt:=packet.finalized_receipt;
 else
  -- A committed assessment is not permission to overwrite a concurrent cancel,
  -- timeout, failure, or an unrelated terminal success.
  if run.status<>'running' or run.completed_at is not null then return jsonb_build_object('error','terminal_conflict'); end if;
  elapsed_ms:=floor(extract(epoch from (packet.completed_at-run.started_at))*1000);
  if elapsed_ms<0 or elapsed_ms>2147483647 then return jsonb_build_object('error','confirmation_conflict'); end if;
  receipt:=public.append_ledger(p_tenant_id=>p_tenant_id,p_correlation_id=>task.correlation_id,p_actor_type=>'system',p_actor_id=>'assessment-controller',
   p_agent_version=>null,p_model_id=>null,p_prompt_hash=>null,p_action_type=>'workload.task_completed',p_target_ref=>p_run_id::text,
   p_input_hash=>task.input_hash,p_output_hash=>packet.result_digest,p_approval_token_id=>null,p_approver_id=>null,p_pre_state_ref=>null,p_post_state_ref=>null,p_result=>'success',
   p_detail=>jsonb_build_object('workload_id',task.workload_identity_id,'assessment_started_receipt',packet.started_receipt::text,'assessment_completed_receipt',packet.completed_receipt::text,'library_version',packet.library_version));
  update public.agent_runs set status='succeeded',completed_at=packet.completed_at,error=null,
   output_redacted_hash=packet.result_digest,latency_ms=elapsed_ms::integer,
   input_tokens=0,output_tokens=0,total_tokens=0,cost_usd=0 where id=p_run_id;
  update public.workload_assessment_packets set finalized_receipt=receipt,finalized_at=clock_timestamp() where run_id=p_run_id;
 end if;
 return jsonb_build_object('run_id',p_run_id,'tenant_id',p_tenant_id,'agent','parikshan','engagement_id',packet.engagement_id,
  'correlation_id',task.correlation_id,'status','succeeded','input_hash',task.input_hash,'result_digest',packet.result_digest,
  'completed_at',packet.completed_at,'completed_receipt',packet.completed_receipt::text,'finalized_receipt',receipt::text,
  'result',packet.result);
end $$;
revoke all on function public.confirm_workload_assessment(uuid,uuid) from public,anon,authenticated;
grant execute on function public.confirm_workload_assessment(uuid,uuid) to service_role;
