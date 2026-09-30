-- An export receipt is written only through record_approval_export, which
-- validates the tenant/actor and appends the matching ledger event. A direct
-- service-role table INSERT could otherwise invent a receipt without either.
revoke insert on public.approval_exports from service_role;

drop policy approval_exports_service_all on public.approval_exports;
create policy approval_exports_service_read on public.approval_exports
  for select to service_role using (true);

-- The HTTP capability check must be backed by a live role check at the only
-- write path. In particular, an old PLAN_READ client cannot ask the service
-- credential to record an export under a viewer or approver identity.
create or replace function public.record_approval_export(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_plan_id uuid,
  p_format text,
  p_filter_params jsonb,
  p_summary jsonb,
  p_artifact_sha256 text,
  p_artifact_bytes bigint,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_export public.approval_exports;
begin
  if not exists (select 1 from public.tenants where id = p_tenant_id) then
    return jsonb_build_object('error', 'tenant_not_found');
  end if;

  if not exists (
    select 1 from public.tenant_users
     where tenant_id = p_tenant_id and user_id = p_actor_id
       and role in ('founder', 'axiom_analyst', 'owner', 'admin', 'partner')
  ) then
    return jsonb_build_object('error', 'forbidden');
  end if;

  if p_plan_id is not null and not exists (
    select 1 from public.remediation_plans
     where tenant_id = p_tenant_id and id = p_plan_id
  ) then
    return jsonb_build_object('error', 'plan_not_found');
  end if;

  if p_format not in ('json', 'html', 'pdf', 'csv') then
    return jsonb_build_object('error', 'invalid_format');
  end if;

  if p_correlation_id is null or p_filter_params is null
     or jsonb_typeof(p_filter_params) is distinct from 'object'
     or p_summary is null or jsonb_typeof(p_summary) is distinct from 'object'
     or octet_length(p_filter_params::text) > 32768
     or octet_length(p_summary::text) > 32768 then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  if p_artifact_sha256 is null or p_artifact_sha256 !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('error', 'invalid_artifact_hash');
  end if;

  if p_artifact_bytes is null or p_artifact_bytes < 1 or p_artifact_bytes > 67108864 then
    return jsonb_build_object('error', 'invalid_artifact_size');
  end if;

  insert into public.approval_exports (
    tenant_id, exported_by, plan_id, format, filter_params, summary,
    artifact_sha256, artifact_bytes
  ) values (
    p_tenant_id, p_actor_id, p_plan_id, p_format,
    p_filter_params, p_summary, p_artifact_sha256, p_artifact_bytes
  ) returning * into v_export;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_actor_id::text, null, null, null,
    'approval.exported'::public.ledger_action_type, v_export.id::text,
    null, null, null, null, null, null, 'success',
    jsonb_build_object(
      'export_id', v_export.id,
      'plan_id', p_plan_id,
      'format', p_format,
      'artifact_sha256', p_artifact_sha256,
      'artifact_bytes', p_artifact_bytes
    )
  );

  return jsonb_build_object(
    'exportId', v_export.id,
    'status', 'exported',
    'artifactSha256', v_export.artifact_sha256,
    'createdAt', v_export.created_at
  );
end $$;
