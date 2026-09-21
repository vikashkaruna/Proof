-- W1 · SEC-8 (migration 0030): swapping an authenticator is one transaction.
--
-- The defect these assertions exist for: `user_mfa_factors_one_active_totp`
-- permits one active TOTP row per user, and the activation path promoted the
-- pending row without retiring the one it replaced. Every replacement failed
-- with 23505, which the service reported as `no_pending_factor`.
--
-- The first assertion below deliberately proves the INDEX still bites. If a
-- later migration dropped it, `activate_totp_factor` would keep passing its
-- own tests while two live authenticators quietly became possible — and the
-- user who "replaced" a lost phone would still be protected by the phone they
-- lost.
begin;

create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
create function pg_temp.denied(statement text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when insufficient_privilege then return; end;
  raise exception 'Statement was not denied: %', statement;
end $$;

insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000f1', 'replacer@test.invalid'),
  ('00000000-0000-0000-0000-0000000000f2', 'bystander@test.invalid');
insert into public.users(id, email) values
  ('00000000-0000-0000-0000-0000000000f1', 'replacer@test.invalid'),
  ('00000000-0000-0000-0000-0000000000f2', 'bystander@test.invalid');

insert into public.user_mfa_factors(id, user_id, factor_type, status, secret_encrypted, activated_at)
values ('00000000-0000-0000-0000-00000000e001',
        '00000000-0000-0000-0000-0000000000f1', 'totp', 'active', 'v2$old', now());
insert into public.user_mfa_factors(id, user_id, factor_type, status, secret_encrypted)
values ('00000000-0000-0000-0000-00000000e002',
        '00000000-0000-0000-0000-0000000000f1', 'totp', 'pending', 'v2$new');

-- ─── The constraint that made a two-statement replacement impossible ───────

do $$
begin
  begin
    update public.user_mfa_factors set status = 'active'
     where id = '00000000-0000-0000-0000-00000000e002';
    raise exception 'ASSERTION FAILED: a second active TOTP factor was permitted';
  exception when unique_violation then null;
  end;
end $$;

-- ─── The function does what two statements cannot ─────────────────────────

select pg_temp.assert_true(
  (select retired_factor_id from public.activate_totp_factor(
     '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000e002', 42))
   = '00000000-0000-0000-0000-00000000e001',
  'the replaced factor is reported as retired');

select pg_temp.assert_true(
  (select status = 'active' and last_used_counter = 42 and activated_at is not null
     from public.user_mfa_factors where id = '00000000-0000-0000-0000-00000000e002'),
  'the replacement is active and its counter is burned');

-- Burning the counter matters on its own: without it the six-digit code used
-- to enrol is replayable as a login for the rest of its 30-second step.
select pg_temp.assert_true(
  (select status = 'revoked' and revoked_at is not null
     from public.user_mfa_factors where id = '00000000-0000-0000-0000-00000000e001'),
  'the replaced factor is revoked, not merely left behind');

select pg_temp.assert_true(
  (select count(*) = 1 from public.user_mfa_factors
    where user_id = '00000000-0000-0000-0000-0000000000f1'
      and factor_type = 'totp' and status = 'active'),
  'exactly one active TOTP factor survives the swap');

-- ─── Refusals ─────────────────────────────────────────────────────────────

select pg_temp.assert_true(
  not exists (select 1 from public.activate_totp_factor(
    '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000e002', 1)),
  'an already-active factor is not re-activated');

insert into public.user_mfa_factors(id, user_id, factor_type, status, secret_encrypted)
values ('00000000-0000-0000-0000-00000000e003',
        '00000000-0000-0000-0000-0000000000f2', 'totp', 'pending', 'v2$other');

-- The user id is not decoration. A function that trusted the factor id alone
-- would let any caller activate — and thereby retire — someone else's factor.
select pg_temp.assert_true(
  not exists (select 1 from public.activate_totp_factor(
    '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000e003', 1)),
  'a factor belonging to another user is not activated');

select pg_temp.assert_true(
  (select status = 'pending' from public.user_mfa_factors
    where id = '00000000-0000-0000-0000-00000000e003'),
  'the other user''s factor is untouched');

-- ─── Not reachable from a browser ─────────────────────────────────────────

set local role authenticated;
select pg_temp.denied($$select public.activate_totp_factor(
  '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000e003', 1)$$);
reset role;

rollback;
