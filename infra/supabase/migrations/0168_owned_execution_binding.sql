-- Resolve only an existing consumed singleton approval for the registered
-- Karya identity. This read grants no registration, token issuance or target DML.
create function public.resolve_owned_execution_target(p_tenant_id uuid,p_plan_id uuid,p_action_id uuid,p_request_key text,p_signed_token jsonb,p_spiffe_id text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare binding owned_synthetic.bindings;a public.remediation_actions;b public.execution_batches;t public.approval_tokens;
 source owned_synthetic.human_requests;forward owned_synthetic.operations;undo owned_synthetic.operations;
begin
 perform 1 from public.workload_identities where tenant_id=p_tenant_id and agent_name='karya' and spiffe_id=p_spiffe_id and status='active' for share;
 if not found or p_spiffe_id is distinct from 'spiffe://local.axiomproof.test/agent/karya'
 then raise exception 'owned execution workload refused' using errcode='42501';end if;
 select * into binding from owned_synthetic.bindings where tenant_id=p_tenant_id and action_id=p_action_id;
 if not found then raise exception 'owned action unregistered' using errcode='42501';end if;
 binding:=owned_synthetic.require_binding(p_tenant_id,binding.id,binding.engagement_id);
 select * into a from public.remediation_actions where tenant_id=p_tenant_id and id=p_action_id and plan_id=p_plan_id for share;
 select * into b from public.execution_batches where tenant_id=p_tenant_id and id=a.execution_batch_id and request_key=p_request_key for share;
 select * into t from public.approval_tokens where tenant_id=p_tenant_id and id=b.approval_token_id for share;
 select * into source from owned_synthetic.human_requests where tenant_id=p_tenant_id and binding_id=binding.id and state='recorded' and(receipt->>'actionId')::uuid=p_action_id;
 if a.id is null or b.id is null or t.id is null or source.operation_key is null
 or a.action_type<>'config.audit_log_enable' or a.parameters<>'{"enabled":true}'::jsonb
 or a.approval_status<>'approved' or a.approval_token_id is distinct from t.id or a.execution_request_key is distinct from p_request_key
 or b.plan_id<>p_plan_id or t.plan_id<>p_plan_id or t.status<>'consumed' or t.revoked_at is not null or t.expires_at<=clock_timestamp()
 or t.action_ids is distinct from array[p_action_id] or p_signed_token->'spec' is distinct from t.signed_payload
 or p_signed_token->>'signature' is distinct from t.signature
 or t.signed_payload->'actionIds' is distinct from jsonb_build_array(p_action_id)
 or t.signed_payload->>'contentDigest' is distinct from b.content_digest
 or public.action_set_content_digest(p_tenant_id,p_plan_id,array[p_action_id]) is distinct from b.content_digest
 or(select count(*) from public.remediation_actions where tenant_id=p_tenant_id and execution_batch_id=b.id)<>1
 then raise exception 'owned execution binding refused' using errcode='42501';end if;
 select * into forward from owned_synthetic.operations where tenant_id=p_tenant_id and binding_id=binding.id and batch_id=b.id and kind='forward';
 select * into undo from owned_synthetic.operations where tenant_id=p_tenant_id and binding_id=binding.id and batch_id=b.id and kind='rollback';
 return jsonb_build_object('tenantId',p_tenant_id,'planId',p_plan_id,'actionId',p_action_id,'batchId',b.id,
 'bindingId',binding.id,'engagementId',binding.engagement_id,'before',source.roundtrip->'before',
 'forward',forward.after_snapshot,'rollback',undo.after_snapshot);
end $$;
revoke all on function public.resolve_owned_execution_target(uuid,uuid,uuid,text,jsonb,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.resolve_owned_execution_target(uuid,uuid,uuid,text,jsonb,text) to owned_target_controller;

create function owned_synthetic.execution_operation_id(batch uuid,action uuid,kind text) returns uuid
language plpgsql immutable set search_path='' as $$
declare h text;
begin
 if kind not in('forward','rollback') or batch is null or action is null then raise exception 'owned operation refused' using errcode='22023';end if;
 h:=owned_synthetic.snapshot_sha256(jsonb_build_object('domain','axiom.owned-synthetic.boolean.v1','batchId',batch,'actionId',action,'kind',kind));
 return(substring(h,1,8)||'-'||substring(h,9,4)||'-8'||substring(h,14,3)||'-'||lpad(to_hex((get_byte(decode(h,'hex'),8)&63)|128),2,'0')||substring(h,19,2)||'-'||substring(h,21,12))::uuid;
end $$;
-- Resolve and use authority inside ONE transaction. In particular, workload
-- revocation cannot race between an HTTP metadata lookup and the first write.
create function public.execute_owned_synthetic_action(p_tenant_id uuid,p_plan_id uuid,p_action_id uuid,p_request_key text,p_signed_token jsonb,p_spiffe_id text,p_operation text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare binding jsonb;original jsonb;operation uuid;
begin
 if p_operation is null or p_operation not in('forward','rollback') then raise exception 'owned execution operation refused' using errcode='22023';end if;
 binding:=public.resolve_owned_execution_target(p_tenant_id,p_plan_id,p_action_id,p_request_key,p_signed_token,p_spiffe_id);
 original:=case when p_operation='forward' then binding->'before' else binding->'forward' end;
 if original is null or original='null'::jsonb then raise exception 'owned rollback source absent' using errcode='42501';end if;
 operation:=owned_synthetic.execution_operation_id((binding->>'batchId')::uuid,p_action_id,p_operation);
 return public.cas_owned_synthetic_target(p_tenant_id,(binding->>'bindingId')::uuid,(binding->>'engagementId')::uuid,operation,original,p_operation='forward');
end $$;
revoke all on function owned_synthetic.execution_operation_id(uuid,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;
revoke all on function public.execute_owned_synthetic_action(uuid,uuid,uuid,text,jsonb,text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.execute_owned_synthetic_action(uuid,uuid,uuid,text,jsonb,text,text) to owned_target_controller;
