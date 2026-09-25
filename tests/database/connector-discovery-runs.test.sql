begin;
create function pg_temp.ok(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000006a61','disc-admin@test.invalid');
insert into public.users(id,email) values ('00000000-0000-4000-8000-000000006a61','disc-admin@test.invalid');
insert into public.tenants(id,slug,name) values ('00000000-0000-4000-8000-000000006b61','disc-a','A'),('00000000-0000-4000-8000-000000006b62','disc-b','B');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('00000000-0000-4000-8000-000000006b61','00000000-0000-4000-8000-000000006a61','admin');
insert into public.estates(id,tenant_id,slug,name) values ('00000000-0000-4000-8000-000000006c61','00000000-0000-4000-8000-000000006b61','d','D');
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) values
 ('00000000-0000-4000-8000-000000006c62','00000000-0000-4000-8000-000000006b61','00000000-0000-4000-8000-000000006c61','CRM DB','database');
insert into public.connector_descriptors(id,slug,version,transport,target_binding,manifest) values
 ('00000000-0000-4000-8000-000000006d61','disc-sql','1','sql','production','{"auth":"cloud_iam"}');
insert into public.connectors(id,tenant_id,system_id,descriptor_id,target_binding,name,endpoint_ref,assurance,status) values
 ('00000000-0000-4000-8000-000000006e61','00000000-0000-4000-8000-000000006b61','00000000-0000-4000-8000-000000006c62','00000000-0000-4000-8000-000000006d61','production','CRM SQL','crm_sql','high','active');
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status) values
 ('00000000-0000-4000-8000-000000006f71','00000000-0000-4000-8000-000000006b61','drishti','spiffe://test/disc/drishti','active'),
 ('00000000-0000-4000-8000-000000006f72','00000000-0000-4000-8000-000000006b61','karya','spiffe://test/disc/karya','active');
set local role service_role;
do $$
declare g uuid; k uuid; r jsonb; events bigint;
  meta jsonb := '[{"resource":"crm.customers","kind":"r","estimatedRows":3,"columns":[{"name":"email","type":"character varying(255)","nullable":true,"categoryHints":["contact"]}],"categoryHints":["contact"]}]';
  sample jsonb := '[{"column":"email","sampled":3,"nonNull":3,"detected":{"email":2},"categoryHints":["contact"]}]';
  rec text := 'select public.record_connector_discovery(''00000000-0000-4000-8000-000000006b61'',''00000000-0000-4000-8000-000000006e61'',$1,$2,$3,$4,$5,gen_random_uuid())';
begin
 g:=(public.issue_connector_grant('00000000-0000-4000-8000-000000006b61','00000000-0000-4000-8000-000000006a61','00000000-0000-4000-8000-000000006e61',
   '00000000-0000-4000-8000-000000006f71','connector.read','{sql.enumerate}',30,gen_random_uuid())#>>'{grant,id}')::uuid;
 k:=(public.issue_connector_grant('00000000-0000-4000-8000-000000006b61','00000000-0000-4000-8000-000000006a61','00000000-0000-4000-8000-000000006e61',
   '00000000-0000-4000-8000-000000006f72','connector.write','{sql.execute}',7,gen_random_uuid())#>>'{grant,id}')::uuid;
 execute rec into r using g,'spiffe://test/disc/drishti','enumerate',null::text,meta;
 perform pg_temp.ok((r#>>'{run,recordCount}')::int=1,'metadata enumerate recorded');
 perform pg_temp.ok((select count(*)=1 from public.audit_ledger where action_type='connector.discovery.completed' and actor_type='agent' and actor_id='drishti'),'run audited as drishti');
 execute rec into r using g,'spiffe://test/disc/drishti','sample','crm.customers',sample;
 perform pg_temp.ok(r ? 'run','sample recorded');
 select count(*) into events from public.audit_ledger;
 execute rec into r using g,'spiffe://test/disc/drishti','sample','crm.customers','[{"column":"email","value":"asha@example.in"}]'::jsonb;
 perform pg_temp.ok(r->>'error'='invalid_result','an email value is refused');
 execute rec into r using g,'spiffe://test/disc/drishti','sample','crm.customers','[{"column":"name","value":"Asha Rao, Bengaluru 560001!"}]'::jsonb;
 perform pg_temp.ok(r->>'error'='invalid_result','free text is refused');
 execute rec into r using g,'spiffe://test/disc/drishti','sample','crm.customers','[{"n":1.5}]'::jsonb;
 perform pg_temp.ok(r->>'error'='invalid_result','non-integer numbers refused');
 execute rec into r using g,'spiffe://test/disc/drishti','sample',null::text,sample;
 perform pg_temp.ok(r->>'error'='invalid_result','sample requires a resource');
 execute rec into r using g,'spiffe://test/disc/other','enumerate',null::text,meta;
 perform pg_temp.ok(r->>'error'='workload_mismatch','another workload cannot record on this grant');
 execute rec into r using k,'spiffe://test/disc/karya','enumerate',null::text,meta;
 perform pg_temp.ok(r->>'error'='grant_inactive','karya write grant cannot record discovery');
 perform pg_temp.ok((select count(*)=events from public.audit_ledger),'refusals are not audited as success');
 perform public.attest_connector_grant('00000000-0000-4000-8000-000000006b61','00000000-0000-4000-8000-000000006a61',g,'revoke',gen_random_uuid());
 execute rec into r using g,'spiffe://test/disc/drishti','enumerate',null::text,meta;
 perform pg_temp.ok(r->>'error'='grant_inactive','revoked grant cannot record');
 r:=public.record_connector_discovery('00000000-0000-4000-8000-000000006b62','00000000-0000-4000-8000-000000006e61',g,'spiffe://test/disc/drishti','enumerate',null,meta,gen_random_uuid());
 perform pg_temp.ok(r->>'error'='grant_inactive','cross-tenant record refused');
 begin update public.connector_discovery_runs set record_count=0; raise exception 'run changed';
 exception when insufficient_privilege then null; end;
 begin delete from public.connector_discovery_runs; raise exception 'run deleted';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
do $$
begin
 perform public.record_connector_discovery(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'x','enumerate',null,'[]',gen_random_uuid());
 raise exception 'authenticated recorded discovery';
exception when insufficient_privilege then null;
end $$;
rollback;
