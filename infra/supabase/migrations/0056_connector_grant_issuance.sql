-- W4.4 connector grants: human issuance and per-invocation resolution.
-- The accepted matrix stays enforced by 0033's check: Drishti reads, only
-- Karya writes. Issuing a grant does not obtain a credential or contact a
-- target; the broker resolves the grant again on every acquisition.
alter type public.ledger_action_type add value if not exists 'connector.grant.issued';

create function public.issue_connector_grant(
  p_tenant_id uuid, p_actor_id uuid, p_connector_id uuid, p_workload_identity_id uuid,
  p_scope text, p_target_scopes text[], p_ttl_days integer, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.connectors; s public.estate_systems; e public.estates; w public.workload_identities;
  g public.connector_grants;
begin
  perform 1 from public.tenant_users where tenant_id = p_tenant_id and user_id = p_actor_id
    and role in ('founder','owner','admin') for share;
  if not found then return jsonb_build_object('error','forbidden'); end if;
  if p_scope is null or p_scope not in ('connector.read','connector.write')
     or p_ttl_days is null or p_ttl_days not between 1 and 90
     or p_target_scopes is null or cardinality(p_target_scopes) not between 1 and 100
     or exists (select 1 from unnest(p_target_scopes) t where t is null or t !~ '^[\x21\x23-\x5b\x5d-\x7e]{1,200}$')
     or (select count(distinct t) from unnest(p_target_scopes) t) <> cardinality(p_target_scopes) then
    return jsonb_build_object('error','invalid_request');
  end if;
  -- Lock in the same order as connector/estate lifecycle changes.
  select * into c from public.connectors where tenant_id = p_tenant_id and id = p_connector_id for share;
  if not found then return jsonb_build_object('error','not_found'); end if;
  select * into s from public.estate_systems where tenant_id = p_tenant_id and id = c.system_id;
  select * into e from public.estates where tenant_id = p_tenant_id and id = s.estate_id;
  if c.status <> 'active' or s.status <> 'active' or e.status <> 'active' then
    return jsonb_build_object('error','connector_inactive');
  end if;
  select * into w from public.workload_identities where tenant_id = p_tenant_id and id = p_workload_identity_id for share;
  if not found then return jsonb_build_object('error','not_found'); end if;
  if w.status <> 'active' then return jsonb_build_object('error','workload_inactive'); end if;
  if (w.agent_name = 'drishti' and p_scope <> 'connector.read') or (w.agent_name = 'karya' and p_scope <> 'connector.write')
     or w.agent_name not in ('drishti','karya') then
    return jsonb_build_object('error','agent_scope_refused');
  end if;
  -- Reference and sandbox bindings can never carry write authority.
  if p_scope = 'connector.write' and c.target_binding <> 'production' then
    return jsonb_build_object('error','write_requires_production');
  end if;
  if exists (select 1 from public.connector_grants where tenant_id = p_tenant_id and connector_id = c.id
      and workload_identity_id = w.id and internal_scope = p_scope and revoked_at is null and expires_at > now()) then
    return jsonb_build_object('error','grant_exists');
  end if;
  insert into public.connector_grants(tenant_id, connector_id, workload_identity_id, agent_name, internal_scope,
    target_scopes, expires_at)
  values (p_tenant_id, c.id, w.id, w.agent_name, p_scope, p_target_scopes, now() + make_interval(days => p_ttl_days))
  returning * into g;
  perform public.append_ledger(p_tenant_id, p_correlation_id, 'human', p_actor_id::text, null, null, null,
    'connector.grant.issued', g.id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('connector_id', c.id, 'workload_identity_id', w.id, 'agent_name', w.agent_name,
      'scope', p_scope, 'target_scopes', to_jsonb(p_target_scopes), 'expires_at', g.expires_at));
  return jsonb_build_object('grant', to_jsonb(g));
end $$;

-- Per-invocation resolution for the broker authority. Called only after the
-- workload's SVID has been verified. Every lifecycle input is re-read here in
-- one snapshot; anything inactive, revoked, expired or kill-switched resolves
-- to nothing.
create function public.resolve_broker_grant(
  p_tenant_id uuid, p_estate_id uuid, p_connector_id uuid, p_spiffe_id text, p_scope text
) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'grantId', g.id, 'workloadId', w.id, 'agentName', g.agent_name, 'spiffeId', w.spiffe_id,
    'scope', g.internal_scope, 'targetScopes', to_jsonb(g.target_scopes), 'grantExpiresAt', g.expires_at,
    'connectorVersion', c.version, 'credentialId', k.id, 'credentialRevision', k.revision,
    'descriptorSha256', d.content_sha256, 'endpointRef', c.endpoint_ref, 'targetBinding', c.target_binding,
    'grantType', k.grant_type)
  from public.connector_grants g
  join public.workload_identities w on (w.tenant_id, w.id, w.agent_name) = (g.tenant_id, g.workload_identity_id, g.agent_name)
  join public.connectors c on (c.tenant_id, c.id) = (g.tenant_id, g.connector_id)
  join public.estate_systems s on (s.tenant_id, s.id) = (c.tenant_id, c.system_id)
  join public.estates e on (e.tenant_id, e.id) = (s.tenant_id, s.estate_id)
  join public.connector_descriptors d on d.id = c.descriptor_id and d.target_binding = c.target_binding
  join lateral (select k.* from public.connector_credentials k where k.tenant_id = c.tenant_id and k.connector_id = c.id
      and k.revoked_at is null and (k.expires_at is null or k.expires_at > statement_timestamp()) and k.format_version = 1
    order by k.created_at desc limit 1) k on true
  where g.tenant_id = p_tenant_id and e.id = p_estate_id and c.id = p_connector_id and g.internal_scope = p_scope
    and w.spiffe_id = p_spiffe_id and w.status = 'active'
    and g.revoked_at is null and g.expires_at > statement_timestamp()
    and c.status = 'active' and s.status = 'active' and e.status = 'active'
    and not exists (select 1 from public.kill_switch_state ks where ks.engaged
      and (ks.scope = 'global' or ks.tenant_id = p_tenant_id))
  order by g.expires_at desc
  limit 1
$$;

revoke all on function public.issue_connector_grant(uuid,uuid,uuid,uuid,text,text[],integer,uuid) from public, anon, authenticated;
revoke all on function public.resolve_broker_grant(uuid,uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.issue_connector_grant(uuid,uuid,uuid,uuid,text,text[],integer,uuid) to service_role;
grant execute on function public.resolve_broker_grant(uuid,uuid,uuid,text,text) to service_role;
