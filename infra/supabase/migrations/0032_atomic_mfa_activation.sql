-- Complete enrollment is a factor swap AND a new recovery set. A failure in
-- either half must leave the old authenticator and its recovery set usable.
begin;

create function public.finalize_totp_enrolment(
  p_user_id uuid, p_factor_id uuid, p_last_used_counter bigint, p_recovery_hashes text[]
) returns table (activated_factor_id uuid, retired_factor_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_swap record;
begin
  if p_recovery_hashes is null or cardinality(p_recovery_hashes) <> 10
     or (select count(distinct h) from unnest(p_recovery_hashes) h) <> 10
     or exists(select 1 from unnest(p_recovery_hashes) h
       where h is null or h !~ '^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$') then
    raise exception 'ten distinct recovery hashes required' using errcode = '23514';
  end if;
  -- Serialize completions for this account, including concurrent attempts
  -- against distinct pending factors. No raw recovery codes cross this RPC.
  perform 1 from public.users where id = p_user_id for update;
  select * into v_swap from public.activate_totp_factor(p_user_id, p_factor_id, p_last_used_counter);
  if not found then return; end if;

  -- Retire rather than delete: preserve historical challenge references.
  update public.user_mfa_factors set status = 'revoked', revoked_at = now()
    where user_id = p_user_id and factor_type = 'recovery_code' and status <> 'revoked';
  insert into public.user_mfa_factors(user_id,factor_type,status,code_hash)
    select p_user_id, 'recovery_code', 'active', h from unnest(p_recovery_hashes) h;

  activated_factor_id := v_swap.activated_factor_id;
  retired_factor_id := v_swap.retired_factor_id;
  return next;
end;
$$;
revoke all on function public.finalize_totp_enrolment(uuid,uuid,bigint,text[]) from public, anon, authenticated;
grant execute on function public.finalize_totp_enrolment(uuid,uuid,bigint,text[]) to service_role;
-- Keep the original primitive for the wrapper, but no BFF may bypass the
-- recovery transaction. Old application versions fail closed until upgraded.
revoke all on function public.activate_totp_factor(uuid,uuid,bigint) from service_role;

commit;
