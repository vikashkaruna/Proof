-- Preserve the existing engagement POST response while retaining atomic audited
-- creation. Published0135 stays byte-for-byte unchanged. The nested function's
-- live membership/internal locks remain held through this same transaction.
alter function public.create_engagement_intake(uuid,uuid,text,uuid,text,text,uuid,uuid)
 set schema controller_security;
alter function controller_security.create_engagement_intake(uuid,uuid,text,uuid,text,text,uuid,uuid)
 rename to create_engagement_intake_before_0136;
revoke all on function controller_security.create_engagement_intake_before_0136(uuid,uuid,text,uuid,text,text,uuid,uuid)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

create function public.create_engagement_intake(
 p_tenant_id uuid,p_actor_id uuid,p_operation_key text,p_request_key uuid,
 p_title text,p_library_version text,p_estate_id uuid,p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;engagement public.engagements;
begin
 result:=controller_security.create_engagement_intake_before_0136(
  p_tenant_id,p_actor_id,p_operation_key,p_request_key,p_title,p_library_version,p_estate_id,p_correlation_id);
 if result ? 'error' then return result;end if;
 select * into engagement from public.engagements
  where tenant_id=p_tenant_id and id=(result->>'id')::uuid for share;
 if engagement.id is null then raise exception 'intake response unavailable' using errcode='23514';end if;
 -- Current saved metadata is truthful on replay, even after a lifecycle change.
 -- Immutable original intent remains in the creation receipt/operation binding.
 return to_jsonb(engagement)||result;
end $$;
revoke all on function public.create_engagement_intake(uuid,uuid,text,uuid,text,text,uuid,uuid)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.create_engagement_intake(uuid,uuid,text,uuid,text,text,uuid,uuid) to human_action_writer;
