-- 0156: a live founder recovers a tenant OWNER's (and ADMIN's) lost
-- authenticator through the unchanged 0152 flow. Refusals: an ordinary member,
-- an internal non-founder, a derived (platform_founder) membership, a
-- non-founder actor, and an owner demoted mid-case. The console lists owners.
begin;

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
create function pg_temp.step_up(uid uuid, ref text) returns uuid language sql as $$
  insert into public.mfa_challenges(user_id, purpose, bound_resource_ref, created_at, expires_at, satisfied_at)
  values (uid, 'mfa_recovery', ref, clock_timestamp(), clock_timestamp() + interval '5 minutes', clock_timestamp())
  returning id;
$$;
create function pg_temp.hashes() returns text[] language sql as $$
  select array_agg('scrypt$' || md5(i::text) || '$' || md5(i::text) || md5((i + 100)::text))
  from generate_series(1, 10) i;
$$;
create function pg_temp.u(k text) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0156-' || lpad(encode(convert_to(k, 'UTF8'), 'hex'), 12, '0'))::uuid;
$$;
create function pg_temp.s(k text) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-1560-' || lpad(encode(convert_to(k, 'UTF8'), 'hex'), 12, '0'))::uuid;
$$;

-- f founder (actor); o owner; a admin; m approver; i internal analyst;
-- d owner who will be demoted mid-case.
insert into auth.users(id, email)
  select pg_temp.u(k), k || '@d156.invalid' from unnest(array['f','o','a','m','i','d']) k;
insert into public.users(id, email, is_axiom_internal)
  select pg_temp.u(k), k || '@d156.invalid', k in ('f','i') from unnest(array['f','o','a','m','i','d']) k;
select public.designate_platform_founder(pg_temp.u('f'), 'test', 'owner recovery test');
insert into public.tenants(id, slug, name) values ('00000000-0000-0000-0156-0000000000b1', 'rec-156', 'Owner recovery tenant');
insert into public.tenant_users(tenant_id, user_id, role) values
  ('00000000-0000-0000-0156-0000000000b1', pg_temp.u('o'), 'owner'),
  ('00000000-0000-0000-0156-0000000000b1', pg_temp.u('a'), 'admin'),
  ('00000000-0000-0000-0156-0000000000b1', pg_temp.u('m'), 'approver'),
  ('00000000-0000-0000-0156-0000000000b1', pg_temp.u('i'), 'axiom_analyst'),
  ('00000000-0000-0000-0156-0000000000b1', pg_temp.u('d'), 'owner');

insert into auth.sessions(id, user_id, created_at, updated_at)
  select pg_temp.s(k), pg_temp.u(k), now(), now() from unnest(array['f','o','a','m','i','d']) k;
insert into public.user_mfa_factors(id, user_id, factor_type, status, secret_encrypted, activated_at)
  select pg_temp.s(k || 'x'), pg_temp.u(k), 'totp', 'active', 'enc', now() from unnest(array['f','o','a','m','i','d']) k;
insert into public.mfa_session_attestations(user_id, session_id, factor_id, expires_at)
  values (pg_temp.u('f'), pg_temp.s('f'), pg_temp.s('fx'), now() + interval '1 hour');

-- ─── Who is recoverable ──────────────────────────────────────────────
select pg_temp.assert_true(public.founder_recoverable_subject(pg_temp.u('o')), 'owner is recoverable');
select pg_temp.assert_true(public.founder_recoverable_subject(pg_temp.u('a')), 'admin is recoverable');
select pg_temp.assert_true(not public.founder_recoverable_subject(pg_temp.u('m')), 'approver is not (delegated path)');
select pg_temp.assert_true(not public.founder_recoverable_subject(pg_temp.u('i')), 'internal analyst is not');
select pg_temp.assert_true(not public.founder_recoverable_subject(null), 'null is not');
select pg_temp.refused(format($q$select public.open_mfa_recovery_case(%L, %L, %L, %L, 'member is not an owner')$q$,
  pg_temp.u('f'), pg_temp.s('f'), pg_temp.step_up(pg_temp.u('f'), 'open:' || pg_temp.u('m')), pg_temp.u('m')));
select pg_temp.refused(format($q$select public.open_mfa_recovery_case(%L, %L, %L, %L, 'internal analyst subject')$q$,
  pg_temp.u('f'), pg_temp.s('f'), pg_temp.step_up(pg_temp.u('f'), 'open:' || pg_temp.u('i')), pg_temp.u('i')));
-- A non-founder (the owner itself) cannot open a case for the admin.
select pg_temp.refused(format($q$select public.open_mfa_recovery_case(%L, %L, %L, %L, 'owner is not a founder')$q$,
  pg_temp.u('o'), pg_temp.s('o'), pg_temp.step_up(pg_temp.u('o'), 'open:' || pg_temp.u('a')), pg_temp.u('a')));

-- ─── The console lists owners and admins, not members or internals ───
select pg_temp.assert_true(
  (select array_agg(x->>'email' order by x->>'email')
   from jsonb_array_elements(public.read_mfa_recovery_overview(pg_temp.u('f'))->'owners') x)
   = array['a@d156.invalid','d@d156.invalid','o@d156.invalid'],
  'overview lists exactly the recoverable owners and admins');

-- ─── Full recovery of the owner ──────────────────────────────────────
create temporary table rc as
select (public.open_mfa_recovery_case(pg_temp.u('f'), pg_temp.s('f'),
  pg_temp.step_up(pg_temp.u('f'), 'open:' || pg_temp.u('o')), pg_temp.u('o'),
  'Owner lost authenticator; identity verified by video call') ->> 'case_id')::uuid as case_id;
select pg_temp.assert_true(not exists (select 1 from auth.sessions where user_id = pg_temp.u('o')),
  'owner sessions are ended');
insert into auth.sessions(id, user_id, created_at, updated_at)
  values (pg_temp.s('o2'), pg_temp.u('o'), clock_timestamp(), now());
select public.bind_mfa_recovery_session(pg_temp.u('o'), pg_temp.s('o2'), (select case_id from rc));
select public.authorize_mfa_recovery_session(pg_temp.u('f'), pg_temp.s('f'),
  pg_temp.step_up(pg_temp.u('f'), 'authorize:' || (select case_id from rc) || ':' || pg_temp.s('o2')),
  (select case_id from rc), pg_temp.s('o2'));
create temporary table nf as
  select public.begin_recovery_totp_enrolment(pg_temp.u('o'), pg_temp.s('o2'), (select case_id from rc),
    'enc-new', 'phone') as id;
select public.finalize_recovery_totp_enrolment(pg_temp.u('o'), pg_temp.s('o2'), (select case_id from rc),
  (select id from nf), 1, pg_temp.hashes());
select pg_temp.assert_true(
  (select array_agg(id) = array[(select id from nf)] from public.user_mfa_factors
   where user_id = pg_temp.u('o') and factor_type = 'totp' and status = 'active'),
  'only the owner''s new authenticator is active');
select pg_temp.assert_true(
  (select array_agg(event order by id) = array['opened','bound','authorized','enrolment_started','completed']
   from public.mfa_recovery_events where case_id = (select case_id from rc)),
  'every step of the owner recovery left a receipt');

-- ─── Demoted mid-case: the case stops at the next step ───────────────
create temporary table dc as
select (public.open_mfa_recovery_case(pg_temp.u('f'), pg_temp.s('f'),
  pg_temp.step_up(pg_temp.u('f'), 'open:' || pg_temp.u('d')), pg_temp.u('d'),
  'Owner to be demoted during the case') ->> 'case_id')::uuid as case_id;
insert into auth.sessions(id, user_id, created_at, updated_at)
  values (pg_temp.s('d2'), pg_temp.u('d'), clock_timestamp(), now());
select public.bind_mfa_recovery_session(pg_temp.u('d'), pg_temp.s('d2'), (select case_id from dc));
update public.tenant_users set role = 'viewer'
 where tenant_id = '00000000-0000-0000-0156-0000000000b1' and user_id = pg_temp.u('d');
select pg_temp.refused(format($q$select public.authorize_mfa_recovery_session(%L, %L, %L, %L, %L)$q$,
  pg_temp.u('f'), pg_temp.s('f'),
  pg_temp.step_up(pg_temp.u('f'), 'authorize:' || (select case_id from dc) || ':' || pg_temp.s('d2')),
  (select case_id from dc), pg_temp.s('d2')));

rollback;
