-- ─────────────────────────────────────────────────────────────────────
-- 0153_mfa_recovery_self_read.sql
--
-- The web app must route a signed-in subject of an open recovery case to the
-- recovery panel instead of the code prompt (their lost factor cannot satisfy
-- it). They may read their OWN open case through their own JWT; nothing about
-- the actor, the reason or other accounts is disclosed. A pre-cutoff session
-- reads nothing, consistent with every other fenced read.
-- ─────────────────────────────────────────────────────────────────────

create function public.read_my_mfa_recovery() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_session uuid := public.jwt_session_id();
begin
  if v_uid is null or not public.session_is_current() then
    return null;
  end if;
  return (
    select jsonb_build_object('case_id', c.id, 'state', c.state,
      'bound_here', c.beneficiary_session_id is not distinct from v_session,
      'session_id', v_session,
      'grant_expires_at', c.grant_expires_at, 'expires_at', c.expires_at)
    from public.mfa_recovery_cases c
    where c.subject_user_id = v_uid and c.state not in ('completed', 'cancelled')
  );
end;
$$;

revoke all on function public.read_my_mfa_recovery() from public, anon, service_role;
grant execute on function public.read_my_mfa_recovery() to authenticated;
