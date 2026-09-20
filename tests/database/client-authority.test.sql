begin;
-- Assertions execute with the caller's role: no SECURITY DEFINER test helpers.
create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
create function pg_temp.denied(statement text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when insufficient_privilege then return; end;
  raise exception 'Statement was not denied: %', statement;
end $$;

insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-000000000011', 'owner@test.invalid'),
  ('00000000-0000-0000-0000-000000000012', 'staff@test.invalid'),
  ('00000000-0000-0000-0000-000000000013', 'new@test.invalid');
insert into public.users(id, email, is_axiom_internal) values
  ('00000000-0000-0000-0000-000000000011', 'owner@test.invalid', false),
  ('00000000-0000-0000-0000-000000000012', 'staff@test.invalid', true);
insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-000000000021', 'security-a', 'A'),
  ('00000000-0000-0000-0000-000000000022', 'security-b', 'B');
insert into public.tenant_users(tenant_id, user_id, role) values
  ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000011', 'owner'),
  ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000012', 'reviewer');
insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-security', now(), 'test', 'test', 0);
insert into public.engagements(tenant_id, library_version, title) values
  ('00000000-0000-0000-0000-000000000021', 'test-security', 'A'),
  ('00000000-0000-0000-0000-000000000022', 'test-security', 'B');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000011","role":"authenticated","tenant_id":"00000000-0000-0000-0000-000000000021"}';
select pg_temp.assert_true((select count(*) = 1 from tenants), 'only member tenant visible');
select pg_temp.assert_true((select count(*) = 1 from engagements), 'only member engagement visible');
select pg_temp.denied('update public.users set is_axiom_internal = true where id = auth.uid()');
select pg_temp.denied($q$insert into tenant_users(tenant_id,user_id,role) values ('00000000-0000-0000-0000-000000000022',auth.uid(),'founder')$q$);
select pg_temp.denied($q$update tenants set name='owned' where id='00000000-0000-0000-0000-000000000022'$q$);
select pg_temp.denied($q$update remediation_actions set rollback_validated=true$q$);
select pg_temp.denied('truncate table public.users cascade');
select pg_temp.denied('select * from auth.users');
select pg_temp.denied('update public.approval_tokens set status=''issued''');
select pg_temp.denied('update public.audit_ledger set actor_id=''forged''');

-- A forged/stale selected-tenant claim never widens membership visibility.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000011","role":"authenticated","tenant_id":"00000000-0000-0000-0000-000000000022"}';
select pg_temp.assert_true((select count(*) = 0 from tenants where slug='security-b'), 'claim cannot grant membership');

-- Internal staff are confined to their assigned tenants as well.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000012","role":"authenticated"}';
select pg_temp.assert_true((select count(*) = 1 from engagements), 'internal flag does not bypass RLS');
select pg_temp.assert_true(not public.has_tenant_role('00000000-0000-0000-0000-000000000022',array['reviewer']::user_role[]), 'row-bound role');

-- Signup remains functional without granting authority fields.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000013","role":"authenticated"}';
select pg_temp.denied($q$insert into users(id,email,is_axiom_internal) values(auth.uid(),'new@test.invalid',true)$q$);
insert into users(id,email,full_name) values(auth.uid(),'new@test.invalid','New user');
update users set full_name='Updated profile' where id=auth.uid();
select pg_temp.assert_true((select not is_axiom_internal from users where id=auth.uid()), 'new profile not internal');

reset role;
set local role service_role;
select public.append_ledger(
  '00000000-0000-0000-0000-000000000021', gen_random_uuid(), 'system', 'security-test',
  null, null, null, 'tenant.updated', null, null, null, null, null, null, null, 'success', '{}'
);
select pg_temp.assert_true((select count(*) = 1 from public.audit_ledger), 'sanctioned ledger RPC still works');
select pg_temp.denied('delete from public.audit_ledger');
reset role;
select pg_temp.assert_true(not has_table_privilege('service_role','public.audit_ledger','INSERT'), 'backend cannot insert ledger directly');
select pg_temp.assert_true(not has_table_privilege('ledger_writer','public.audit_ledger','UPDATE'), 'ledger writer remains append only');
select pg_temp.assert_true(not has_table_privilege('authenticated','public.mfa_challenges','INSERT'), 'cannot self attest MFA');
select pg_temp.assert_true(not has_table_privilege('authenticated','public.agent_runs','INSERT'), 'cannot spoof agent runs');
rollback;
