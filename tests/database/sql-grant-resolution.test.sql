begin;
create function pg_temp.ok(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000005a61','sql-admin@test.invalid');
insert into public.users(id,email) values ('00000000-0000-4000-8000-000000005a61','sql-admin@test.invalid');
insert into public.tenants(id,slug,name) values ('00000000-0000-4000-8000-000000005b61','sql-a','A');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('00000000-0000-4000-8000-000000005b61','00000000-0000-4000-8000-000000005a61','admin');
insert into public.estates(id,tenant_id,slug,name) values ('00000000-0000-4000-8000-000000005c61','00000000-0000-4000-8000-000000005b61','s','S');
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) values
 ('00000000-0000-4000-8000-000000005c62','00000000-0000-4000-8000-000000005b61','00000000-0000-4000-8000-000000005c61','CRM DB','database');
insert into public.connector_descriptors(id,slug,version,transport,target_binding,manifest) values
 ('00000000-0000-4000-8000-000000005d61','sql-iam','1','sql','production','{"auth":"cloud_iam"}'),
 ('00000000-0000-4000-8000-000000005d62','sql-oauth','1','rest','production','{"auth":"oauth2.client_credentials"}');
insert into public.connectors(id,tenant_id,system_id,descriptor_id,target_binding,name,endpoint_ref,assurance,status) values
 ('00000000-0000-4000-8000-000000005e61','00000000-0000-4000-8000-000000005b61','00000000-0000-4000-8000-000000005c62','00000000-0000-4000-8000-000000005d61','production','CRM SQL','crm_sql','high','active'),
 ('00000000-0000-4000-8000-000000005e62','00000000-0000-4000-8000-000000005b61','00000000-0000-4000-8000-000000005c62','00000000-0000-4000-8000-000000005d62','production','CRM REST','crm_rest','high','active');
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status) values
 ('00000000-0000-4000-8000-000000005f71','00000000-0000-4000-8000-000000005b61','drishti','spiffe://test/sql/drishti','active'),
 ('00000000-0000-4000-8000-000000005f72','00000000-0000-4000-8000-000000005b61','karya','spiffe://test/sql/karya','active');
create function pg_temp.resolve(conn uuid, spiffe text) returns jsonb language sql as $$
 select public.resolve_sql_read_grant('00000000-0000-4000-8000-000000005b61','00000000-0000-4000-8000-000000005c61',conn,spiffe);
$$;
set local role service_role;
do $$
declare r jsonb; g uuid;
begin
 perform pg_temp.ok(pg_temp.resolve('00000000-0000-4000-8000-000000005e61','spiffe://test/sql/drishti') is null,'no grant, nothing resolves');
 r:=public.issue_connector_grant('00000000-0000-4000-8000-000000005b61','00000000-0000-4000-8000-000000005a61','00000000-0000-4000-8000-000000005e61',
   '00000000-0000-4000-8000-000000005f71','connector.read','{sql.enumerate,sql.sample}',30,gen_random_uuid());
 g:=(r#>>'{grant,id}')::uuid;
 perform pg_temp.ok(g is not null,'read grant issued on the SQL connector');
 perform public.issue_connector_grant('00000000-0000-4000-8000-000000005b61','00000000-0000-4000-8000-000000005a61','00000000-0000-4000-8000-000000005e62',
   '00000000-0000-4000-8000-000000005f71','connector.read','{crm.read}',30,gen_random_uuid());
 perform public.issue_connector_grant('00000000-0000-4000-8000-000000005b61','00000000-0000-4000-8000-000000005a61','00000000-0000-4000-8000-000000005e61',
   '00000000-0000-4000-8000-000000005f72','connector.write','{sql.execute}',7,gen_random_uuid());
 r:=pg_temp.resolve('00000000-0000-4000-8000-000000005e61','spiffe://test/sql/drishti');
 perform pg_temp.ok(r->>'grantId'=g::text and r->>'endpointRef'='crm_sql' and r->>'systemId'='00000000-0000-4000-8000-000000005c62','cloud-IAM read grant resolves without a vault credential');
 perform pg_temp.ok(pg_temp.resolve('00000000-0000-4000-8000-000000005e62','spiffe://test/sql/drishti') is null,'OAuth descriptor never resolves on the SQL path');
 perform pg_temp.ok(pg_temp.resolve('00000000-0000-4000-8000-000000005e61','spiffe://test/sql/karya') is null,'karya write grant never resolves on the SQL read path');
 perform pg_temp.ok(pg_temp.resolve('00000000-0000-4000-8000-000000005e61','spiffe://test/sql/other') is null,'unknown workload resolves nothing');
 perform set_config('sql_test.grant', g::text, true);
end $$;
create function pg_temp.check(expected boolean, message text) returns void language plpgsql as $$
begin perform pg_temp.ok((pg_temp.resolve('00000000-0000-4000-8000-000000005e61','spiffe://test/sql/drishti') is not null)=expected, message); end $$;
reset role;
insert into public.kill_switch_state(scope_key,scope,tenant_id,engaged) values ('00000000-0000-4000-8000-000000005b61','tenant','00000000-0000-4000-8000-000000005b61',true)
 on conflict (scope_key) do update set engaged=true;
set local role service_role;
select pg_temp.check(false,'tenant kill switch blocks SQL resolution');
reset role;
update public.kill_switch_state set engaged=false where scope_key='00000000-0000-4000-8000-000000005b61';
update public.estate_systems set status='archived' where id='00000000-0000-4000-8000-000000005c62';
set local role service_role;
select pg_temp.check(false,'archived system resolves nothing');
reset role;
update public.estate_systems set status='active' where id='00000000-0000-4000-8000-000000005c62';
set local role service_role;
select pg_temp.check(true,'resolves again once every input is live');
do $$
begin
 perform public.attest_connector_grant('00000000-0000-4000-8000-000000005b61','00000000-0000-4000-8000-000000005a61',
   current_setting('sql_test.grant')::uuid,'revoke',gen_random_uuid());
 perform pg_temp.check(false,'revoked grant resolves nothing');
end $$;
reset role;
set local role authenticated;
do $$
begin
 perform public.resolve_sql_read_grant(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'x');
 raise exception 'authenticated resolved a grant';
exception when insufficient_privilege then null;
end $$;
rollback;
