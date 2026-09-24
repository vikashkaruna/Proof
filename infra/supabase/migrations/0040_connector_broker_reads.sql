-- W4.2 internal credential reads. No workload auth or grant authority is created.
alter type public.ledger_action_type add value if not exists 'connector.token_requested';
alter type public.ledger_action_type add value if not exists 'connector.token_acquired';
alter type public.ledger_action_type add value if not exists 'connector.token_denied';

-- Called only after the broker's trusted authority adapter has authenticated
-- workload identity and resolved live grants. Never expose this RPC to browsers
-- or agents. It rechecks credential/configuration state in one MVCC snapshot.
create function public.read_broker_credential(
 p_tenant_id uuid, p_estate_id uuid, p_connector_id uuid, p_credential_id uuid,
 p_connector_version integer, p_credential_revision integer,
 p_descriptor_sha256 text, p_endpoint_ref text, p_target_binding text, p_grant_type text
) returns jsonb language sql stable security definer set search_path='' as $$
 select to_jsonb(k) from public.connector_credentials k
 join public.connectors c on c.tenant_id=k.tenant_id and c.id=k.connector_id
 join public.estate_systems s on s.tenant_id=c.tenant_id and s.id=c.system_id
 join public.estates e on e.tenant_id=s.tenant_id and e.id=s.estate_id
 join public.connector_descriptors d on d.id=c.descriptor_id and d.target_binding=c.target_binding
 where k.tenant_id=p_tenant_id and e.id=p_estate_id and c.id=p_connector_id and k.id=p_credential_id
 and e.status='active' and s.status='active' and c.status='active'
 and c.version=p_connector_version and k.revision=p_credential_revision
 and k.format_version=1 and k.revoked_at is null and (k.expires_at is null or k.expires_at>statement_timestamp())
 and k.descriptor_sha256=d.content_sha256 and d.content_sha256=p_descriptor_sha256
 and k.endpoint_ref=c.endpoint_ref and c.endpoint_ref=p_endpoint_ref
 and k.target_binding=c.target_binding and c.target_binding=p_target_binding
 and k.grant_type=p_grant_type and d.manifest->>'auth'='oauth2.'||p_grant_type
$$;
revoke all on function public.read_broker_credential(uuid,uuid,uuid,uuid,integer,integer,text,text,text,text) from public,anon,authenticated;
grant execute on function public.read_broker_credential(uuid,uuid,uuid,uuid,integer,integer,text,text,text,text) to service_role;
