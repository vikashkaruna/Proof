-- The runner removes BYPASSRLS from service_role in its disposable container.
begin;
create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
insert into public.tenants(id, slug, name) values
 ('00000000-0000-4000-8000-0000000000f9', 'managed-probe', 'Existing tenant');
select pg_temp.assert_true((select not rolbypassrls from pg_roles where rolname = 'service_role'), 'test role has no BYPASSRLS');
set local role service_role;
select pg_temp.assert_true((select count(*) = 1 from public.tenants
  where id = '00000000-0000-4000-8000-0000000000f9'), 'service can read known tenant without BYPASSRLS');
insert into public.tenants(id, slug, name) values
 ('00000000-0000-4000-8000-0000000000f8', 'managed-write-probe', 'Created through BFF authority');
update public.tenants set name = 'Updated through BFF authority'
 where id = '00000000-0000-4000-8000-0000000000f8';
select pg_temp.assert_true((select name = 'Updated through BFF authority' from public.tenants
 where id = '00000000-0000-4000-8000-0000000000f8'), 'service writes retain administrative authority');
select pg_temp.assert_true(not has_table_privilege(current_user, 'public.audit_ledger', 'INSERT'), 'service cannot insert directly in ledger');
select pg_temp.assert_true(not has_table_privilege(current_user, 'public.audit_ledger', 'UPDATE'), 'service cannot edit ledger');
select pg_temp.assert_true(not has_table_privilege(current_user, 'public.tenant_ledger_counters', 'UPDATE'), 'service cannot edit ledger counter');
reset role;
set local role authenticated;
select pg_temp.assert_true((select count(*) = 0 from public.tenants), 'unassigned user still reads no tenant');
select pg_temp.assert_true(not has_table_privilege(current_user, 'public.tenants', 'INSERT'), 'clients gain no write privilege');
select pg_temp.assert_true(not pg_has_role(current_user, 'service_role', 'MEMBER'), 'client is not a service principal');
reset role;
rollback;
