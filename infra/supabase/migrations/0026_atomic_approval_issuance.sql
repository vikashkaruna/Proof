-- W1: issuing an approval is one transaction, or it is nothing.
--
-- The approve route did the work in seven round trips: consume the challenge,
-- sign, insert the token, link the challenge to it, mark the actions approved,
-- move the plan, append the ledger. Each committed on its own, so a fault
-- between any two left the system in a state nobody designed:
--
--   · token persisted, actions not approved — live signed authority for work
--     `claim_plan_execution` will refuse, and a plan nobody can move
--   · token persisted, challenge not linked — the trail token → challenge →
--     factor → user is broken, which is the trail FR-7.3 exists to produce
--   · actions approved, LEDGER NOT APPENDED — authority exists over a client's
--     estate with no tamper-evident record of who granted it. That is the
--     serious one: the row says approved and the chain says nothing happened
--
-- Consuming the challenge stays outside, deliberately. Burning a challenge and
-- then failing costs the approver a re-authentication, which is annoying and
-- safe. Everything after it is now atomic.
--
-- The digest check is the other half. The route recomputes the content digest
-- before calling, but between that read and the rows being written anyone with
-- update rights could change an action — the same window `planVersion` could
-- not see, one layer lower. `action_set_content_digest` is recomputed here
-- under the row locks and compared, so the content that is approved is the
-- content that was verified.
begin;

-- The digest, computed by the database so both ends of the comparison agree by
-- construction rather than by two languages canonicalising JSON identically.
-- That agreement is exactly what R-05 showed cannot be assumed.
create function public.action_set_content_digest(
  p_tenant_id uuid,
  p_plan_id uuid,
  p_action_ids uuid[]
) returns text language sql stable security definer set search_path = '' as $$
  select encode(
    public.digest(
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', a.id,
            'action_type', a.action_type,
            'parameters', a.parameters,
            'rollback_definition', a.rollback_definition,
            -- A set: ordering carries no meaning and must not change the hash.
            'closes_finding_ids', (
              select coalesce(jsonb_agg(f order by f), '[]'::jsonb)
              from unnest(a.closes_finding_ids) f
            ),
            -- The dry-run diff the approver read. A re-run producing a
            -- different simulated outcome is a different thing to have agreed
            -- to, even when the definition is untouched.
            'dry_run_result', a.dry_run_result
          )
          order by a.id
        ),
        '[]'::jsonb
      )::text,
      'sha256'
    ),
    'hex'
  )
  from public.remediation_actions a
  where a.tenant_id = p_tenant_id and a.plan_id = p_plan_id and a.id = any(p_action_ids);
$$;

create function public.issue_plan_approval(
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
  p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_locked integer;
  v_digest text;
  v_token_id uuid;
  v_expires timestamptz;
begin
  if coalesce(cardinality(p_action_ids), 0) = 0
     or exists (select 1 from unnest(p_action_ids) id where id is null)
     or cardinality(p_action_ids) <> (select count(distinct id) from unnest(p_action_ids) id) then
    return jsonb_build_object('decision', 'invalid_actions');
  end if;

  -- Same lock order as claim_plan_execution and reconcile_execution_dispatch:
  -- plan first, then actions by id. An approval and a claim for the same plan
  -- cannot interleave.
  perform 1 from public.remediation_plans
   where id = p_plan_id and tenant_id = p_tenant_id for update;
  if not found then
    return jsonb_build_object('decision', 'plan_not_found');
  end if;

  perform 1 from public.remediation_actions
   where tenant_id = p_tenant_id and plan_id = p_plan_id and id = any(p_action_ids)
   order by id for update;
  get diagnostics v_locked = row_count;
  if v_locked <> cardinality(p_action_ids) then
    return jsonb_build_object('decision', 'actions_not_found');
  end if;

  -- Work already in flight or already finished is not approvable again.
  if exists (
    select 1 from public.remediation_actions a
    where a.tenant_id = p_tenant_id and a.plan_id = p_plan_id and a.id = any(p_action_ids)
      and a.execution_status in ('executing', 'succeeded', 'failed', 'rolled_back')
  ) then
    return jsonb_build_object('decision', 'actions_in_flight');
  end if;

  -- Eligibility, rechecked under the locks. The route checks these too; reads
  -- there can go stale before the write lands.
  if exists (
    select 1 from public.remediation_actions a
    where a.tenant_id = p_tenant_id and a.plan_id = p_plan_id and a.id = any(p_action_ids)
      and (a.dry_run_status <> 'dry_run_complete'
           or not a.rollback_validated
           or a.dry_run_expires_at is null
           or a.dry_run_expires_at <= clock_timestamp())
  ) then
    return jsonb_build_object('decision', 'actions_not_ready');
  end if;

  -- The content that is about to be approved must be the content that was
  -- verified against the step-up binding.
  v_digest := public.action_set_content_digest(p_tenant_id, p_plan_id, p_action_ids);
  if p_expected_digest is null or v_digest is distinct from p_expected_digest then
    return jsonb_build_object('decision', 'content_changed');
  end if;

  insert into public.approval_tokens(
    tenant_id, plan_id, action_ids, approver_id, mode, concurrency, stop_on_failure,
    signature, signed_payload, nonce, expires_at, reason, conditions, status)
  values (
    p_tenant_id, p_plan_id, p_action_ids, p_approver_id, p_mode, p_concurrency, p_stop_on_failure,
    p_signature, p_signed_payload, p_nonce, p_expires_at, p_reason,
    coalesce(p_conditions, '{}'::jsonb), 'issued')
  returning id, expires_at into v_token_id, v_expires;

  -- The trail runs both ways: token → challenge → factor → user.
  if p_challenge_id is not null then
    update public.mfa_challenges
       set consumed_for = v_token_id::text
     where id = p_challenge_id and user_id = p_approver_id;
  end if;

  update public.remediation_actions
     set approval_status = 'approved',
         approval_token_id = v_token_id,
         approved_by = p_approver_id,
         approved_at = now(),
         final_outcome = null
   where tenant_id = p_tenant_id and plan_id = p_plan_id and id = any(p_action_ids);

  update public.remediation_plans
     set status = 'approved'
   where id = p_plan_id and tenant_id = p_tenant_id;

  -- In the same transaction, so authority cannot exist without the record of
  -- who granted it. A ledger outage rolls the whole issuance back.
  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_approver_id::text,
    null, null, null, 'approval.token.issued', p_plan_id::text,
    null, null, v_token_id, p_approver_id, null, null, 'success',
    jsonb_build_object(
      'actionIds', to_jsonb(p_action_ids),
      'mode', p_mode,
      'concurrency', p_concurrency,
      'stopOnFailure', p_stop_on_failure,
      'expiresAt', p_expires_at,
      'reason', p_reason,
      'contentDigest', v_digest,
      'mfaChallengeId', p_challenge_id)
    || coalesce(p_mfa_detail, '{}'::jsonb));

  return jsonb_build_object(
    'decision', 'issued',
    'token_id', v_token_id,
    'expires_at', v_expires,
    'content_digest', v_digest);
end $$;

revoke all on function
  public.action_set_content_digest(uuid, uuid, uuid[]),
  public.issue_plan_approval(uuid, uuid, uuid[], uuid, text, integer, boolean, text, jsonb, text,
                             timestamptz, text, jsonb, uuid, text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function
  public.action_set_content_digest(uuid, uuid, uuid[]),
  public.issue_plan_approval(uuid, uuid, uuid[], uuid, text, integer, boolean, text, jsonb, text,
                             timestamptz, text, jsonb, uuid, text, jsonb, uuid)
  to service_role;

commit;
