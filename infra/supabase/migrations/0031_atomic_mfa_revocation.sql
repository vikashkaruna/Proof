-- Revocation must not report success with a live MFA session or recovery set.
-- All effects roll back together; a login racing revocation is serialized on
-- the same TOTP row by the attestation insert guard below.
begin;

create function public.revoke_totp_factor(p_user_id uuid, p_factor_id uuid)
returns table (revoked_factor_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform 1 from public.user_mfa_factors
    where user_id = p_user_id and factor_type = 'totp' order by id for update;
  if not exists (select 1 from public.user_mfa_factors
    where id = p_factor_id and user_id = p_user_id
      and factor_type = 'totp' and status = 'active') then
    return;
  end if;

  -- A pending replacement and unused recovery codes must not survive removal
  -- of the credential they were meant to replace/recover.
  update public.user_mfa_factors set status = 'revoked', revoked_at = now()
    where user_id = p_user_id and status <> 'revoked';
  update public.mfa_session_attestations set revoked_at = now()
    where user_id = p_user_id and revoked_at is null;
  return query select p_factor_id;
end;
$$;
revoke all on function public.revoke_totp_factor(uuid, uuid) from public, anon, authenticated;
grant execute on function public.revoke_totp_factor(uuid, uuid) to service_role;

create function public.guard_mfa_session_factor()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Login challenges record the TOTP factor, including when satisfied using
  -- a recovery code. Never issue fresh assurance against a retired device.
  perform 1 from public.user_mfa_factors
    where id = new.factor_id and user_id = new.user_id
      and factor_type = 'totp' and status = 'active' for update;
  if not found then
    raise exception 'MFA session requires an active factor belonging to its user' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_mfa_session_factor() from public, anon, authenticated;
create trigger mfa_session_active_factor before insert on public.mfa_session_attestations
  for each row execute function public.guard_mfa_session_factor();

commit;
