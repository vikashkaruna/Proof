-- 0157: BR-2 is enforced against the recorded dry run, not its display cache.
--
-- Finding (owner manual test, 2026-10-17): a Kosha plan showed "dry-run
-- complete" while its dry-run history said "No dry runs recorded yet", and an
-- approver approved it. The approval gates (BFF route, issue_plan_approval in
-- 0026) read only the inline cache on remediation_actions: dry_run_status,
-- dry_run_expires_at and rollback_validated. 0060 made the dry_runs row the
-- source of record and the cache "written only by record_dry_run", but nothing
-- enforced that, so any direct write of the cache (here, the local demo seed)
-- produced an approvable action with no dry run behind it. The approval proof
-- archive (0090) already refuses such a chain at export time; this moves the
-- same rule to the moment approval is granted.
--
-- Three pieces, one rule:
--   * action_approval_blockers(): the rule, as machine-readable codes. It is
--     SECURITY INVOKER, so a tenant member sees blockers only for rows RLS
--     already lets them read, and the BFF (service_role) sees all.
--   * plan_approval_readiness(): the plan-level answer the BFF gate and the
--     plan screen both read, so the screen can say exactly what is missing.
--   * a BEFORE UPDATE trigger that refuses to mark an action approved while any
--     blocker stands. issue_plan_approval is the only writer that sets
--     approval_status = 'approved' (interactive and standing-policy paths both
--     reach it); the trigger also covers any future writer.
--
-- Not enforced on INSERT: dry_runs and remediation_actions reference each
-- other (latest_dry_run_id), so a historical row cannot be inserted already
-- linked. Approval is an UPDATE in every real flow.

-- The rule over one action row as given, so the trigger can judge the row
-- being written rather than the row as stored.
create function public.action_row_approval_blockers(a public.remediation_actions)
returns text[] language plpgsql security invoker set search_path = '' as $$
declare
  d public.dry_runs;
  v_now timestamptz := clock_timestamp();
  v text[] := '{}';
begin

  if a.execution_status in ('executing', 'succeeded', 'failed', 'rolled_back') then
    v := v || 'already_executed'::text;
  end if;

  if a.latest_dry_run_id is not null then
    select * into d from public.dry_runs
     where tenant_id = a.tenant_id and id = a.latest_dry_run_id
       and action_id = a.id and plan_id = a.plan_id;
  end if;

  if d.id is null then
    v := v || 'no_recorded_dry_run'::text;
    if a.dry_run_status is distinct from 'dry_run_complete' then
      v := v || 'dry_run_not_complete'::text;
    end if;
  elsif d.status = 'refused' then
    v := v || 'dry_run_refused'::text;
  elsif d.status = 'failed' then
    v := v || 'dry_run_failed'::text;
  else
    -- A recorded success. The cache must agree with it, it must still be
    -- inside its window, and it must answer for the content as stored now.
    if a.dry_run_status is distinct from 'dry_run_complete' then
      v := v || 'dry_run_not_complete'::text;
    end if;
    if d.expires_at <= v_now or a.dry_run_expires_at is null or a.dry_run_expires_at <= v_now then
      v := v || 'dry_run_expired'::text;
    end if;
    if d.parameters_hash is distinct from encode(sha256(convert_to(a.parameters::text, 'UTF8')), 'hex')
       or d.rollback_definition_hash is distinct from
          encode(sha256(convert_to(a.rollback_definition::text, 'UTF8')), 'hex')
       or d.diff is distinct from a.dry_run_result then
      v := v || 'dry_run_content_changed'::text;
    end if;
  end if;

  if not coalesce(a.rollback_validated, false) or a.rollback_definition is null then
    v := v || 'rollback_not_validated'::text;
  end if;
  return v;
end $$;

create function public.action_approval_blockers(p_tenant_id uuid, p_action_id uuid)
returns text[] language plpgsql security invoker set search_path = '' as $$
declare
  a public.remediation_actions;
begin
  select * into a from public.remediation_actions where tenant_id = p_tenant_id and id = p_action_id;
  if not found then return array['action_not_found']; end if;
  return public.action_row_approval_blockers(a);
end $$;

create function public.plan_approval_readiness(p_tenant_id uuid, p_plan_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  p public.remediation_plans;
  v_approvable text[] := array['draft', 'review', 'approved', 'cancelled'];
  v_actions jsonb;
begin
  select * into p from public.remediation_plans where tenant_id = p_tenant_id and id = p_plan_id;
  if not found then return null; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'actionId', x.id,
      'sequence', x.sequence,
      'actionType', x.action_type,
      'approvalStatus', x.approval_status,
      'executionStatus', x.execution_status,
      'ready', cardinality(x.blockers) = 0,
      'blockers', to_jsonb(x.blockers),
      'rollbackValidated', x.rollback_validated,
      'rollbackValidatedAt', x.rollback_validated_at,
      'dryRun', case when d.id is null then null else jsonb_build_object(
        'id', d.id, 'status', d.status, 'refusalReason', d.refusal_reason,
        'createdAt', d.created_at, 'expiresAt', d.expires_at) end)
    order by x.sequence, x.id), '[]'::jsonb)
    into v_actions
    from (select a.*, public.action_row_approval_blockers(a) as blockers
            from public.remediation_actions a
           where a.tenant_id = p_tenant_id and a.plan_id = p_plan_id) x
    left join public.dry_runs d
      on d.tenant_id = x.tenant_id and d.id = x.latest_dry_run_id and d.action_id = x.id;

  return jsonb_build_object(
    'planId', p.id,
    'planStatus', p.status,
    'planApprovable', p.status::text = any(v_approvable),
    'approvableStatuses', to_jsonb(v_approvable),
    'actions', v_actions,
    'evaluatedAt', clock_timestamp());
end $$;

-- One row per plan for the Remediation Plans list: what the approver needs to
-- see before opening a plan. Decision times come from the records that carry
-- them: the latest issued approval token, and the latest plan.rejected ledger
-- entry (reject_remediation_plan, 0098). SECURITY INVOKER: RLS decides rows.
create function public.plan_decision_summaries(p_tenant_id uuid)
returns table (
  plan_id uuid,
  action_count integer,
  approved_actions integer,
  ready_actions integer,
  recorded_dry_runs integer,
  succeeded_dry_runs integer,
  refused_or_failed_dry_runs integer,
  unrecorded_dry_runs integer,
  expired_dry_runs integer,
  rollbacks_validated integer,
  last_approved_at timestamptz,
  last_rejected_at timestamptz
) language sql security invoker set search_path = '' as $$
  with acts as (
    select a.plan_id, a.approval_status, a.rollback_validated, d.status as run_status,
           d.expires_at as run_expires_at,
           public.action_row_approval_blockers(a) as blockers
      from public.remediation_actions a
      left join public.dry_runs d
        on d.tenant_id = a.tenant_id and d.id = a.latest_dry_run_id and d.action_id = a.id
     where a.tenant_id = p_tenant_id
  )
  select p.id,
         count(x.*)::int,
         count(x.*) filter (where x.approval_status = 'approved')::int,
         count(x.*) filter (where cardinality(x.blockers) = 0)::int,
         count(x.run_status)::int,
         count(x.*) filter (where x.run_status = 'succeeded')::int,
         count(x.*) filter (where x.run_status in ('refused', 'failed'))::int,
         count(x.*) filter (where x.plan_id is not null and x.run_status is null)::int,
         count(x.*) filter (where x.run_status = 'succeeded' and x.run_expires_at <= clock_timestamp())::int,
         count(x.*) filter (where x.rollback_validated)::int,
         (select max(t.issued_at) from public.approval_tokens t
           where t.tenant_id = p_tenant_id and t.plan_id = p.id),
         (select max(l.occurred_at) from public.audit_ledger l
           where l.tenant_id = p_tenant_id and l.action_type = 'plan.rejected'
             and l.target_ref = p.id::text)
    from public.remediation_plans p
    left join acts x on x.plan_id = p.id
   where p.tenant_id = p_tenant_id
   group by p.id;
$$;

create function controller_security.require_recorded_dry_run_for_approval()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_blockers text[];
begin
  if new.approval_status = 'approved'
     and (old.approval_status is distinct from 'approved'
          or new.approval_token_id is distinct from old.approval_token_id) then
    -- BR-2 only. Work already in flight is refused by issuance itself
    -- (actions_in_flight, 0026) and is reported by the readiness answer.
    v_blockers := array_remove(public.action_row_approval_blockers(new), 'already_executed');
    if cardinality(v_blockers) > 0 then
      raise exception 'approval_requires_recorded_dry_run'
        using errcode = 'P0001',
              detail = 'action ' || new.id::text || ': ' || array_to_string(v_blockers, ','),
              hint = 'BR-2: approve only an action with a recorded, fresh, successful dry run '
                     'for its stored content and a validated rollback.';
    end if;
  end if;
  return new;
end $$;

create trigger require_recorded_dry_run_for_approval
  before update of approval_status, approval_token_id on public.remediation_actions
  for each row execute function controller_security.require_recorded_dry_run_for_approval();

revoke all on function public.action_row_approval_blockers(public.remediation_actions),
  public.action_approval_blockers(uuid, uuid),
  public.plan_approval_readiness(uuid, uuid),
  public.plan_decision_summaries(uuid),
  controller_security.require_recorded_dry_run_for_approval()
  from public, anon, authenticated, service_role;
grant execute on function public.action_row_approval_blockers(public.remediation_actions),
  public.action_approval_blockers(uuid, uuid),
  public.plan_approval_readiness(uuid, uuid),
  public.plan_decision_summaries(uuid)
  to authenticated, service_role;
