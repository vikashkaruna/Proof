-- 0152: a live founder recovers a DIFFERENT live founder's lost authenticator.
-- Proves the fence (old sessions dead in RLS and SQL), the bound fresh
-- session, the one-shot grant, atomic credential rotation, append-only
-- receipts, and the refusals: self, non-founder subject/actor, missing MFA,
-- wrong/replayed step-up, wrong session, legacy writers racing the reset.
begin;

-- GoTrue owns auth.sessions in a real stack; this disposable fixture stubs
-- the columns 0152 reads.
create table auth.sessions(id uuid primary key, user_id uuid not null references auth.users(id),
  created_at timestamptz, updated_at timestamptz, not_after timestamptz, user_agent text, ip inet);

create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
create function pg_temp.refused(statement text, code text default '42501') returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate = code then return; end if;
    raise exception 'Statement failed with % (expected %): % — %', sqlstate, code, sqlerrm, statement;
  end;
  raise exception 'Statement was not refused: %', statement;
end $$;
create function pg_temp.as_session(uid uuid, sid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'authenticated', 'session_id', sid)::text, true);
end $$;
-- A satisfied step-up for the actor, bound to ref.
create function pg_temp.step_up(uid uuid, ref text) returns uuid language sql as $$
  insert into public.mfa_challenges(user_id, purpose, bound_resource_ref, created_at, expires_at, satisfied_at)
  values (uid, 'mfa_recovery', ref, clock_timestamp(), clock_timestamp() + interval '5 minutes', clock_timestamp())
  returning id;
$$;
create function pg_temp.hashes() returns text[] language sql as $$
  select array_agg('scrypt$' || md5(i::text) || '$' || md5(i::text) || md5((i + 100)::text))
  from generate_series(1, 10) i;
$$;

-- F1 actor founder, F2 subject founder, F3 founder without a live attestation,
-- AN internal analyst (not a founder).
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000152f1', 'f1@axiomminds.invalid'),
  ('00000000-0000-0000-0000-0000000152f2', 'f2@axiomminds.invalid'),
  ('00000000-0000-0000-0000-0000000152f3', 'f3@axiomminds.invalid'),
  ('00000000-0000-0000-0000-0000000152a1', 'an@axiomminds.invalid');
insert into public.users(id, email, is_axiom_internal) values
  ('00000000-0000-0000-0000-0000000152f1', 'f1@axiomminds.invalid', true),
  ('00000000-0000-0000-0000-0000000152f2', 'f2@axiomminds.invalid', true),
  ('00000000-0000-0000-0000-0000000152f3', 'f3@axiomminds.invalid', true),
  ('00000000-0000-0000-0000-0000000152a1', 'an@axiomminds.invalid', true);
select public.designate_platform_founder(id, 'test', 'recovery test')
  from public.users where id in ('00000000-0000-0000-0000-0000000152f1',
    '00000000-0000-0000-0000-0000000152f2', '00000000-0000-0000-0000-0000000152f3');
insert into public.tenants(id, slug, name) values ('00000000-0000-0000-0000-0000000152b1', 'rec-t', 'Recovery tenant');

insert into auth.sessions(id, user_id, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000000152c1', '00000000-0000-0000-0000-0000000152f1', now(), now()),
  ('00000000-0000-0000-0000-0000000152c2', '00000000-0000-0000-0000-0000000152f2', now(), now()),
  ('00000000-0000-0000-0000-0000000152c3', '00000000-0000-0000-0000-0000000152f3', now(), now()),
  ('00000000-0000-0000-0000-0000000152ca', '00000000-0000-0000-0000-0000000152a1', now(), now());
insert into public.user_mfa_factors(id, user_id, factor_type, status, secret_encrypted, activated_at) values
  ('00000000-0000-0000-0000-0000000152d1', '00000000-0000-0000-0000-0000000152f1', 'totp', 'active', 'enc', now()),
  ('00000000-0000-0000-0000-0000000152d2', '00000000-0000-0000-0000-0000000152f2', 'totp', 'active', 'lost', now()),
  ('00000000-0000-0000-0000-0000000152d3', '00000000-0000-0000-0000-0000000152f3', 'totp', 'active', 'enc', now()),
  ('00000000-0000-0000-0000-0000000152da', '00000000-0000-0000-0000-0000000152a1', 'totp', 'active', 'enc', now());
insert into public.user_mfa_factors(user_id, factor_type, status, code_hash)
  select '00000000-0000-0000-0000-0000000152f2', 'recovery_code', 'active', 'old-' || i from generate_series(1, 3) i;
insert into public.mfa_session_attestations(user_id, session_id, factor_id, expires_at) values
  ('00000000-0000-0000-0000-0000000152f1', '00000000-0000-0000-0000-0000000152c1', '00000000-0000-0000-0000-0000000152d1', now() + interval '1 hour'),
  ('00000000-0000-0000-0000-0000000152f2', '00000000-0000-0000-0000-0000000152c2', '00000000-0000-0000-0000-0000000152d2', now() + interval '1 hour'),
  ('00000000-0000-0000-0000-0000000152a1', '00000000-0000-0000-0000-0000000152ca', '00000000-0000-0000-0000-0000000152da', now() + interval '1 hour');

-- ─── Refusals before any case exists ─────────────────────────────────
select pg_temp.refused(format($q$select public.open_mfa_recovery_case(%L, %L, %L, %L, 'lost my own phone today')$q$,
  '00000000-0000-0000-0000-0000000152f1', '00000000-0000-0000-0000-0000000152c1',
  pg_temp.step_up('00000000-0000-0000-0000-0000000152f1', 'open:00000000-0000-0000-0000-0000000152f1'),
  '00000000-0000-0000-0000-0000000152f1'));
select pg_temp.refused(format($q$select public.open_mfa_recovery_case(%L, %L, %L, %L, 'analyst is not a founder')$q$,
  '00000000-0000-0000-0000-0000000152f1', '00000000-0000-0000-0000-0000000152c1',
  pg_temp.step_up('00000000-0000-0000-0000-0000000152f1', 'open:00000000-0000-0000-0000-0000000152a1'),
  '00000000-0000-0000-0000-0000000152a1'));
select pg_temp.refused(format($q$select public.open_mfa_recovery_case(%L, %L, %L, %L, 'internal analyst as actor')$q$,
  '00000000-0000-0000-0000-0000000152a1', '00000000-0000-0000-0000-0000000152ca',
  pg_temp.step_up('00000000-0000-0000-0000-0000000152a1', 'open:00000000-0000-0000-0000-0000000152f2'),
  '00000000-0000-0000-0000-0000000152f2'));
select pg_temp.refused(format($q$select public.open_mfa_recovery_case(%L, %L, %L, %L, 'actor without attestation')$q$,
  '00000000-0000-0000-0000-0000000152f3', '00000000-0000-0000-0000-0000000152c3',
  pg_temp.step_up('00000000-0000-0000-0000-0000000152f3', 'open:00000000-0000-0000-0000-0000000152f2'),
  '00000000-0000-0000-0000-0000000152f2'));
select pg_temp.refused(format($q$select public.open_mfa_recovery_case(%L, %L, %L, %L, 'step-up bound elsewhere')$q$,
  '00000000-0000-0000-0000-0000000152f1', '00000000-0000-0000-0000-0000000152c1',
  pg_temp.step_up('00000000-0000-0000-0000-0000000152f1', 'open:00000000-0000-0000-0000-0000000152f3'),
  '00000000-0000-0000-0000-0000000152f2'));
-- Not callable by a signed-in user directly.
set local role authenticated;
select pg_temp.as_session('00000000-0000-0000-0000-0000000152f1', '00000000-0000-0000-0000-0000000152c1');
select pg_temp.refused($q$select public.open_mfa_recovery_case(null, null, null, null, null)$q$);
reset role;

-- ─── Open ────────────────────────────────────────────────────────────
create temporary table rc as
select (public.open_mfa_recovery_case(
  '00000000-0000-0000-0000-0000000152f1', '00000000-0000-0000-0000-0000000152c1',
  pg_temp.step_up('00000000-0000-0000-0000-0000000152f1', 'open:00000000-0000-0000-0000-0000000152f2'),
  '00000000-0000-0000-0000-0000000152f2', 'Lost authenticator; identity verified by video call')
  ->> 'case_id')::uuid as case_id;

select pg_temp.assert_true(
  not exists (select 1 from auth.sessions where user_id = '00000000-0000-0000-0000-0000000152f2'),
  'subject GoTrue sessions are deleted');
select pg_temp.assert_true(
  not exists (select 1 from public.mfa_session_attestations
              where user_id = '00000000-0000-0000-0000-0000000152f2' and revoked_at is null),
  'subject attestations are revoked');
select pg_temp.refused(format($q$select public.open_mfa_recovery_case(%L, %L, %L, %L, 'second case while open')$q$,
  '00000000-0000-0000-0000-0000000152f1', '00000000-0000-0000-0000-0000000152c1',
  pg_temp.step_up('00000000-0000-0000-0000-0000000152f1', 'open:00000000-0000-0000-0000-0000000152f2'),
  '00000000-0000-0000-0000-0000000152f2'), 'PT409');

-- A JWT from before the cutoff is dead in RLS even though GoTrue would still
-- sign it until expiry.
set local role authenticated;
select pg_temp.as_session('00000000-0000-0000-0000-0000000152f2', '00000000-0000-0000-0000-0000000152c2');
select pg_temp.assert_true((select count(*) = 0 from public.tenants where slug = 'rec-t'),
  'pre-cutoff session reads no tenant');
select pg_temp.assert_true((select count(*) = 0 from public.user_mfa_factors),
  'pre-cutoff session reads no factor');
select pg_temp.assert_true((select count(*) = 0 from public.users),
  'pre-cutoff session reads no profile');
reset role;

-- Legacy writers cannot race the reset.
select pg_temp.refused($q$insert into public.user_mfa_factors(user_id, factor_type, status, secret_encrypted)
  values ('00000000-0000-0000-0000-0000000152f2', 'totp', 'pending', 'attacker')$q$);
select pg_temp.refused($q$update public.user_mfa_factors set consumed_at = now()
  where user_id = '00000000-0000-0000-0000-0000000152f2' and factor_type = 'recovery_code'$q$);
select pg_temp.refused($q$insert into public.mfa_challenges(user_id, purpose, expires_at)
  values ('00000000-0000-0000-0000-0000000152f2', 'login', now() + interval '1 minute')$q$);
select pg_temp.refused($q$select public.revoke_totp_factor('00000000-0000-0000-0000-0000000152f2', '00000000-0000-0000-0000-0000000152d2')$q$);

-- ─── Bind ────────────────────────────────────────────────────────────
insert into auth.sessions(id, user_id, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000000152e0', '00000000-0000-0000-0000-0000000152f2',
   (select cutoff_at - interval '1 second' from public.mfa_recovery_cases where id = (select case_id from rc)), now()),
  ('00000000-0000-0000-0000-0000000152e1', '00000000-0000-0000-0000-0000000152f2', clock_timestamp(), now()),
  ('00000000-0000-0000-0000-0000000152e2', '00000000-0000-0000-0000-0000000152f2', clock_timestamp(), now());
select pg_temp.refused(format($q$select public.bind_mfa_recovery_session(%L, %L, %L)$q$,
  '00000000-0000-0000-0000-0000000152f2', '00000000-0000-0000-0000-0000000152e0', (select case_id from rc)));
select pg_temp.refused(format($q$select public.bind_mfa_recovery_session(%L, %L, %L)$q$,
  '00000000-0000-0000-0000-0000000152f3', '00000000-0000-0000-0000-0000000152c3', (select case_id from rc)));
select public.bind_mfa_recovery_session('00000000-0000-0000-0000-0000000152f2',
  '00000000-0000-0000-0000-0000000152e1', (select case_id from rc));

-- Binding alone grants nothing.
select pg_temp.refused(format($q$select public.begin_recovery_totp_enrolment(%L, %L, %L, 'enc-new', 'phone')$q$,
  '00000000-0000-0000-0000-0000000152f2', '00000000-0000-0000-0000-0000000152e1', (select case_id from rc)));

-- ─── Authorize ───────────────────────────────────────────────────────
-- Wrong session (not the bound one), wrong step-up binding, other founder.
select pg_temp.refused(format($q$select public.authorize_mfa_recovery_session(%L, %L, %L, %L, %L)$q$,
  '00000000-0000-0000-0000-0000000152f1', '00000000-0000-0000-0000-0000000152c1',
  pg_temp.step_up('00000000-0000-0000-0000-0000000152f1',
    'authorize:' || (select case_id from rc) || ':00000000-0000-0000-0000-0000000152e2'),
  (select case_id from rc), '00000000-0000-0000-0000-0000000152e2'));
select pg_temp.refused(format($q$select public.authorize_mfa_recovery_session(%L, %L, %L, %L, %L)$q$,
  '00000000-0000-0000-0000-0000000152f1', '00000000-0000-0000-0000-0000000152c1',
  pg_temp.step_up('00000000-0000-0000-0000-0000000152f1', 'open:00000000-0000-0000-0000-0000000152f2'),
  (select case_id from rc), '00000000-0000-0000-0000-0000000152e1'));
select pg_temp.refused(format($q$select public.authorize_mfa_recovery_session(%L, %L, %L, %L, %L)$q$,
  '00000000-0000-0000-0000-0000000152f3', '00000000-0000-0000-0000-0000000152c3',
  pg_temp.step_up('00000000-0000-0000-0000-0000000152f3',
    'authorize:' || (select case_id from rc) || ':00000000-0000-0000-0000-0000000152e1'),
  (select case_id from rc), '00000000-0000-0000-0000-0000000152e1'));
create temporary table auth_challenge as
  select pg_temp.step_up('00000000-0000-0000-0000-0000000152f1',
    'authorize:' || (select case_id from rc) || ':00000000-0000-0000-0000-0000000152e1') as id;
select public.authorize_mfa_recovery_session('00000000-0000-0000-0000-0000000152f1',
  '00000000-0000-0000-0000-0000000152c1', (select id from auth_challenge),
  (select case_id from rc), '00000000-0000-0000-0000-0000000152e1');
-- The same step-up cannot be spent twice.
select pg_temp.refused(format($q$select public.authorize_mfa_recovery_session(%L, %L, %L, %L, %L)$q$,
  '00000000-0000-0000-0000-0000000152f1', '00000000-0000-0000-0000-0000000152c1',
  (select id from auth_challenge), (select case_id from rc), '00000000-0000-0000-0000-0000000152e1'));

-- ─── Enrol ───────────────────────────────────────────────────────────
select pg_temp.refused(format($q$select public.begin_recovery_totp_enrolment(%L, %L, %L, 'enc-new', 'phone')$q$,
  '00000000-0000-0000-0000-0000000152f2', '00000000-0000-0000-0000-0000000152e2', (select case_id from rc)));
create temporary table nf as
  select public.begin_recovery_totp_enrolment('00000000-0000-0000-0000-0000000152f2',
    '00000000-0000-0000-0000-0000000152e1', (select case_id from rc), 'enc-new', 'phone') as id;
select pg_temp.refused(format($q$select public.finalize_recovery_totp_enrolment(%L, %L, %L, %L, 1, %L)$q$,
  '00000000-0000-0000-0000-0000000152f2', '00000000-0000-0000-0000-0000000152e1', (select case_id from rc),
  '00000000-0000-0000-0000-0000000152d2', pg_temp.hashes()));
select pg_temp.refused(format($q$select public.finalize_recovery_totp_enrolment(%L, %L, %L, %L, 1, %L)$q$,
  '00000000-0000-0000-0000-0000000152f2', '00000000-0000-0000-0000-0000000152e1', (select case_id from rc),
  (select id from nf), array['x']), '23514');
select public.finalize_recovery_totp_enrolment('00000000-0000-0000-0000-0000000152f2',
  '00000000-0000-0000-0000-0000000152e1', (select case_id from rc), (select id from nf), 1, pg_temp.hashes());

select pg_temp.assert_true(
  (select array_agg(id) = array[(select id from nf)] from public.user_mfa_factors
   where user_id = '00000000-0000-0000-0000-0000000152f2' and factor_type = 'totp' and status = 'active'),
  'only the newly enrolled authenticator is active');
select pg_temp.assert_true(
  (select count(*) = 10 from public.user_mfa_factors
   where user_id = '00000000-0000-0000-0000-0000000152f2' and factor_type = 'recovery_code' and status = 'active'),
  'exactly ten new recovery codes are active');
select pg_temp.assert_true(
  (select count(*) = 3 from public.user_mfa_factors
   where user_id = '00000000-0000-0000-0000-0000000152f2' and code_hash like 'old-%' and status = 'revoked'),
  'old recovery codes are retired, not deleted');
select pg_temp.assert_true(
  (select array_agg(event order by id) = array['opened','bound','authorized','enrolment_started','completed']
   from public.mfa_recovery_events where case_id = (select case_id from rc)),
  'every step left a receipt');
select pg_temp.refused($q$update public.mfa_recovery_events set detail = '{}'$q$);
select pg_temp.refused($q$delete from public.mfa_recovery_events$q$);

-- One-shot: nothing more can be done with the completed case.
select pg_temp.refused(format($q$select public.begin_recovery_totp_enrolment(%L, %L, %L, 'again', 'phone')$q$,
  '00000000-0000-0000-0000-0000000152f2', '00000000-0000-0000-0000-0000000152e1', (select case_id from rc)));

-- After completion: the fresh session works, the old one stays dead, and
-- ordinary MFA writes resume (a fresh login attestation on the new factor).
insert into public.mfa_session_attestations(user_id, session_id, factor_id, expires_at)
  values ('00000000-0000-0000-0000-0000000152f2', '00000000-0000-0000-0000-0000000152e1',
          (select id from nf), now() + interval '1 hour');
select pg_temp.refused($q$insert into public.mfa_session_attestations(user_id, session_id, factor_id, expires_at)
  values ('00000000-0000-0000-0000-0000000152f2', '00000000-0000-0000-0000-0000000152c2',
          (select id from nf), now() + interval '1 hour')$q$);
set local role authenticated;
select pg_temp.as_session('00000000-0000-0000-0000-0000000152f2', '00000000-0000-0000-0000-0000000152e1');
select pg_temp.assert_true((select count(*) = 1 from public.tenants where slug = 'rec-t'),
  'the recovered founder reads their tenants on the fresh session');
select pg_temp.as_session('00000000-0000-0000-0000-0000000152f2', '00000000-0000-0000-0000-0000000152c2');
select pg_temp.assert_true((select count(*) = 0 from public.tenants where slug = 'rec-t'),
  'the pre-cutoff session stays dead after completion');
-- Unfenced users are unaffected.
select pg_temp.as_session('00000000-0000-0000-0000-0000000152f1', '00000000-0000-0000-0000-0000000152c1');
select pg_temp.assert_true((select count(*) = 1 from public.tenants where slug = 'rec-t'),
  'an unfenced founder is unaffected');
reset role;

select pg_temp.assert_true(
  (select (public.read_mfa_session_access('00000000-0000-0000-0000-0000000152f2',
     '00000000-0000-0000-0000-0000000152c2') ->> 'session_current')::boolean = false),
  'BFF access read reports the old session superseded');

-- A spent step-up cannot open another case, even once the first is cancelled
-- and nothing else stands in the way.
create temporary table reuse as
  select pg_temp.step_up('00000000-0000-0000-0000-0000000152f1', 'open:00000000-0000-0000-0000-0000000152f3') as id;
create temporary table rc3 as
select (public.open_mfa_recovery_case('00000000-0000-0000-0000-0000000152f1',
  '00000000-0000-0000-0000-0000000152c1', (select id from reuse),
  '00000000-0000-0000-0000-0000000152f3', 'Second founder lost phone too') ->> 'case_id')::uuid as case_id;
select public.cancel_mfa_recovery_case('00000000-0000-0000-0000-0000000152f1',
  '00000000-0000-0000-0000-0000000152c1', (select case_id from rc3));
select pg_temp.refused(format($q$select public.open_mfa_recovery_case(%L, %L, %L, %L, 'replayed step-up here')$q$,
  '00000000-0000-0000-0000-0000000152f1', '00000000-0000-0000-0000-0000000152c1',
  (select id from reuse), '00000000-0000-0000-0000-0000000152f3'));
select pg_temp.assert_true(
  (select array_agg(event order by id) = array['opened','cancelled']
   from public.mfa_recovery_events where case_id = (select case_id from rc3)),
  'cancellation left a receipt');

rollback;
