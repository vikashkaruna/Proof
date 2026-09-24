-- W1 · SEC-8: replacing an authenticator is one transaction, or it is nothing.
--
-- `user_mfa_factors_one_active_totp` (migration 0012) is UNIQUE on `user_id`
-- WHERE `factor_type = 'totp' AND status = 'active'`. It is right: two live
-- authenticators for one account means a device the user believes they
-- retired still satisfies every step-up.
--
-- But `activateTotpEnrolment` promoted the pending factor with a bare UPDATE
-- and never retired the one being replaced, so activation raised 23505 the
-- moment a user already held a factor. Replacement could not complete at all.
-- The service mapped that unique violation onto `no_pending_factor` — "No
-- enrolment is in progress" — which is a reason that points an operator at
-- the wrong layer entirely, and is why the defect survived: the flow refused
-- cleanly and the refusal read like a control working.
--
-- Doing it in two round trips is not a fix. Either order is a hole:
--
--   · revoke, then activate — a fault between them leaves the account with NO
--     active factor. That is not merely a lockout: a first enrolment is
--     deliberately not step-up gated, so a stolen session that could provoke
--     the fault would then enrol its own device freely. Revocation is the
--     cheaper half of the revoke-then-re-enrol chain the enrolment gate
--     exists to break, and this would hand it over.
--   · activate, then revoke — forbidden by the index, which is the bug.
--
-- So the swap happens here, under one transaction and one set of row locks.
begin;

-- Promote `p_factor_id` to active and retire whatever TOTP factor this user
-- held, together.
--
-- Returns the pair it moved. An empty result means the pending factor was not
-- found for this user — the caller's `no_pending_factor`, now meaning only
-- what it says.
create function public.activate_totp_factor(
  p_user_id uuid,
  p_factor_id uuid,
  p_last_used_counter bigint
) returns table (activated_factor_id uuid, retired_factor_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_pending uuid;
  v_retired uuid;
  v_now timestamptz := now();
begin
  -- Lock this user's TOTP rows before reading them. Two activations racing —
  -- a double submit, or a second tab — would otherwise both see a pending row
  -- and both try to hold the unique index, and the loser's error is
  -- indistinguishable from the bug this migration removes.
  perform 1
  from public.user_mfa_factors
  where user_id = p_user_id
    and factor_type = 'totp'
  for update;

  select id into v_pending
  from public.user_mfa_factors
  where id = p_factor_id
    and user_id = p_user_id          -- never the path parameter alone
    and factor_type = 'totp'
    and status = 'pending';

  if v_pending is null then
    return;                          -- no rows: the caller reports it
  end if;

  -- Retire first. The index permits one active TOTP row per user, so the old
  -- one has to leave before the new one arrives; inside this transaction
  -- there is no moment another session can observe the account factorless.
  update public.user_mfa_factors
     set status = 'revoked',
         revoked_at = v_now
   where user_id = p_user_id
     and factor_type = 'totp'
     and status = 'active'
     and id <> p_factor_id
  returning id into v_retired;

  update public.user_mfa_factors
     set status = 'active',
         activated_at = v_now,
         last_used_counter = p_last_used_counter,
         last_used_at = v_now
   where id = v_pending
     and status = 'pending';         -- re-checked under the lock

  activated_factor_id := v_pending;
  retired_factor_id := v_retired;
  return next;
end;
$$;

-- `security definer` with an empty search_path, so the body cannot be steered
-- by a caller-set path. Execution is the BFF's alone: no client role gets it,
-- because activating a factor is not a thing a browser may ask the database
-- for directly.
revoke all on function public.activate_totp_factor(uuid, uuid, bigint) from public;
revoke all on function public.activate_totp_factor(uuid, uuid, bigint) from anon;
revoke all on function public.activate_totp_factor(uuid, uuid, bigint) from authenticated;
grant execute on function public.activate_totp_factor(uuid, uuid, bigint) to service_role;

comment on function public.activate_totp_factor(uuid, uuid, bigint) is
  'W1 · SEC-8. Activates a pending TOTP factor and retires the one it replaces in a single transaction, which the one-active-TOTP unique index makes impossible to do in two statements from the client.';

commit;
