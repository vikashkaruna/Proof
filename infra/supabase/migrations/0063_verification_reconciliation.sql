-- ─────────────────────────────────────────────────────────────────────
-- 0063_verification_reconciliation.sql
--
-- W5 · M3.7 + W5.6 (Revision 92).
--
-- `record_verification_result` is the post-execution verification agent's
-- only write path: Parikshan re-runs the checks the remediation targeted
-- and records whether the gap actually closed, per settled action.
--
-- `record_plan_reconciliation` is the maker-checker record (the
-- independent third role that proves Sudhaar and Karya agreed). It
-- COMPUTES out-of-scope execution from the batch and the token rather
-- than accepting it: anything settled outside the approved action_ids is
-- `out_of_scope_executed` — the record is refused and the defect
-- surfaces, per Doc 11 W5.6 ("asserts it and screams").
-- ─────────────────────────────────────────────────────────────────────

alter type public.ledger_action_type add value if not exists 'execution.reconciliation.recorded';

create function public.record_verification_result(
  p_tenant_id uuid,
  p_action_id uuid,
  p_batch_id uuid,
  p_checks jsonb,
  p_outcome text,
  p_evidence_uri text,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  a public.remediation_actions;
  v public.verification_results;
begin
  if p_outcome not in ('passed', 'failed')
     or p_checks is null or jsonb_typeof(p_checks) <> 'array' or octet_length(p_checks::text) > 262144
     or (p_evidence_uri is not null and (length(p_evidence_uri) = 0 or length(p_evidence_uri) > 512
        or p_evidence_uri !~ '^[A-Za-z0-9._:/-]+$')) then
    return jsonb_build_object('error', 'invalid_record');
  end if;

  select * into a from public.remediation_actions
    where tenant_id = p_tenant_id and id = p_action_id for update;
  if not found or a.execution_batch_id is distinct from p_batch_id then
    return jsonb_build_object('error', 'action_not_in_batch');
  end if;
  -- Verification verifies an outcome, so the action must have one.
  if a.final_outcome is null then
    return jsonb_build_object('error', 'action_not_settled');
  end if;

  insert into public.verification_results(tenant_id, action_id, batch_id, checks, outcome,
    evidence_uri, verified_by_agent, correlation_id)
  values (p_tenant_id, p_action_id, p_batch_id, p_checks, p_outcome, p_evidence_uri,
    'parikshan', p_correlation_id)
  returning * into v;

  update public.remediation_actions
     set verification_status = (case when p_outcome = 'passed' then 'succeeded' else 'failed' end)
           ::public.action_status,
         verification_result = p_checks,
         verified_at = now(),
         latest_verification_result_id = v.id,
         updated_at = now()
   where tenant_id = p_tenant_id and id = p_action_id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'agent', 'parikshan', null, null, null,
    (case when p_outcome = 'passed' then 'verification.passed' else 'verification.failed' end)
      ::public.ledger_action_type,
    p_action_id::text, null, null, null, null, null, null,
    (case when p_outcome = 'passed' then 'success' else 'failure' end)::public.ledger_result,
    jsonb_build_object('verification_result_id', v.id, 'batch_id', p_batch_id,
      'check_count', jsonb_array_length(p_checks), 'evidence_uri', p_evidence_uri));

  return jsonb_build_object('verification', jsonb_build_object(
    'id', v.id, 'outcome', v.outcome, 'verifiedAt', v.verified_at));
end $$;
revoke all on function public.record_verification_result(uuid,uuid,uuid,jsonb,text,text,uuid)
  from public, anon, authenticated;
grant execute on function public.record_verification_result(uuid,uuid,uuid,jsonb,text,text,uuid)
  to service_role;

create function public.record_plan_reconciliation(
  p_tenant_id uuid,
  p_plan_id uuid,
  p_batch_id uuid,
  p_correlation_id uuid,
  p_statement text,
  p_statement_signature text
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  b public.execution_batches;
  t public.approval_tokens;
  v_out_of_scope jsonb;
  v_unexecuted jsonb;
  v_drift boolean;
  v_digest text;
  v_verification jsonb;
begin
  if p_statement is null or length(p_statement) = 0 or length(p_statement) > 8192
     or p_statement_signature is null
     or p_statement_signature !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('error', 'invalid_record');
  end if;

  select * into b from public.execution_batches
    where tenant_id = p_tenant_id and id = p_batch_id and plan_id = p_plan_id;
  if not found then
    return jsonb_build_object('error', 'batch_not_found');
  end if;
  if b.finished_at is null then
    return jsonb_build_object('error', 'batch_not_finished');
  end if;

  -- The approved scope comes from the token row itself, never from the
  -- caller.
  select * into t from public.approval_tokens
    where tenant_id = p_tenant_id and id = b.approval_token_id;

  -- Out-of-scope execution is computed here, not asserted by the caller:
  -- any action this batch touched that the token did not cover is a
  -- structural defect, and the record is refused so it screams.
  select coalesce(jsonb_agg(id::text), '[]'::jsonb) into v_out_of_scope
    from public.remediation_actions
   where execution_batch_id = b.id
     and (t.action_ids is null or not (t.action_ids @> array[id]));
  if jsonb_array_length(v_out_of_scope) > 0 then
    return jsonb_build_object('error', 'out_of_scope_executed', 'action_ids', v_out_of_scope);
  end if;

  -- Unexecuted: actions the batch held but never settled (swept back to
  -- `approved` — retryable only under a fresh approval).
  select coalesce(jsonb_agg(jsonb_build_object(
           'action_id', id::text, 'reason', 'swept_unexecuted')), '[]'::jsonb)
    into v_unexecuted
    from public.remediation_actions
   where execution_batch_id = b.id and final_outcome is null;

  -- Parameter-level check: the approved snapshot was the batch's content
  -- digest, computed over the token's approved action set; recompute it
  -- now over that same set. A mismatch means approved content changed —
  -- before or after execution — and the statement says so.
  v_digest := public.action_set_content_digest(p_tenant_id, p_plan_id, t.action_ids);
  v_drift := v_digest is distinct from b.content_digest;

  select coalesce(jsonb_object_agg(id::text, coalesce(final_outcome::text, 'unexecuted')), '{}'::jsonb)
    into v_verification
    from public.remediation_actions where execution_batch_id = b.id;

  insert into public.plan_reconciliations(tenant_id, plan_id, batch_id,
    approved_scope, executed_reality, unexecuted, parameter_diffs, verification_outcomes,
    statement, statement_signature)
  values (p_tenant_id, p_plan_id, b.id,
    jsonb_build_object('token_id', t.id, 'nonce', t.nonce, 'action_ids', to_jsonb(t.action_ids),
      'content_digest', b.content_digest),
    jsonb_build_object('batch_status', b.status, 'succeeded_at_finish',
      (select count(*) from public.remediation_actions
        where execution_batch_id = b.id and final_outcome = 'succeeded'),
      'failed_at_finish',
      (select count(*) from public.remediation_actions
        where execution_batch_id = b.id and final_outcome = 'failed'),
      'rolled_back',
      (select count(*) from public.remediation_actions
        where execution_batch_id = b.id and final_outcome = 'rolled_back'),
      'content_digest_recomputed', v_digest),
    v_unexecuted,
    (case when v_drift
      then jsonb_build_array(jsonb_build_object('kind', 'content_digest_drift',
             'approved', b.content_digest, 'recomputed', v_digest))
      else '[]'::jsonb end),
    v_verification,
    p_statement, p_statement_signature);

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'agent', 'reconciler', null, null, null,
    'execution.reconciliation.recorded', p_plan_id::text, null, null, null, null, null, null,
    (case when jsonb_array_length(v_unexecuted) = 0 and not v_drift
      then 'success' else 'skipped' end)::public.ledger_result,
    jsonb_build_object('batch_id', b.id, 'batch_status', b.status,
      'unexecuted', jsonb_array_length(v_unexecuted), 'content_digest_drift', v_drift,
      'statement_sha256', encode(sha256(convert_to(p_statement, 'UTF8')), 'hex')));

  return jsonb_build_object('reconciliation', jsonb_build_object(
    'unexecuted', jsonb_array_length(v_unexecuted), 'content_digest_drift', v_drift));
end $$;
revoke all on function public.record_plan_reconciliation(uuid,uuid,uuid,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.record_plan_reconciliation(uuid,uuid,uuid,uuid,text,text)
  to service_role;
