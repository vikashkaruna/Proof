-- W4.6 first SQL binding: grant resolution for cloud-IAM SQL connectors.
-- These connectors hold no vault credential; the workload mints a short-lived
-- IAM database token itself. The grant, workload, lifecycle, descriptor pin and
-- kill switch are still re-read on every invocation. Read scope only: SQL
-- writes stay unavailable until W5 approved-action execution.
create function public.resolve_sql_read_grant(
  p_tenant_id uuid, p_estate_id uuid, p_connector_id uuid, p_spiffe_id text
) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'grantId', g.id, 'workloadId', w.id, 'agentName', g.agent_name, 'spiffeId', w.spiffe_id,
    'systemId', s.id, 'grantExpiresAt', g.expires_at, 'connectorVersion', c.version,
    'descriptorSha256', d.content_sha256, 'endpointRef', c.endpoint_ref, 'targetBinding', c.target_binding)
  from public.connector_grants g
  join public.workload_identities w on (w.tenant_id, w.id, w.agent_name) = (g.tenant_id, g.workload_identity_id, g.agent_name)
  join public.connectors c on (c.tenant_id, c.id) = (g.tenant_id, g.connector_id)
  join public.estate_systems s on (s.tenant_id, s.id) = (c.tenant_id, c.system_id)
  join public.estates e on (e.tenant_id, e.id) = (s.tenant_id, s.estate_id)
  join public.connector_descriptors d on d.id = c.descriptor_id and d.target_binding = c.target_binding
  where g.tenant_id = p_tenant_id and e.id = p_estate_id and c.id = p_connector_id
    and g.internal_scope = 'connector.read' and g.agent_name = 'drishti'
    and d.transport = 'sql' and d.manifest->>'auth' = 'cloud_iam'
    and w.spiffe_id = p_spiffe_id and w.status = 'active'
    and g.revoked_at is null and g.expires_at > statement_timestamp()
    and c.status = 'active' and s.status = 'active' and e.status = 'active'
    and not exists (select 1 from public.kill_switch_state ks where ks.engaged
      and (ks.scope = 'global' or ks.tenant_id = p_tenant_id))
  order by g.expires_at desc
  limit 1
$$;
revoke all on function public.resolve_sql_read_grant(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.resolve_sql_read_grant(uuid,uuid,uuid,text) to service_role;
