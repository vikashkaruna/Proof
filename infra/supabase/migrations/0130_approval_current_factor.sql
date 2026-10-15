-- Fresh interactive approvals require the same still-active factor at consumption
-- and locked issuance. Existing signed tokens retain their expiry/revocation rules.
-- Standing policy evaluation keeps its existing independently checked authority.
begin;

alter function public.issue_reviewed_plan_approval(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid,integer) set schema controller_security;
alter function controller_security.issue_reviewed_plan_approval(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid,integer) rename to issue_reviewed_plan_approval_0130;
create function public.issue_reviewed_plan_approval(
  p_tenant_id uuid,
  p_plan_id uuid,
  p_action_ids uuid[],
  p_approver_id uuid,
  p_mode text,
  p_concurrency integer,
  p_stop_on_failure boolean,
  p_signature text,
  p_signed_payload jsonb,
  p_nonce text,
  p_expires_at timestamptz,
  p_reason text,
  p_conditions jsonb,
  p_challenge_id uuid,
  p_expected_digest text,
  -- The step-up attestation the route assembled: which challenge, when it was
  -- satisfied, what binding it carried. FR-7.3 asks for the approver's
  -- identity; a user id alone records whose session it was, and these record
  -- that the human re-authenticated and against what.
  p_mfa_detail jsonb,
  p_correlation_id uuid,
  p_expected_plan_version integer

) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_challenge public.mfa_challenges;
 v_satisfied timestamptz;
 v_now timestamptz;
begin
 if p_challenge_id is null then return jsonb_build_object('decision','fresh_mfa_required');end if;
 -- Match enrollment's user -> factors ordering. NO KEY UPDATE avoids a
 -- factor FK KEY SHARE inversion; factors/challenge are then locked by id.
 perform 1 from public.users where id=p_approver_id for no key update;
 if not found then return jsonb_build_object('decision','fresh_mfa_required');end if;
 perform 1 from public.user_mfa_factors where user_id=p_approver_id and factor_type='totp' order by id for update;
 select * into v_challenge from public.mfa_challenges where id=p_challenge_id for update;
 if not found then return jsonb_build_object('decision','fresh_mfa_required');end if;
 -- Preserve original plan/action locking and semantics. Waiting for an editor
 -- must not preserve a step-up whose wall-clock freshness elapsed meanwhile.
 perform 1 from public.remediation_plans where id=p_plan_id and tenant_id=p_tenant_id for update;
 perform 1 from public.remediation_actions where tenant_id=p_tenant_id and plan_id=p_plan_id and id=any(p_action_ids) order by id for update;
 v_now:=clock_timestamp();
 if v_challenge.user_id is distinct from p_approver_id
  or v_challenge.tenant_id is distinct from p_tenant_id
  or v_challenge.purpose is distinct from 'approval_issuance'::public.mfa_challenge_purpose
  or lower(v_challenge.bound_resource_ref) is distinct from p_plan_id::text
  or not coalesce(v_challenge.bound_payload_sha256 ~ '^[0-9a-f]{64}$',false)
  or v_challenge.satisfied_at is null or v_challenge.consumed_at is null
  or v_challenge.created_at>v_challenge.satisfied_at
  or v_challenge.satisfied_at>v_now or v_challenge.satisfied_at<=v_now-interval '5 minutes'
  or v_challenge.consumed_at<v_challenge.satisfied_at or v_challenge.consumed_at>v_now
  or v_challenge.expires_at<=v_now
  or lower(v_challenge.consumed_for) is distinct from p_plan_id::text
  or exists(select 1 from public.approval_tokens where id::text=lower(v_challenge.consumed_for))
  or not exists(select 1 from public.user_mfa_factors where id=v_challenge.factor_id
   and user_id=p_approver_id and factor_type='totp' and status='active' and revoked_at is null)
 then return jsonb_build_object('decision','fresh_mfa_required');end if;
 -- Match the retained challenge to the exact attestation assembled by the
 -- trusted BFF from the same reviewed rows as p_expected_digest. The TS binding
 -- hash and existing PG reviewed-content hash intentionally remain distinct.
 if p_mfa_detail is distinct from jsonb_build_object('mfa',jsonb_build_object(
   'challengeId',p_challenge_id,'satisfiedAt',p_mfa_detail#>'{mfa,satisfiedAt}',
   'binding',v_challenge.bound_payload_sha256))
  or jsonb_typeof(p_mfa_detail#>'{mfa,satisfiedAt}') is distinct from 'string'
 then return jsonb_build_object('decision','fresh_mfa_required');end if;
 begin
  v_satisfied:=(p_mfa_detail#>>'{mfa,satisfiedAt}')::timestamptz;
 exception when invalid_datetime_format or datetime_field_overflow then
  return jsonb_build_object('decision','fresh_mfa_required');
 end;
 if v_satisfied is distinct from v_challenge.satisfied_at then
  return jsonb_build_object('decision','fresh_mfa_required');end if;
 return controller_security.issue_reviewed_plan_approval_0130(
p_tenant_id,p_plan_id,p_action_ids,p_approver_id,p_mode,p_concurrency,p_stop_on_failure,p_signature,p_signed_payload,p_nonce,p_expires_at,p_reason,p_conditions,p_challenge_id,p_expected_digest,p_mfa_detail,p_correlation_id,p_expected_plan_version);
end $$;

-- No helper EXECUTE for API, human writers, PUBLIC, or default-grant recipients.
do $$declare r record;begin
 for r in select rolname from pg_catalog.pg_roles where rolname<>current_user loop
  execute format('revoke all on function controller_security.issue_reviewed_plan_approval_0130(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid,integer) from %I',r.rolname);
  execute format('revoke all on function public.issue_reviewed_plan_approval(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid,integer) from %I',r.rolname);
 end loop;
end $$;
revoke all on function controller_security.issue_reviewed_plan_approval_0130(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid,integer),public.issue_reviewed_plan_approval(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid,integer) from public;
grant execute on function public.issue_reviewed_plan_approval(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid,integer) to service_role;

-- The evaluator body is unchanged except its reviewed helper call target.
create or replace function public.evaluate_standing_policy(
  p_tenant_id uuid,
  p_plan_id uuid,
  p_action_ids uuid[],
  p_policy_id uuid,
  p_mode text,
  p_concurrency integer,
  p_stop_on_failure boolean,
  p_signature text,
  p_signed_payload jsonb,
  p_nonce text,
  p_expires_at timestamptz,
  p_expected_digest text,
  p_expected_plan_version integer,
  p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_policy public.standing_approval_policies;
  v_evaluation public.policy_evaluations;
  v_action_types text[];
  v_uncovered text[];
  v_max_actions integer;
  v_issued jsonb;
  v_token_id uuid;
begin
  -- Shape first, before any lock.
  if coalesce(cardinality(p_action_ids), 0) = 0
     or exists (select 1 from unnest(p_action_ids) id where id is null)
     or cardinality(p_action_ids) <> (select count(distinct id) from unnest(p_action_ids) id) then
    return jsonb_build_object('decision', 'invalid_actions');
  end if;

  perform 1 from public.remediation_plans
   where id = p_plan_id and tenant_id = p_tenant_id for update;
  if not found then
    return jsonb_build_object('decision', 'plan_not_found');
  end if;

  select * into v_policy from public.standing_approval_policies
   where tenant_id = p_tenant_id and id = p_policy_id for update;
  if not found then
    return jsonb_build_object('decision', 'policy_not_found');
  end if;

  -- A lapsed policy retires itself the next time anyone asks it a question.
  -- clock_timestamp, not now(): freshness gates answer for the moment the
  -- question is asked, exactly like the dry-run TTL in issue_plan_approval.
  if v_policy.status = 'active' and v_policy.expires_at <= clock_timestamp() then
    update public.standing_approval_policies
       set status = 'expired', updated_at = now()
     where tenant_id = p_tenant_id and id = v_policy.id;
    v_policy.status := 'expired';
  end if;

  if v_policy.status in ('expired', 'revoked') then
    insert into public.policy_evaluations(
        tenant_id, policy_id, plan_id, decision, matched_scope, correlation_id)
    values (p_tenant_id, v_policy.id, p_plan_id, v_policy.status,
            jsonb_build_object('reason', 'policy_' || v_policy.status),
            p_correlation_id)
    returning * into v_evaluation;
    return jsonb_build_object('decision', 'policy_' || v_policy.status,
                              'evaluation_id', v_evaluation.id);
  end if;

  -- The request's actions, tenant- and plan-bound. An id that does not belong
  -- to this plan is a refusal, not a subset to evaluate.
  if (select count(*) from public.remediation_actions a
       where a.tenant_id = p_tenant_id and a.plan_id = p_plan_id
         and a.id = any(p_action_ids)) <> cardinality(p_action_ids) then
    return jsonb_build_object('decision', 'actions_not_found');
  end if;

  select array_agg(distinct a.action_type order by a.action_type)
    into v_action_types
    from public.remediation_actions a
   where a.tenant_id = p_tenant_id and a.plan_id = p_plan_id
     and a.id = any(p_action_ids);

  select array_agg(t order by t)
    into v_uncovered
    from unnest(v_action_types) t
   where not exists (
     select 1 from jsonb_array_elements_text(v_policy.scope->'action_types') s
      where s = t);

  v_max_actions := null;
  if v_policy.scope ? 'max_actions' then
    v_max_actions := (v_policy.scope->>'max_actions')::int;
  end if;

  if v_uncovered is not null
     or (v_max_actions is not null and cardinality(p_action_ids) > v_max_actions) then
    insert into public.policy_evaluations(
        tenant_id, policy_id, plan_id, decision, matched_scope, correlation_id)
    values (p_tenant_id, v_policy.id, p_plan_id, 'escalated',
            jsonb_build_object(
              'uncovered_action_types', to_jsonb(coalesce(v_uncovered, '{}'::text[])),
              'requested_action_count', cardinality(p_action_ids),
              'max_actions', v_max_actions),
            p_correlation_id)
    returning * into v_evaluation;
    perform public.append_ledger(
      p_tenant_id, p_correlation_id, 'agent', 'nazar', null, null, null,
      'monitoring.policy.escalated', p_plan_id::text, null, null, null, null, null, null, 'success',
      jsonb_build_object('policy_id', v_policy.id, 'policy_version', v_policy.version,
        'plan_id', p_plan_id, 'evaluation_id', v_evaluation.id,
        'uncovered_action_types', to_jsonb(coalesce(v_uncovered, '{}'::text[]))));
    return jsonb_build_object('decision', 'escalated',
                              'evaluation_id', v_evaluation.id,
                              'uncovered_action_types',
                                to_jsonb(coalesce(v_uncovered, '{}'::text[])));
  end if;

  -- THE GATE. The policy decides WHO approves — its named approver, recorded
  -- in the token's conditions and the issuance's ledger detail. Everything
  -- that makes an approval safe runs exactly as an interactive approval:
  -- the plan-version check, the dry-run/rollback freshness gate, the digest
  -- over the reviewed content, the atomic ledger entry.
  v_issued := controller_security.issue_reviewed_plan_approval_0130(
    p_tenant_id, p_plan_id, p_action_ids, v_policy.approved_by,
    p_mode, p_concurrency, p_stop_on_failure,
    p_signature, p_signed_payload, p_nonce, p_expires_at,
    'standing policy "' || v_policy.name || '" v' || v_policy.version::text,
    jsonb_build_object('standing_policy_id', v_policy.id,
                       'standing_policy_version', v_policy.version),
    null, p_expected_digest,
    jsonb_build_object('standingPolicy', jsonb_build_object(
      'id', v_policy.id, 'version', v_policy.version, 'name', v_policy.name,
      'approvedBy', v_policy.approved_by)),
    p_correlation_id, p_expected_plan_version);

  if coalesce(v_issued->>'decision', '') <> 'issued' then
    -- The gate refused for an operational reason (a stale dry-run, an action
    -- in flight, content drift). The policy made no authority decision here,
    -- so no evaluation is recorded — the ordinary approve route is the human
    -- path, and it will run the same refusals.
    return v_issued;
  end if;

  v_token_id := (v_issued->>'token_id')::uuid;

  insert into public.policy_evaluations(
      tenant_id, policy_id, plan_id, decision, matched_scope, correlation_id)
  values (p_tenant_id, v_policy.id, p_plan_id, 'within_policy',
          jsonb_build_object('action_types', to_jsonb(v_action_types),
            'action_count', cardinality(p_action_ids),
            'policy_version', v_policy.version,
            'token_id', v_token_id),
          p_correlation_id)
  returning * into v_evaluation;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'agent', 'nazar', null, null, null,
    'monitoring.policy.within_policy', p_plan_id::text, null, null, v_token_id, null, null, null, 'success',
    jsonb_build_object('policy_id', v_policy.id, 'policy_version', v_policy.version,
      'plan_id', p_plan_id, 'evaluation_id', v_evaluation.id,
      'action_count', cardinality(p_action_ids)));

  return jsonb_build_object('decision', 'issued',
                            'token_id', v_token_id,
                            'expires_at', v_issued->'expires_at',
                            'content_digest', v_issued->>'content_digest',
                            'evaluation_id', v_evaluation.id);
end $$;
commit;
