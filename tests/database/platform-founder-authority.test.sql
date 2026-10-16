-- e450: a live platform founder reaches every current and future tenant
-- without a per-tenant grant; the internal flag alone does not; revocation is
-- live; explicit memberships and their history are never rewritten.
begin;

create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
create function pg_temp.refused(statement text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when insufficient_privilege then return; end;
  raise exception 'Statement was not refused: %', statement;
end $$;
create function pg_temp.as_user(id uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', id, 'role', 'authenticated')::text, true);
end $$;

insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000151a1', 'founder-a@axiomminds.invalid'),
  ('00000000-0000-0000-0000-0000000151a2', 'founder-b@axiomminds.invalid'),
  ('00000000-0000-0000-0000-0000000151a3', 'analyst@axiomminds.invalid'),
  ('00000000-0000-0000-0000-0000000151a4', 'owner@client.invalid');
insert into public.users(id, email, is_axiom_internal) values
  ('00000000-0000-0000-0000-0000000151a1', 'founder-a@axiomminds.invalid', true),
  ('00000000-0000-0000-0000-0000000151a2', 'founder-b@axiomminds.invalid', true),
  ('00000000-0000-0000-0000-0000000151a3', 'analyst@axiomminds.invalid', true),
  ('00000000-0000-0000-0000-0000000151a4', 'owner@client.invalid', false);

insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-0000000151b1', 'pf-existing-one', 'Existing one'),
  ('00000000-0000-0000-0000-0000000151b2', 'pf-existing-two', 'Existing two');
-- Founder B keeps a legacy explicit owner row in tenant one.
insert into public.tenant_users(tenant_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000151b1', '00000000-0000-0000-0000-0000000151a4', 'owner'),
  ('00000000-0000-0000-0000-0000000151b1', '00000000-0000-0000-0000-0000000151a2', 'owner'),
  ('00000000-0000-0000-0000-0000000151b2', '00000000-0000-0000-0000-0000000151a3', 'axiom_analyst');

-- Designation of a non-internal user is refused.
do $$ begin
  perform public.designate_platform_founder('00000000-0000-0000-0000-0000000151a4', 'test', 'refused');
  raise exception 'external user was designated';
exception when insufficient_privilege then null; end $$;

select public.designate_platform_founder('00000000-0000-0000-0000-0000000151a1', 'test', 'founder a');
select public.designate_platform_founder('00000000-0000-0000-0000-0000000151a2', 'test', 'founder b');

select pg_temp.assert_true(
  (select count(*) from public.tenant_users
   where user_id = '00000000-0000-0000-0000-0000000151a1' and role = 'founder'
     and membership_source = 'platform_founder'
     and tenant_id in ('00000000-0000-0000-0000-0000000151b1', '00000000-0000-0000-0000-0000000151b2')) = 2,
  'designation derives founder rows in every existing tenant');
select pg_temp.assert_true(
  (select role = 'owner' and membership_source = 'explicit' from public.tenant_users
   where user_id = '00000000-0000-0000-0000-0000000151a2' and tenant_id = '00000000-0000-0000-0000-0000000151b1'),
  'an explicit membership is not rewritten by derivation');

-- A tenant created after designation is reachable at once.
insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-0000000151b3', 'pf-new', 'New tenant');
select pg_temp.assert_true(
  (select count(*) = 2 from public.tenant_users
   where tenant_id = '00000000-0000-0000-0000-0000000151b3' and role = 'founder'),
  'a new tenant gets every live founder without a grant');

-- Direct writers, including the owner of the table, cannot forge or edit a
-- derived row.
select pg_temp.refused($q$insert into public.tenant_users(tenant_id, user_id, role, membership_source)
  values ('00000000-0000-0000-0000-0000000151b2', '00000000-0000-0000-0000-0000000151a4', 'founder', 'platform_founder')$q$);
select pg_temp.refused($q$update public.tenant_users set role = 'owner'
  where user_id = '00000000-0000-0000-0000-0000000151a1' and tenant_id = '00000000-0000-0000-0000-0000000151b2'$q$);
select pg_temp.refused($q$delete from public.tenant_users
  where user_id = '00000000-0000-0000-0000-0000000151a1' and tenant_id = '00000000-0000-0000-0000-0000000151b2'$q$);

-- RLS: the founder sees all three tenants; the internal analyst sees only the
-- one they are assigned to; neither can designate.
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000151a1');
select pg_temp.assert_true((select count(*) = 3 from public.tenants where slug like 'pf-%'),
  'founder reads every tenant through RLS');
select pg_temp.assert_true(
  public.has_tenant_role('00000000-0000-0000-0000-0000000151b3', array['founder']::user_role[]),
  'founder role resolves in the new tenant');
select pg_temp.assert_true(public.is_live_platform_founder('00000000-0000-0000-0000-0000000151a1'),
  'live founder is reported live');
select pg_temp.refused($q$select public.designate_platform_founder('00000000-0000-0000-0000-0000000151a3', 'self', 'escalate')$q$);
select pg_temp.refused($q$insert into public.platform_founders(user_id, designated_by, designation_reason)
  values ('00000000-0000-0000-0000-0000000151a3', 'self', 'escalate')$q$);
select pg_temp.as_user('00000000-0000-0000-0000-0000000151a3');
select pg_temp.assert_true((select count(*) = 1 from public.tenants where slug like 'pf-%'),
  'internal analyst is not widened by the founder mechanism');
select pg_temp.assert_true((select count(*) = 0 from public.platform_founders),
  'analyst cannot read founder designations');
reset role;

-- Designations are retained: no deletion, no rewrite.
select pg_temp.refused($q$delete from public.platform_founders where user_id = '00000000-0000-0000-0000-0000000151a1'$q$);
select pg_temp.refused($q$update public.platform_founders set designated_by = 'someone else'
  where user_id = '00000000-0000-0000-0000-0000000151a1'$q$);

-- Removing founder B's explicit row re-derives founder access there.
delete from public.tenant_users
  where user_id = '00000000-0000-0000-0000-0000000151a2' and tenant_id = '00000000-0000-0000-0000-0000000151b1';
select pg_temp.assert_true(
  (select role = 'founder' and membership_source = 'platform_founder' from public.tenant_users
   where user_id = '00000000-0000-0000-0000-0000000151a2' and tenant_id = '00000000-0000-0000-0000-0000000151b1'),
  'explicit removal does not remove a live founder');

-- Revocation is live and leaves explicit rows alone.
insert into public.tenant_users(tenant_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000151b1', '00000000-0000-0000-0000-0000000151a3', 'viewer');
select public.revoke_platform_founder('00000000-0000-0000-0000-0000000151a1', 'test', 'left');
select pg_temp.assert_true(
  (select count(*) = 0 from public.tenant_users where user_id = '00000000-0000-0000-0000-0000000151a1'),
  'revocation removes every derived row');
select pg_temp.refused($q$update public.platform_founders set revoked_at = null, revoked_by = null, revocation_reason = null
  where user_id = '00000000-0000-0000-0000-0000000151a1'$q$);
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000151a1');
select pg_temp.assert_true((select count(*) = 0 from public.tenants where slug like 'pf-%'),
  'revoked founder reads no tenant');
reset role;

-- Clearing the internal flag withdraws access; restoring it re-derives.
update public.users set is_axiom_internal = false where id = '00000000-0000-0000-0000-0000000151a2';
select pg_temp.assert_true(
  (select count(*) = 0 from public.tenant_users where user_id = '00000000-0000-0000-0000-0000000151a2'),
  'internal-flag removal withdraws founder access');
update public.users set is_axiom_internal = true where id = '00000000-0000-0000-0000-0000000151a2';
select pg_temp.assert_true(
  (select count(*) = 3 from public.tenant_users where user_id = '00000000-0000-0000-0000-0000000151a2'),
  'restoring the internal flag re-derives founder access');

-- Tenant deletion still cascades through derived rows.
delete from public.tenants where id = '00000000-0000-0000-0000-0000000151b3';
select pg_temp.assert_true(
  (select count(*) = 0 from public.tenant_users where tenant_id = '00000000-0000-0000-0000-0000000151b3'),
  'tenant deletion cascades through derived founder rows');

rollback;
