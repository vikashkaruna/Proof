-- 0154: scoped owner delegation of MFA recovery. A founder delegates to an
-- explicit owner for one tenant and named ordinary roles; the owner recovers
-- only an ordinary member wholly inside that tenant. Refusals: non-founder
-- issuer, non-owner delegate, privileged/target roles, multi-tenant, internal,
-- founder, peer owner, self, revoked/expired/changed delegation, and
-- membership changes racing the case.
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
-- uuid helper: role letter → fixed id
create function pg_temp.u(k text) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0154-' || lpad(encode(convert_to(k, 'UTF8'), 'hex'), 12, '0'))::uuid;
$$;

-- f founder, o owner, p peer owner, m member (approver, tenant T only),
-- r reviewer, a admin, x approver in T and viewer in T2, i internal analyst.
insert into auth.users(id, email)
  select pg_temp.u(k), k || '@d154.invalid' from unnest(array['f','o','p','m','r','a','x','i']) k;
insert into public.users(id, email, is_axiom_internal)
  select pg_temp.u(k), k || '@d154.invalid', k in ('f','i') from unnest(array['f','o','p','m','r','a','x','i']) k;
select public.designate_platform_founder(pg_temp.u('f'), 'test', 'delegation test');
insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-0000001541a1', 'd154-t', 'Delegated tenant'),
  ('00000000-0000-0000-0000-0000001541a2', 'd154-t2', 'Other tenant');
insert into public.tenant_users(tenant_id, user_id, role) values
  ('00000000-0000-0000-0000-0000001541a1', pg_temp.u('o'), 'owner'),
  ('00000000-0000-0000-0000-0000001541a1', pg_temp.u('p'), 'owner'),
  ('00000000-0000-0000-0000-0000001541a1', pg_temp.u('m'), 'approver'),
  ('00000000-0000-0000-0000-0000001541a1', pg_temp.u('r'), 'reviewer'),
  ('00000000-0000-0000-0000-0000001541a1', pg_temp.u('a'), 'admin'),
  ('00000000-0000-0000-0000-0000001541a1', pg_temp.u('x'), 'approver'),
  ('00000000-0000-0000-0000-0000001541a2', pg_temp.u('x'), 'viewer'),
  ('00000000-0000-0000-0000-0000001541a1', pg_temp.u('i'), 'axiom_analyst');

-- Live attested sessions and active factors for f, o, p.
insert into auth.sessions(id, user_id, created_at, updated_at)
  select pg_temp.u(k || '9'), pg_temp.u(k), now(), now() from unnest(array['f','o','p']) k;
insert into public.user_mfa_factors(id, user_id, factor_type, status, secret_encrypted, activated_at)
  select pg_temp.u(k || '8'), pg_temp.u(k), 'totp', 'active', 'enc', now()
  from unnest(array['f','o','p','m']) k;
insert into public.mfa_session_attestations(user_id, session_id, factor_id, expires_at)
  select pg_temp.u(k), pg_temp.u(k || '9')::text, pg_temp.u(k || '8'), now() + interval '1 hour'
  from unnest(array['f','o','p']) k;

-- ─── Issue ───────────────────────────────────────────────────────────
-- Only a founder issues; only to an explicit owner of that tenant; only
-- ordinary target roles.
select pg_temp.refused(format($q$select public.issue_mfa_recovery_delegation(%L,%L,%L,%L,%L,array['approver']::user_role[], now() + interval '7 days', 'owner self-delegation attempt')$q$,
  pg_temp.u('o'), pg_temp.u('o9'), pg_temp.step_up(pg_temp.u('o'), 'delegate:' || pg_temp.u('o') || ':00000000-0000-0000-0000-0000001541a1'),
  pg_temp.u('o'), '00000000-0000-0000-0000-0000001541a1'));
select pg_temp.refused(format($q$select public.issue_mfa_recovery_delegation(%L,%L,%L,%L,%L,array['approver']::user_role[], now() + interval '7 days', 'member is not an owner')$q$,
  pg_temp.u('f'), pg_temp.u('f9'), pg_temp.step_up(pg_temp.u('f'), 'delegate:' || pg_temp.u('m') || ':00000000-0000-0000-0000-0000001541a1'),
  pg_temp.u('m'), '00000000-0000-0000-0000-0000001541a1'));
select pg_temp.refused(format($q$select public.issue_mfa_recovery_delegation(%L,%L,%L,%L,%L,array['admin']::user_role[], now() + interval '7 days', 'privileged target role')$q$,
  pg_temp.u('f'), pg_temp.u('f9'), pg_temp.step_up(pg_temp.u('f'), 'delegate:' || pg_temp.u('o') || ':00000000-0000-0000-0000-0000001541a1'),
  pg_temp.u('o'), '00000000-0000-0000-0000-0000001541a1'), '23514');
create temporary table del as
select (public.issue_mfa_recovery_delegation(pg_temp.u('f'), pg_temp.u('f9'),
  pg_temp.step_up(pg_temp.u('f'), 'delegate:' || pg_temp.u('o') || ':00000000-0000-0000-0000-0000001541a1'),
  pg_temp.u('o'), '00000000-0000-0000-0000-0000001541a1', array['approver','viewer']::user_role[],
  now() + interval '7 days', 'Owner handles approver lockouts') ->> 'delegation_id')::uuid as id;

-- ─── Ineligible subjects ─────────────────────────────────────────────
create function pg_temp.open_for(subject text, owner text default 'o') returns void language plpgsql as $$
begin
  perform public.open_delegated_mfa_recovery_case(pg_temp.u(owner), pg_temp.u(owner || '9'),
    pg_temp.step_up(pg_temp.u(owner), 'open:' || pg_temp.u(subject) || ':' || (select id from del)),
    (select id from del), pg_temp.u(subject), 'Member lost phone, verified in person');
end $$;
select pg_temp.refused($q$select pg_temp.open_for('o')$q$);   -- self
select pg_temp.refused($q$select pg_temp.open_for('p')$q$);   -- peer owner
select pg_temp.refused($q$select pg_temp.open_for('a')$q$);   -- admin
select pg_temp.refused($q$select pg_temp.open_for('r')$q$);   -- role not delegated
select pg_temp.refused($q$select pg_temp.open_for('x')$q$);   -- second tenant
select pg_temp.refused($q$select pg_temp.open_for('i')$q$);   -- internal
select pg_temp.refused($q$select pg_temp.open_for('f')$q$);   -- founder
select pg_temp.refused($q$select pg_temp.open_for('m', 'p')$q$); -- not the delegated owner

select pg_temp.assert_true(
  (select jsonb_agg(e ->> 'email') = '["m@d154.invalid"]'::jsonb
   from jsonb_array_elements((public.read_mfa_recovery_delegations(pg_temp.u('o')) -> 'delegations') -> 0 -> 'eligible') e),
  'the owner sees exactly the eligible member');

select pg_temp.assert_true(
  (select count(*) = 2 from jsonb_array_elements(public.read_mfa_recovery_delegations(pg_temp.u('f')) -> 'owners') e
   where e ->> 'tenant_id' = '00000000-0000-0000-0000-0000001541a1'),
  'a founder sees the explicit owners they may delegate to');
select pg_temp.assert_true(
  public.read_mfa_recovery_delegations(pg_temp.u('o')) -> 'owners' = '[]'::jsonb,
  'an owner does not see the owner roster');

-- ─── Open, race, complete ────────────────────────────────────────────
select pg_temp.open_for('m');
create temporary table rc as
  select id as case_id from public.mfa_recovery_cases where subject_user_id = pg_temp.u('m');
select pg_temp.assert_true(
  (select kind = 'delegated_owner' and tenant_id = '00000000-0000-0000-0000-0000001541a1'
   from public.mfa_recovery_cases where id = (select case_id from rc)),
  'case records its delegation scope');
-- Nobody can widen the subject while the case is open.
select pg_temp.refused($q$insert into public.tenant_users(tenant_id, user_id, role)
  values ('00000000-0000-0000-0000-0000001541a2', pg_temp.u('m'), 'viewer')$q$);
select pg_temp.refused($q$update public.tenant_users set role = 'owner'
  where user_id = pg_temp.u('m') and tenant_id = '00000000-0000-0000-0000-0000001541a1'$q$);

insert into auth.sessions(id, user_id, created_at, updated_at)
  values (pg_temp.u('m7'), pg_temp.u('m'), clock_timestamp(), now());
select public.bind_mfa_recovery_session(pg_temp.u('m'), pg_temp.u('m7'), (select case_id from rc));
-- A founder who did not open it cannot authorize it.
select pg_temp.refused(format($q$select public.authorize_mfa_recovery_session(%L,%L,%L,%L,%L)$q$,
  pg_temp.u('f'), pg_temp.u('f9'),
  pg_temp.step_up(pg_temp.u('f'), 'authorize:' || (select case_id from rc) || ':' || pg_temp.u('m7')),
  (select case_id from rc), pg_temp.u('m7')));
select public.authorize_mfa_recovery_session(pg_temp.u('o'), pg_temp.u('o9'),
  pg_temp.step_up(pg_temp.u('o'), 'authorize:' || (select case_id from rc) || ':' || pg_temp.u('m7')),
  (select case_id from rc), pg_temp.u('m7'));
create temporary table nf as
  select public.begin_recovery_totp_enrolment(pg_temp.u('m'), pg_temp.u('m7'), (select case_id from rc), 'enc-new', 'phone') as id;
select public.finalize_recovery_totp_enrolment(pg_temp.u('m'), pg_temp.u('m7'), (select case_id from rc),
  (select id from nf), 1, pg_temp.hashes());
select pg_temp.assert_true(
  (select state = 'completed' from public.mfa_recovery_cases where id = (select case_id from rc)),
  'delegated recovery completes');
-- Membership changes resume once the case is closed.
insert into public.tenant_users(tenant_id, user_id, role)
  values ('00000000-0000-0000-0000-0000001541a2', pg_temp.u('m'), 'viewer');
delete from public.tenant_users where tenant_id = '00000000-0000-0000-0000-0000001541a2' and user_id = pg_temp.u('m');

-- ─── Revocation and expiry are live ──────────────────────────────────
insert into auth.users(id, email) values (pg_temp.u('n'), 'n@d154.invalid');
insert into public.users(id, email) values (pg_temp.u('n'), 'n@d154.invalid');
insert into public.tenant_users(tenant_id, user_id, role)
  values ('00000000-0000-0000-0000-0000001541a1', pg_temp.u('n'), 'viewer');
select pg_temp.open_for('n');
create temporary table rc2 as
  select id as case_id from public.mfa_recovery_cases where subject_user_id = pg_temp.u('n');
insert into auth.sessions(id, user_id, created_at, updated_at)
  values (pg_temp.u('n7'), pg_temp.u('n'), clock_timestamp(), now());
select public.bind_mfa_recovery_session(pg_temp.u('n'), pg_temp.u('n7'), (select case_id from rc2));
select public.revoke_mfa_recovery_delegation(pg_temp.u('f'), pg_temp.u('f9'), (select id from del), 'owner left');
select pg_temp.refused(format($q$select public.authorize_mfa_recovery_session(%L,%L,%L,%L,%L)$q$,
  pg_temp.u('o'), pg_temp.u('o9'),
  pg_temp.step_up(pg_temp.u('o'), 'authorize:' || (select case_id from rc2) || ':' || pg_temp.u('n7')),
  (select case_id from rc2), pg_temp.u('n7')));
-- The owner can no longer cancel under a revoked delegation; a founder can.
select pg_temp.refused(format($q$select public.cancel_mfa_recovery_case(%L,%L,%L)$q$,
  pg_temp.u('o'), pg_temp.u('o9'), (select case_id from rc2)));
select public.cancel_mfa_recovery_case(pg_temp.u('f'), pg_temp.u('f9'), (select case_id from rc2));
select pg_temp.refused($q$select pg_temp.open_for('n')$q$);
select pg_temp.assert_true(
  (select revoked_at is not null and version = 2 from public.mfa_recovery_delegations where id = (select id from del)),
  'revocation is recorded and bumps the version');

-- Expiry: a fresh delegation pushed past its expiry is refused at open.
truncate del;
insert into del
select (public.issue_mfa_recovery_delegation(pg_temp.u('f'), pg_temp.u('f9'),
  pg_temp.step_up(pg_temp.u('f'), 'delegate:' || pg_temp.u('o') || ':00000000-0000-0000-0000-0000001541a1'),
  pg_temp.u('o'), '00000000-0000-0000-0000-0000001541a1', array['viewer']::user_role[],
  now() + interval '1 day', 'Short-lived delegation for expiry') ->> 'delegation_id')::uuid;
update public.mfa_recovery_delegations
   set issued_at = now() - interval '3 days', expires_at = now() - interval '1 day'
 where id = (select id from del);
select pg_temp.refused($q$select pg_temp.open_for('n')$q$);

-- Not callable by signed-in users directly.
set local role authenticated;
select pg_temp.refused($q$select public.open_delegated_mfa_recovery_case(null, null, null, null, null, null)$q$);
select pg_temp.refused($q$select public.issue_mfa_recovery_delegation(null, null, null, null, null, null, null, null)$q$);
reset role;

rollback;
