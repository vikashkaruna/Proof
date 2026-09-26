-- ─────────────────────────────────────────────────────────────────────
-- 0062_rollback_engine.sql
--
-- W5 · M3.5 — the rollback engine's write path (Revision 91).
--
-- `record_rollback_execution` is the only way anything reaches
-- `rollback_executions`. It enforces what B.10.5 promises: a rollback
-- executes Sudhaar's stored definition — the exact jsonb on the action,
-- re-read and compared here, never a reconstruction — and only against
-- an action this batch actually completed. A rolled-back action returns
-- to `rolled_back`, and both ledger phases (started, completed) commit
-- atomically with the record.
-- ─────────────────────────────────────────────────────────────────────

create function public.record_rollback_execution(
  p_tenant_id uuid,
  p_action_id uuid,
  p_batch_id uuid,
  p_definition jsonb,
  p_triggered_by text,
  p_status text,
  p_result jsonb,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  a public.remediation_actions;
  r public.rollback_executions;
  v_definition_hash text;
begin
  if p_triggered_by not in ('failure_threshold', 'manual', 'governor', 'verification')
     or p_status not in ('succeeded', 'failed', 'partial')
     or p_definition is null or jsonb_typeof(p_definition) <> 'object'
     or octet_length(p_definition::text) > 262144
     or (p_result is not null and (jsonb_typeof(p_result) <> 'object' or octet_length(p_result::text) > 262144)) then
    return jsonb_build_object('error', 'invalid_record');
  end if;

  select * into a from public.remediation_actions
    where tenant_id = p_tenant_id and id = p_action_id for update;
  if not found then
    return jsonb_build_object('error', 'action_not_found');
  end if;
  if a.execution_batch_id is distinct from p_batch_id then
    return jsonb_build_object('error', 'batch_mismatch');
  end if;

  -- Only a completed action can be reversed, and only once.
  if a.final_outcome is distinct from 'succeeded' then
    return jsonb_build_object('error', 'action_not_reversible');
  end if;

  -- The engine executes the stored definition, exactly.
  if p_definition is distinct from a.rollback_definition then
    return jsonb_build_object('error', 'definition_mismatch');
  end if;

  v_definition_hash := encode(sha256(convert_to(a.rollback_definition::text, 'UTF8')), 'hex');

  insert into public.rollback_executions(tenant_id, action_id, batch_id, definition, definition_hash,
    triggered_by, status, result, executed_by_agent, correlation_id, finished_at)
  values (p_tenant_id, p_action_id, p_batch_id, a.rollback_definition, v_definition_hash,
    p_triggered_by, p_status, p_result, 'karya', p_correlation_id, now())
  returning * into r;

  update public.remediation_actions
     set execution_status = 'rolled_back',
         final_outcome = 'rolled_back',
         latest_rollback_execution_id = r.id,
         updated_at = now()
   where tenant_id = p_tenant_id and id = p_action_id;

  -- Both phases commit together: the intent and its outcome are one
  -- transaction, so the ledger never shows a rollback that did not
  -- conclude, nor an outcome without its start.
  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'agent', 'karya', null, null, null,
    'execution.rollback.started', p_action_id::text, null, null, null, null, null, null, 'pending',
    jsonb_build_object('rollback_execution_id', r.id, 'batch_id', p_batch_id,
      'triggered_by', p_triggered_by, 'definition_hash', v_definition_hash));
  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'agent', 'karya', null, null, null,
    'execution.rollback.completed', p_action_id::text, null, null, null, null, null, null,
    (case when p_status = 'succeeded' then 'success' else 'failure' end)::public.ledger_result,
    jsonb_build_object('rollback_execution_id', r.id, 'batch_id', p_batch_id,
      'status', p_status, 'triggered_by', p_triggered_by, 'result', p_result));

  return jsonb_build_object('rollback', jsonb_build_object(
    'id', r.id, 'status', r.status, 'definitionHash', v_definition_hash, 'finishedAt', r.finished_at));
end $$;
revoke all on function public.record_rollback_execution(uuid,uuid,uuid,jsonb,text,text,jsonb,uuid)
  from public, anon, authenticated;
grant execute on function public.record_rollback_execution(uuid,uuid,uuid,jsonb,text,text,jsonb,uuid)
  to service_role;
