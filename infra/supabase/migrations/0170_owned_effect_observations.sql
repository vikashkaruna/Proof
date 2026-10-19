-- Independent readback of an already accepted synthetic execution. An expired
-- execution signature cannot authorize a new write, but does not erase facts.
-- Absence of a provider operation NEVER means no effect: a late worker may run.
-- This receipt neither changes execution status nor authorizes retry/rollback.
alter type public.ledger_action_type add value if not exists 'plan.owned_effect.observed';

create table owned_synthetic.effect_observations (
 operation_key uuid primary key, tenant_id uuid not null references public.tenants(id),
 actor_id uuid not null references public.users(id), session_id uuid not null,
 plan_id uuid not null, action_id uuid not null, batch_id uuid not null,
 binding_id uuid not null, receipt jsonb not null,
 ledger_receipt bigint not null unique references public.audit_ledger(id),
 created_at timestamptz not null default clock_timestamp(),
 foreign key(tenant_id,plan_id) references public.remediation_plans(tenant_id,id),
 foreign key(tenant_id,action_id) references public.remediation_actions(tenant_id,id),
 foreign key(tenant_id,batch_id) references public.execution_batches(tenant_id,id),
 foreign key(tenant_id,binding_id) references owned_synthetic.bindings(tenant_id,id)
);
alter table owned_synthetic.effect_observations enable row level security;
revoke all on owned_synthetic.effect_observations from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;
create trigger owned170_no_update before update or delete on owned_synthetic.effect_observations for each row execute function public.evidence_receipt_immutable();
create trigger owned170_no_truncate before truncate on owned_synthetic.effect_observations for each statement execute function public.evidence_receipt_immutable();

create function public.observe_owned_execution_effect(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,
 p_operation_key uuid,p_plan_id uuid,p_action_id uuid,p_batch_id uuid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare binding owned_synthetic.bindings; a public.remediation_actions; b public.execution_batches;
 token public.approval_tokens; source owned_synthetic.human_requests; r owned_synthetic.resources;
 forward owned_synthetic.operations; undo owned_synthetic.operations; prior owned_synthetic.effect_observations;
 forward_id uuid; undo_id uuid; observed jsonb; current_snapshot jsonb; result jsonb; ledger_id bigint;
 outcome text:='unknown'; expected jsonb;
begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 if p_operation_key is null or p_plan_id is null or p_action_id is null or p_batch_id is null
 then raise exception 'owned observation request refused' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_operation_key::text,170));
 select * into binding from owned_synthetic.bindings where tenant_id=p_tenant_id and action_id=p_action_id;
 if not found then raise exception 'owned observation binding absent' using errcode='42501';end if;
 lock table public.kill_switch_state in share mode;
 binding:=owned_synthetic.require_binding(p_tenant_id,binding.id,binding.engagement_id);
 -- Current custody, kill state and source admission remain required. This is
 -- not a stopped-source credential or an alternative execution entry point.
 lock table public.kill_switch_state in share mode;
 select * into strict r from owned_synthetic.resources
 where(fixture_id,resource_id)=(binding.fixture_id,binding.resource_id) for share;
 select * into a from public.remediation_actions where tenant_id=p_tenant_id and id=p_action_id and plan_id=p_plan_id for share;
 select * into b from public.execution_batches where tenant_id=p_tenant_id and id=p_batch_id and plan_id=p_plan_id for share;
 select * into token from public.approval_tokens where tenant_id=p_tenant_id and id=b.approval_token_id for share;
 select * into source from owned_synthetic.human_requests where tenant_id=p_tenant_id and binding_id=binding.id
 and state='recorded' and(receipt->>'actionId')::uuid=p_action_id;
 if a.id is null or b.id is null or token.id is null or source.operation_key is null
 or a.execution_batch_id is distinct from b.id or a.approval_token_id is distinct from token.id
 or a.execution_request_key is distinct from b.request_key or a.action_type<>'config.audit_log_enable'
 or a.parameters<>'{"enabled":true}'::jsonb or token.plan_id<>p_plan_id
 or token.action_ids is distinct from array[p_action_id] or token.status not in('consumed','revoked')
 or token.signature='' or token.signed_payload->'actionIds' is distinct from jsonb_build_array(p_action_id)
 or token.signed_payload->>'contentDigest' is distinct from b.content_digest
 or public.action_set_content_digest(p_tenant_id,p_plan_id,array[p_action_id]) is distinct from b.content_digest
 or(select count(*) from public.remediation_actions where tenant_id=p_tenant_id and execution_batch_id=b.id)<>1
 then raise exception 'owned observation source refused' using errcode='42501';end if;
 -- Historical token expiry/revocation is displayed, never relaxed for writes.
 select * into prior from owned_synthetic.effect_observations where operation_key=p_operation_key;
 if found then
  if(prior.tenant_id,prior.actor_id,prior.plan_id,prior.action_id,prior.batch_id,prior.binding_id)
  is distinct from(p_tenant_id,p_actor_id,p_plan_id,p_action_id,p_batch_id,binding.id)
  then raise exception 'owned observation key conflict' using errcode='22023';end if;
  return prior.receipt;
 end if;
 forward_id:=owned_synthetic.execution_operation_id(b.id,a.id,'forward');
 undo_id:=owned_synthetic.execution_operation_id(b.id,a.id,'rollback');
 select * into forward from owned_synthetic.operations where id=forward_id;
 select * into undo from owned_synthetic.operations where id=undo_id;
 if forward.id is not null then
  if(forward.tenant_id,forward.binding_id,forward.action_id,forward.batch_id,forward.approval_token_id,forward.content_digest,forward.kind,forward.before_snapshot)
  is distinct from(p_tenant_id,binding.id,a.id,b.id,token.id,b.content_digest,'forward',source.roundtrip->'before')
  or forward.after_snapshot is distinct from owned_synthetic.project(forward.before_snapshot,true)
  then raise exception 'owned observation forward journal refused' using errcode='42501';end if;
  outcome:='forward_committed'; expected:=forward.after_snapshot;
 end if;
 if undo.id is not null then
  if forward.id is null or(undo.tenant_id,undo.binding_id,undo.action_id,undo.batch_id,undo.approval_token_id,undo.content_digest,undo.kind,undo.before_snapshot)
  is distinct from(p_tenant_id,binding.id,a.id,b.id,token.id,b.content_digest,'rollback',forward.after_snapshot)
  or undo.after_snapshot is distinct from owned_synthetic.project(undo.before_snapshot,false)
  then raise exception 'owned observation rollback journal refused' using errcode='42501';end if;
  outcome:='rollback_committed'; expected:=undo.after_snapshot;
 end if;
 current_snapshot:=owned_synthetic.snapshot(r);
 observed:=jsonb_build_object('outcome',outcome,'observedAt',clock_timestamp(),
 'forwardOperationId',forward_id,'rollbackOperationId',undo_id,
 'forward',case when forward.id is null then null else jsonb_build_object('before',forward.before_snapshot,'after',forward.after_snapshot) end,
 'rollback',case when undo.id is null then null else jsonb_build_object('before',undo.before_snapshot,'after',undo.after_snapshot) end,
 'current',current_snapshot,'currentMatchesLastCommit',case when expected is null then null else current_snapshot=expected end,
 'recordedActionStatus',a.execution_status,'recordedBatchStatus',b.status,
 'approvalExpired',token.expires_at<=clock_timestamp(),'approvalRevoked',token.revoked_at is not null,
 'retryAllowed',false,'rollbackAllowed',false,'executionStatusChanged',false);
 ledger_id:=public.append_ledger(p_tenant_id,p_operation_key,'human',p_actor_id::text,null,null,null,
 'plan.owned_effect.observed',a.id::text,null,owned_synthetic.snapshot_sha256(observed),token.id,token.approver_id,
 null,null,'success',jsonb_build_object('batch_id',b.id,'binding_id',binding.id,'outcome',outcome,'target_mutations',0));
 result:=jsonb_build_object('tenantId',p_tenant_id,'actorId',p_actor_id,'operationKey',p_operation_key,
 'planId',p_plan_id,'actionId',p_action_id,'batchId',p_batch_id,'bindingId',binding.id,
 'contentDigest',b.content_digest,'ledgerReceipt',ledger_id::text,'observation',observed);
 insert into owned_synthetic.effect_observations(operation_key,tenant_id,actor_id,session_id,plan_id,action_id,batch_id,binding_id,receipt,ledger_receipt)
 values(p_operation_key,p_tenant_id,p_actor_id,p_session_id,p_plan_id,p_action_id,p_batch_id,binding.id,result,ledger_id);
 return result;
end $$;
revoke all on function public.observe_owned_execution_effect(uuid,uuid,uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;
grant execute on function public.observe_owned_execution_effect(uuid,uuid,uuid,uuid,uuid,uuid,uuid) to human_action_writer;
