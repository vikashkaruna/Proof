-- W4.5 internal tool registry (perimeter-scoped). Every tool is classified
-- read or write at registration (0033's check makes classification
-- mandatory), its description is hash-pinned by the database, and a new
-- version is a new row. Registration authorizes nothing by itself: using a
-- tool still needs a live W4.4 grant whose scope matches the tool's class.
alter type public.ledger_action_type add value if not exists 'connector.tool.registered';

create function public.register_connector_tool(
  p_tenant_id uuid, p_actor_id uuid, p_connector_id uuid, p_tool_name text, p_tool_version text,
  p_operation_class text, p_description text, p_input_schema jsonb, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.connectors; t public.mcp_tool_registry;
begin
  perform 1 from public.tenant_users where tenant_id = p_tenant_id and user_id = p_actor_id
    and role in ('founder','owner','admin') for share;
  if not found then return jsonb_build_object('error','forbidden'); end if;
  if p_operation_class is null or p_operation_class not in ('read','write') then
    return jsonb_build_object('error','classification_required');
  end if;
  if coalesce(p_tool_name, '') !~ '^[a-z][a-z0-9_.-]{0,99}$' or coalesce(p_tool_version, '') !~ '^[A-Za-z0-9._-]{1,80}$'
     or char_length(btrim(coalesce(p_description, ''))) not between 1 and 4000
     or jsonb_typeof(p_input_schema) is distinct from 'object' or p_input_schema->>'type' is distinct from 'object'
     or octet_length(p_input_schema::text) > 16384 then
    return jsonb_build_object('error','invalid_request');
  end if;
  select * into c from public.connectors where tenant_id = p_tenant_id and id = p_connector_id for share;
  if not found then return jsonb_build_object('error','not_found'); end if;
  if c.status = 'archived' then return jsonb_build_object('error','connector_archived'); end if;
  -- Reference and sandbox bindings cannot declare writes (same rule as grants).
  if p_operation_class = 'write' and c.target_binding <> 'production' then
    return jsonb_build_object('error','write_requires_production');
  end if;
  if exists (select 1 from public.mcp_tool_registry where tenant_id = p_tenant_id and connector_id = c.id
      and tool_name = p_tool_name and tool_version = p_tool_version) then
    return jsonb_build_object('error','version_exists');
  end if;
  insert into public.mcp_tool_registry(tenant_id, connector_id, tool_name, tool_version, operation_class, description, input_schema)
    values (p_tenant_id, c.id, p_tool_name, p_tool_version, p_operation_class, p_description, p_input_schema)
    returning * into t;
  perform public.append_ledger(p_tenant_id, p_correlation_id, 'human', p_actor_id::text, null, null, null,
    'connector.tool.registered', t.id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('connector_id', c.id, 'tool_name', t.tool_name, 'tool_version', t.tool_version,
      'operation_class', t.operation_class, 'description_sha256', t.description_sha256));
  return jsonb_build_object('tool', to_jsonb(t));
end $$;

-- Session re-verification: the observed description must hash to the pinned
-- value. A mismatch (tool poisoning, silent upstream change) resolves nothing.
create function public.verify_connector_tool(
  p_tenant_id uuid, p_connector_id uuid, p_tool_name text, p_tool_version text, p_description_sha256 text
) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', t.id, 'operationClass', t.operation_class, 'inputSchema', t.input_schema,
    'descriptionSha256', t.description_sha256)
  from public.mcp_tool_registry t
  join public.connectors c on (c.tenant_id, c.id) = (t.tenant_id, t.connector_id)
  where t.tenant_id = p_tenant_id and t.connector_id = p_connector_id and t.tool_name = p_tool_name
    and t.tool_version = p_tool_version and t.description_sha256 = p_description_sha256
    and c.status = 'active'
$$;

revoke all on function public.register_connector_tool(uuid,uuid,uuid,text,text,text,text,jsonb,uuid) from public, anon, authenticated;
revoke all on function public.verify_connector_tool(uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.register_connector_tool(uuid,uuid,uuid,text,text,text,text,jsonb,uuid) to service_role;
grant execute on function public.verify_connector_tool(uuid,uuid,text,text,text) to service_role;
