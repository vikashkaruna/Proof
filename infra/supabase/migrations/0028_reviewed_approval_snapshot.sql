-- Bridge the MFA-bound read to the locked issuance snapshot. Never fetch a
-- newer live digest after MFA and mistake it for the reviewed action content.
-- The pure helper and live digest share the exact 0026 representation, so
-- existing signed tokens retain their digest across this migration.
begin;

create function public.reviewed_action_content_digest(p_actions jsonb) returns text language sql immutable security definer set search_path = '' as $$
  select pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
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
      'UTF8')
    ),
    'hex'
  )
  from jsonb_to_recordset(p_actions) as a(
    id uuid, action_type text, parameters jsonb, rollback_definition jsonb,
    closes_finding_ids uuid[], dry_run_result jsonb);
$$;

create or replace function public.action_set_content_digest(
  p_tenant_id uuid, p_plan_id uuid, p_action_ids uuid[]
) returns text language sql stable security definer set search_path = '' as $$
  select public.reviewed_action_content_digest(coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb))
    from public.remediation_actions a
    where a.tenant_id = p_tenant_id and a.plan_id = p_plan_id and a.id = any(p_action_ids);
$$;

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

) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_version integer; v_status text;
begin
  select version, status::text into v_version, v_status from public.remediation_plans
    where id = p_plan_id and tenant_id = p_tenant_id for update;
  if not found then return jsonb_build_object('decision', 'plan_not_found'); end if;
  if p_expected_plan_version is null or v_version is distinct from p_expected_plan_version then
    return jsonb_build_object('decision', 'plan_changed');
  end if;
  if v_status not in ('draft', 'review', 'approved', 'cancelled') then
    return jsonb_build_object('decision', 'plan_not_approvable');
  end if;
  if p_signed_payload->>'contentDigest' is distinct from p_expected_digest then
    return jsonb_build_object('decision', 'content_changed');
  end if;
  return public.issue_plan_approval(
    p_tenant_id, p_plan_id, p_action_ids, p_approver_id, p_mode, p_concurrency,
    p_stop_on_failure, p_signature, p_signed_payload, p_nonce, p_expires_at,
    p_reason, p_conditions, p_challenge_id, p_expected_digest, p_mfa_detail, p_correlation_id);
end $$;

-- Only the version-checked entrypoint is available to the API role. The
-- original function remains internal to preserve applied SQL history.
revoke execute on function public.issue_plan_approval(uuid, uuid, uuid[], uuid, text,
 integer, boolean, text, jsonb, text, timestamptz, text, jsonb, uuid, text, jsonb, uuid)
 from service_role;
revoke all on function public.reviewed_action_content_digest(jsonb),
 public.issue_reviewed_plan_approval(uuid, uuid, uuid[], uuid, text, integer, boolean,
 text, jsonb, text, timestamptz, text, jsonb, uuid, text, jsonb, uuid, integer)
 from public, anon, authenticated;
grant execute on function public.reviewed_action_content_digest(jsonb),
 public.issue_reviewed_plan_approval(uuid, uuid, uuid[], uuid, text, integer, boolean,
 text, jsonb, text, timestamptz, text, jsonb, uuid, text, jsonb, uuid, integer)
 to service_role;
commit;
