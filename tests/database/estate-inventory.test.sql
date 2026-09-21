begin;
create function pg_temp.ok(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
create function pg_temp.reject(statement text, code text) returns void language plpgsql as $$
begin
  begin execute statement; exception when others then
    if sqlstate = code then return; end if; raise;
  end;
  raise exception 'Statement should have failed with %: %', code, statement;
end $$;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000000001','estate-reader@test.invalid');
insert into public.users(id,email,is_axiom_internal) values ('00000000-0000-4000-8000-000000000001','estate-reader@test.invalid',true);
insert into public.tenants(id,slug,name) values
 ('00000000-0000-4000-8000-000000000011','estate-a','A'),
 ('00000000-0000-4000-8000-000000000012','estate-b','B');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001','axiom_analyst');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values ('estate-test',now(),'test','test',0);
set local role service_role;
select pg_temp.ok((select not rolbypassrls from pg_roles where rolname=current_user), 'managed service role has no bypass');
insert into public.estates(id,tenant_id,slug,name) values
 ('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000011','production','A production'),
 ('00000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-000000000012','production','B production');
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) values
 ('00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000021','A database','database'),
 ('00000000-0000-4000-8000-000000000032','00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000022','B database','database');
insert into public.system_data_categories(tenant_id,system_id,category_key) values
 ('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000031','contact-details'),
 ('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000032','contact-details');
insert into public.estate_scans(tenant_id,estate_id) select tenant_id,id from public.estates;
insert into public.engagements(tenant_id,estate_id,library_version,title) values
 ('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000021','estate-test','Assigned'),
 ('00000000-0000-4000-8000-000000000011',null,'estate-test','Legacy unassigned');
select pg_temp.ok((select count(*)=2 from public.estates), 'BFF reads both estates without BYPASSRLS');
-- Cross-tenant references fail for privileged writes too, including updates.
select pg_temp.reject($q$update public.estate_systems set estate_id='00000000-0000-4000-8000-000000000022' where name='A database'$q$, '23503');
select pg_temp.reject($q$insert into public.system_data_categories(tenant_id,system_id,category_key) values ('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000032','wrong')$q$, '23503');
select pg_temp.reject($q$update public.estate_scans set estate_id='00000000-0000-4000-8000-000000000022' where tenant_id='00000000-0000-4000-8000-000000000011'$q$, '23503');
select pg_temp.reject($q$update public.engagements set estate_id='00000000-0000-4000-8000-000000000022' where title='Assigned'$q$, '23503');
select pg_temp.reject($q$update public.estate_scans set status='succeeded'$q$, '23514');
select pg_temp.reject($q$delete from public.estates where name='A production'$q$, '23503');
select pg_temp.reject($q$insert into public.estates(tenant_id,slug,name) values ('00000000-0000-4000-8000-000000000011','production','duplicate')$q$, '23505');
update public.estates set status='archived' where name='A production';
select pg_temp.ok((select count(*)=1 from public.estates where status='archived'), 'archive preserves linked history');
reset role;
set local role authenticated;
-- Stale/forged selected tenant B cannot broaden the analyst's membership A.
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated","tenant_id":"00000000-0000-4000-8000-000000000012"}';
select pg_temp.ok((select count(*)=1 from public.estates), 'one estate for assigned analyst');
select pg_temp.ok((select count(*)=1 from public.estate_systems), 'one assigned system');
select pg_temp.ok((select count(*)=1 from public.system_data_categories), 'one assigned category');
select pg_temp.ok((select count(*)=1 from public.estate_scans), 'one assigned scan');
select pg_temp.reject('update public.estates set name=''forged''', '42501');
select pg_temp.reject('delete from public.estate_systems', '42501');
select pg_temp.reject('truncate public.estate_scans', '42501');
select pg_temp.reject($q$insert into public.system_data_categories(tenant_id,system_id,category_key) values ('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000031','forged')$q$, '42501');
-- Missing tenant claim is fine; missing membership is not.
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select pg_temp.ok((select count(*)=1 from public.estates), 'membership decides without a tenant claim');
reset role;
delete from public.tenant_users;
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.estates), 'revoked membership hides estate');
select pg_temp.ok((select count(*)=0 from public.estate_systems), 'revoked membership hides systems');
reset role;
set local role anon;
select pg_temp.reject('select * from public.estates', '42501');
reset role;
rollback;
