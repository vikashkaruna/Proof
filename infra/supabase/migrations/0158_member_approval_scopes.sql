-- 0158: change an existing approver's approval scopes.
--
-- Until now scopes were set only by the invitation (0053) and could not be
-- changed after acceptance; a wrong scope meant removing and re-inviting the
-- person. This adds one audited path. Whoever may invite an approver (founder,
-- owner, admin: invitation_role_grantable) may change an explicit approver's
-- scopes. Empty scopes mean unrestricted, as at invitation. The previous and
-- new scopes are written to the ledger with the change.
alter type public.ledger_action_type add value if not exists 'tenant.member.approval_scopes_changed';

create function public.update_member_approval_scopes(
  p_tenant_id uuid, p_actor_id uuid, p_user_id uuid, p_approval_scopes text[], p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor_role public.user_role; member public.tenant_users; previous text[]; normalized text[];
begin
  select role into actor_role from public.tenant_users
    where tenant_id = p_tenant_id and user_id = p_actor_id and role in ('founder','owner','admin') for share;
  if not found then return jsonb_build_object('error','forbidden'); end if;
  if p_user_id = p_actor_id then return jsonb_build_object('error','self_change'); end if;
  select * into member from public.tenant_users
    where tenant_id = p_tenant_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('error','not_found'); end if;
  if member.role <> 'approver' or member.membership_source <> 'explicit' then
    return jsonb_build_object('error','scopes_require_approver');
  end if;
  if not public.invitation_role_grantable(actor_role, member.role) then
    return jsonb_build_object('error','role_not_grantable');
  end if;
  select coalesce(array_agg(distinct s order by s), '{}') into normalized
    from (select btrim(x) s from unnest(coalesce(p_approval_scopes, '{}')) x) t;
  if cardinality(normalized) > 32 or exists (
       select 1 from unnest(normalized) s where s = '' or char_length(s) > 64) then
    return jsonb_build_object('error','invalid_request');
  end if;
  previous := member.approval_scopes;
  if previous is not distinct from normalized then
    return jsonb_build_object('member', jsonb_build_object(
      'user_id', member.user_id, 'role', member.role, 'approval_scopes', member.approval_scopes),
      'changed', false);
  end if;
  update public.tenant_users set approval_scopes = normalized
    where tenant_id = p_tenant_id and user_id = p_user_id returning * into member;
  perform public.append_ledger(p_tenant_id, p_correlation_id, 'human', p_actor_id::text, null, null, null,
    'tenant.member.approval_scopes_changed', p_user_id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('previous_scopes', previous, 'approval_scopes', normalized));
  return jsonb_build_object('member', jsonb_build_object(
    'user_id', member.user_id, 'role', member.role, 'approval_scopes', member.approval_scopes),
    'changed', true);
end $$;
-- A human decision: only the BFF human action writer (0098), never the
-- generic service key.
revoke all on function public.update_member_approval_scopes(uuid, uuid, uuid, text[], uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.update_member_approval_scopes(uuid, uuid, uuid, text[], uuid)
  to human_action_writer;
