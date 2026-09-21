-- Accepted W1 E.2.3: recovery-based replacement requires MFA again.
-- Append-only migration; existing credentials/attestations are not rewritten.
begin;
alter table public.mfa_challenges add column satisfied_with text
  check (satisfied_with in ('totp', 'recovery_code'));
alter table public.user_mfa_factors
  add column replaces_factor_id uuid references public.user_mfa_factors(id),
  add column replacement_challenge_id uuid unique references public.mfa_challenges(id);

create or replace function public.finalize_totp_enrolment(
  p_user_id uuid, p_factor_id uuid, p_last_used_counter bigint, p_recovery_hashes text[]
) returns table (activated_factor_id uuid, retired_factor_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_swap record;
  v_pending public.user_mfa_factors%rowtype;
  v_active uuid;
  v_method text;
begin
  if p_recovery_hashes is null or cardinality(p_recovery_hashes) <> 10
     or (select count(distinct h) from unnest(p_recovery_hashes) h) <> 10
     or exists(select 1 from unnest(p_recovery_hashes) h
       where h is null or h !~ '^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$') then
    raise exception 'ten distinct recovery hashes required' using errcode = '23514';
  end if;
  -- Serialize completions for this account, including concurrent attempts
  -- against distinct pending factors. No raw recovery codes cross this RPC.
  -- NO KEY UPDATE serializes activation without blocking the FK key-share
  -- check of an attestation that already holds its factor lock.
  perform 1 from public.users where id = p_user_id for no key update;
  -- Same row lock used by the attestation insert guard and factor revocation.
  perform 1 from public.user_mfa_factors
    where user_id = p_user_id and factor_type = 'totp' order by id for update;
  select * into v_pending from public.user_mfa_factors
    where id = p_factor_id and user_id = p_user_id
      and factor_type = 'totp' and status = 'pending';
  if not found then return; end if;
  select id into v_active from public.user_mfa_factors
    where user_id = p_user_id and factor_type = 'totp' and status = 'active';

  if v_active is null then
    if v_pending.replaces_factor_id is not null or v_pending.replacement_challenge_id is not null then
      raise exception 'MFA replacement authorization changed; restart enrollment' using errcode = 'PT409';
    end if;
  else
    -- Provenance comes from the BFF's verified, consumed challenge, never a
    -- client-supplied flag. Legacy pending replacements must restart safely.
    select satisfied_with into v_method from public.mfa_challenges
      where id = v_pending.replacement_challenge_id and user_id = p_user_id
        and purpose = 'enrolment' and factor_id = v_active
        and bound_resource_ref = v_active::text
        and satisfied_at is not null and consumed_at is not null
        and consumed_at <= expires_at and satisfied_at <= consumed_at
        and satisfied_with in ('totp', 'recovery_code');
    if v_pending.replaces_factor_id is distinct from v_active or v_method is null then
      raise exception 'MFA replacement authorization changed; restart enrollment' using errcode = 'PT409';
    end if;
  end if;

  select * into v_swap from public.activate_totp_factor(p_user_id, p_factor_id, p_last_used_counter);
  if not found then return; end if;

  -- Retire rather than delete: preserve historical challenge references.
  update public.user_mfa_factors set status = 'revoked', revoked_at = now()
    where user_id = p_user_id and factor_type = 'recovery_code' and status <> 'revoked';
  insert into public.user_mfa_factors(user_id,factor_type,status,code_hash)
    select p_user_id, 'recovery_code', 'active', h from unnest(p_recovery_hashes) h;

  if v_method = 'recovery_code' then
    -- Recovery establishes new trust for the account. Include attestations
    -- grandfathered by an earlier TOTP-authorized replacement, otherwise a
    -- still-live older session could bypass the accepted re-verification rule.
    update public.mfa_session_attestations set revoked_at = now()
      where user_id = p_user_id and revoked_at is null;
  end if;

  activated_factor_id := v_swap.activated_factor_id;
  retired_factor_id := v_swap.retired_factor_id;
  return next;
end;
$$;
revoke all on function public.finalize_totp_enrolment(uuid,uuid,bigint,text[]) from public, anon, authenticated;
grant execute on function public.finalize_totp_enrolment(uuid,uuid,bigint,text[]) to service_role;

commit;
