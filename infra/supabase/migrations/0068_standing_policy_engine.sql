-- ─────────────────────────────────────────────────────────────────────
-- 0068_standing_policy_engine.sql
--
-- W6.2 · M4.1 — the standing-policy engine (Revision 97).
--
-- 0065 created the tables; nothing could write them. This migration gives
-- standing approval policies their lifecycle and their consumer:
--
--   create_standing_policy     the dual-controlled write path: a policy is
--                              human-authored AND human-approved by two
--                              different people, scope-bounded, expiring,
--                              ledgered as monitoring.policy.registered.
--   revoke_standing_policy     the off switch, ledgered as
--                              monitoring.policy.revoked.
--   evaluate_standing_policy   the engine. EVERY action in the request must
--                              fall inside ONE active, unexpired policy's
--                              scope — and then the scoped token is still
--                              issued THROUGH issue_reviewed_plan_approval:
--                              the same plan-version check, the same
--                              dry-run/rollback freshness gate (BR-2), the
--                              same digest over the reviewed content, the
--                              same atomic approval.token.issued ledger
--                              entry. A policy changes WHO approved (its
--                              named approver, carried in the token's
--                              conditions and the ledger detail); it never
--                              changes WHAT must be true before approval.
--                              Scope misses and oversize requests escalate
--                              (monitoring.policy.escalated); within-scope
--                              issuances ledger monitoring.policy.within_
--                              policy. Every decision the POLICY makes is
--                              recorded in policy_evaluations.
--
-- The lapsed-policy branch: a policy past expires_at retires itself the next
-- time anyone asks it a question, and the evaluation is recorded as 'expired'
-- — a dead policy must not linger looking active because nobody remembered
-- to retire it.
-- ─────────────────────────────────────────────────────────────────────

alter type public.ledger_action_type add value if not exists 'monitoring.policy.registered';
alter type public.ledger_action_type add value if not exists 'monitoring.policy.revoked';
alter type public.ledger_action_type add value if not exists 'monitoring.policy.within_policy';
alter type public.ledger_action_type add value if not exists 'monitoring.policy.escalated';

-- Maker-checker as a schema fact: a policy whose author and approver are the
-- same person is not a control, it is a wish with a row number. No rows can
-- exist yet (there was no write path), so the constraint cannot fail.
alter table public.standing_approval_policies
  add constraint standing_policies_dual_control check (created_by <> approved_by);

-- The scope shape, enforced at creation. Only the three keys the engine
-- understands are accepted: an unknown key that today would be ignored is
-- tomorrow's grant on data nobody vetted, the moment the engine grows a
-- reader for it.
create function public.standing_policy_scope_is_valid(p_scope jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p_scope) = 'object'
    and (select count(*) from jsonb_object_keys(p_scope) k
          where k not in ('action_types', 'max_actions', 'environments')) = 0
    and jsonb_typeof(p_scope->'action_types') = 'array'
    and jsonb_array_length(p_scope->'action_types') between 1 and 32
    and not exists (
      select 1 from jsonb_array_elements_text(p_scope->'action_types') t
       where t !~ '^[a-z][a-z0-9_.]{0,79}$')
    and (
      not (p_scope ? 'max_actions')
      or (jsonb_typeof(p_scope->'max_actions') = 'number'
          and p_scope->>'max_actions' ~ '^[1-9][0-9]{0,3}$'
          and (p_scope->>'max_actions')::int <= 1000))
    and (
      not (p_scope ? 'environments')
      or (jsonb_typeof(p_scope->'environments') = 'array'
          and jsonb_array_length(p_scope->'environments') between 1 and 32
          and not exists (
            select 1 from jsonb_array_elements_text(p_scope->'environments') e
             where e !~ '^[a-z0-9][a-z0-9_.-]{0,79}$')))
$$;
revoke all on function public.standing_policy_scope_is_valid(jsonb)
  from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- create_standing_policy — the estate manager's write path. Two different
-- humans: the author (p_created_by) and the approver whose identity the
-- policy's tokens will carry (p_approved_by). One year is the longest a
-- standing delegation may stand.
-- ─────────────────────────────────────────────────────────────────────
create function public.create_standing_policy(
  p_tenant_id uuid,
  p_name text,
  p_scope jsonb,
  p_expires_at timestamptz,
  p_created_by uuid,
  p_approved_by uuid,
  p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.standing_approval_policies;
begin
  if p_name is null or p_name !~ '^[A-Za-z0-9_. -]{1,120}$'
     or not public.standing_policy_scope_is_valid(p_scope)
     or p_expires_at is null or p_expires_at <= now()
     or p_expires_at > now() + interval '365 days' then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if p_created_by is null or p_approved_by is null or p_created_by = p_approved_by then
    return jsonb_build_object('error', 'dual_control_required');
  end if;
  if not exists (select 1 from public.users where id = p_created_by) then
    return jsonb_build_object('error', 'creator_not_found');
  end if;
  if not exists (select 1 from public.users where id = p_approved_by) then
    return jsonb_build_object('error', 'approver_not_found');
  end if;

  insert into public.standing_approval_policies(
      tenant_id, name, version, scope, status, created_by, approved_by, expires_at)
  values (p_tenant_id, p_name, 1, p_scope, 'active', p_created_by, p_approved_by, p_expires_at)
  returning * into r;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_created_by::text, null, null, null,
    'monitoring.policy.registered', r.id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('policy_id', r.id, 'name', r.name, 'version', r.version,
      'scope', r.scope, 'expires_at', r.expires_at, 'approved_by', r.approved_by));

  return jsonb_build_object('policy', jsonb_build_object(
    'id', r.id, 'name', r.name, 'version', r.version, 'scope', r.scope,
    'status', r.status, 'expiresAt', r.expires_at,
    'createdBy', r.created_by, 'approvedBy', r.approved_by));
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- revoke_standing_policy — revocation is immediate and ledgered; the row
-- stays as history. Policy edits do not exist: a changed scope is a new
-- policy with a new approver and a fresh dual control, and the audit trail
-- is the version history.
-- ─────────────────────────────────────────────────────────────────────
create function public.revoke_standing_policy(
  p_tenant_id uuid,
  p_policy_id uuid,
  p_revoked_by uuid,
  p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.standing_approval_policies;
begin
  if p_revoked_by is null
     or not exists (select 1 from public.users where id = p_revoked_by) then
    return jsonb_build_object('error', 'revoker_not_found');
  end if;
  select * into r from public.standing_approval_policies
   where tenant_id = p_tenant_id and id = p_policy_id for update;
  if not found then
    return jsonb_build_object('error', 'policy_not_found');
  end if;
  if r.status <> 'active' then
    return jsonb_build_object('error', 'policy_not_active');
  end if;

  update public.standing_approval_policies
     set status = 'revoked', updated_at = now()
   where tenant_id = p_tenant_id and id = r.id
  returning * into r;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_revoked_by::text, null, null, null,
    'monitoring.policy.revoked', r.id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('policy_id', r.id, 'name', r.name, 'version', r.version));

  return jsonb_build_object('policy', jsonb_build_object(
    'id', r.id, 'name', r.name, 'version', r.version, 'status', r.status,
    'revokedAt', r.updated_at));
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- evaluate_standing_policy — the engine. Lock order matches every other
-- plan-touching path (plan, then policy, then actions inside the issuance)
-- so an evaluation can never interleave with an approval or a claim.
-- ─────────────────────────────────────────────────────────────────────
create function public.evaluate_standing_policy(
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
  v_issued := public.issue_reviewed_plan_approval(
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

revoke all on function
  public.create_standing_policy(uuid,text,jsonb,timestamptz,uuid,uuid,uuid),
  public.revoke_standing_policy(uuid,uuid,uuid,uuid),
  public.evaluate_standing_policy(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,
                                  timestamptz,text,integer,uuid)
  from public, anon, authenticated;
grant execute on function
  public.create_standing_policy(uuid,text,jsonb,timestamptz,uuid,uuid,uuid),
  public.revoke_standing_policy(uuid,uuid,uuid,uuid),
  public.evaluate_standing_policy(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,
                                  timestamptz,text,integer,uuid)
  to service_role;
