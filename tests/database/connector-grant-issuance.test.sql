begin;
create function pg_temp.ok(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-000000000a61','grant-admin@test.invalid'),
 ('00000000-0000-4000-8000-000000000a62','grant-approver@test.invalid');
insert into public.users(id,email) values
 ('00000000-0000-4000-8000-000000000a61','grant-admin@test.invalid'),
 ('00000000-0000-4000-8000-000000000a62','grant-approver@test.invalid');
insert into public.tenants(id,slug,name) values ('00000000-0000-4000-8000-000000000b61','grant-a','A');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('00000000-0000-4000-8000-000000000b61','00000000-0000-4000-8000-000000000a61','admin'),
 ('00000000-0000-4000-8000-000000000b61','00000000-0000-4000-8000-000000000a62','approver');
insert into public.estates(id,tenant_id,slug,name) values ('00000000-0000-4000-8000-000000000c61','00000000-0000-4000-8000-000000000b61','g','G');
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) values
 ('00000000-0000-4000-8000-000000000c62','00000000-0000-4000-8000-000000000b61','00000000-0000-4000-8000-000000000c61','CRM','saas');
insert into public.connector_descriptors(id,slug,version,transport,target_binding,manifest) values
 ('00000000-0000-4000-8000-000000000d61','grant-prod','1','rest','production','{"auth":"oauth2.client_credentials"}'),
 ('00000000-0000-4000-8000-000000000d62','grant-sandbox','1','rest','sandbox','{"auth":"oauth2.client_credentials"}');
insert into public.connectors(id,tenant_id,system_id,descriptor_id,target_binding,name,endpoint_ref,assurance,status) values
 ('00000000-0000-4000-8000-000000000e61','00000000-0000-4000-8000-000000000b61','00000000-0000-4000-8000-000000000c62','00000000-0000-4000-8000-000000000d61','production','Prod','crm_prod','high','active'),
 ('00000000-0000-4000-8000-000000000e62','00000000-0000-4000-8000-000000000b61','00000000-0000-4000-8000-000000000c62','00000000-0000-4000-8000-000000000d62','sandbox','Sandbox','crm_sandbox','high','active');
insert into public.connector_credentials(id,tenant_id,connector_id,grant_type,key_ref,algorithm,nonce,ciphertext,wrapped_data_key,
  format_version,descriptor_sha256,endpoint_ref,target_binding)
select '00000000-0000-4000-8000-000000000f61','00000000-0000-4000-8000-000000000b61','00000000-0000-4000-8000-000000000e61','client_credentials',
  'kms://test','aes-256-gcm','\x000102030405060708090a0b'::bytea,'\x00112233445566778899aabbccddeeff00'::bytea,'\x01'::bytea,
  1,d.content_sha256,'crm_prod','production' from public.connector_descriptors d where d.id='00000000-0000-4000-8000-000000000d61';
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status) values
 ('00000000-0000-4000-8000-000000000f71','00000000-0000-4000-8000-000000000b61','drishti','spiffe://test/grant/drishti','active'),
 ('00000000-0000-4000-8000-000000000f72','00000000-0000-4000-8000-000000000b61','karya','spiffe://test/grant/karya','active'),
 ('00000000-0000-4000-8000-000000000f73','00000000-0000-4000-8000-000000000b61','sudhaar','spiffe://test/grant/sudhaar','active');
create function pg_temp.issue(conn uuid, workload uuid, scope text, scopes text[], ttl integer) returns jsonb language sql as $$
 select public.issue_connector_grant('00000000-0000-4000-8000-000000000b61','00000000-0000-4000-8000-000000000a61',conn,workload,scope,scopes,ttl,gen_random_uuid());
$$;
create function pg_temp.resolve(spiffe text, scope text) returns jsonb language sql as $$
 select public.resolve_broker_grant('00000000-0000-4000-8000-000000000b61','00000000-0000-4000-8000-000000000c61','00000000-0000-4000-8000-000000000e61',spiffe,scope);
$$;
set local role service_role;
do $$
declare r jsonb; read_grant uuid; write_grant uuid; events bigint;
begin
 r:=public.issue_connector_grant('00000000-0000-4000-8000-000000000b61','00000000-0000-4000-8000-000000000a62','00000000-0000-4000-8000-000000000e61','00000000-0000-4000-8000-000000000f71','connector.read','{crm.read}',30,gen_random_uuid());
 perform pg_temp.ok(r->>'error'='forbidden','approver cannot issue access');
 perform pg_temp.ok(pg_temp.issue('00000000-0000-4000-8000-000000000e61','00000000-0000-4000-8000-000000000f71','connector.read','{}',30)->>'error'='invalid_request','target scopes required');
 perform pg_temp.ok(pg_temp.issue('00000000-0000-4000-8000-000000000e61','00000000-0000-4000-8000-000000000f71','connector.read','{a,a}',30)->>'error'='invalid_request','duplicate target scopes refused');
 perform pg_temp.ok(pg_temp.issue('00000000-0000-4000-8000-000000000e61','00000000-0000-4000-8000-000000000f71','connector.read','{crm.read}',91)->>'error'='invalid_request','ttl capped at 90 days');
 perform pg_temp.ok(pg_temp.issue('00000000-0000-4000-8000-000000000e61','00000000-0000-4000-8000-000000000f71','connector.write','{crm.write}',30)->>'error'='agent_scope_refused','drishti cannot write');
 perform pg_temp.ok(pg_temp.issue('00000000-0000-4000-8000-000000000e61','00000000-0000-4000-8000-000000000f72','connector.read','{crm.read}',30)->>'error'='agent_scope_refused','karya is write-only');
 perform pg_temp.ok(pg_temp.issue('00000000-0000-4000-8000-000000000e61','00000000-0000-4000-8000-000000000f73','connector.read','{crm.read}',30)->>'error'='agent_scope_refused','sudhaar receives no connector access');
 perform pg_temp.ok(pg_temp.issue('00000000-0000-4000-8000-000000000e62','00000000-0000-4000-8000-000000000f72','connector.write','{crm.write}',30)->>'error'='write_requires_production','no write on a sandbox binding');
 r:=pg_temp.issue('00000000-0000-4000-8000-000000000e61','00000000-0000-4000-8000-000000000f71','connector.read','{crm.read}',30);
 read_grant:=(r#>>'{grant,id}')::uuid;
 perform pg_temp.ok(read_grant is not null and (r#>>'{grant,expires_at}')::timestamptz between now()+interval '29 days' and now()+interval '31 days','read grant issued with bounded expiry');
 perform pg_temp.ok((select count(*)=1 from public.audit_ledger where action_type='connector.grant.issued' and target_ref=read_grant::text),'issuance audited');
 perform pg_temp.ok(pg_temp.issue('00000000-0000-4000-8000-000000000e61','00000000-0000-4000-8000-000000000f71','connector.read','{crm.read}',30)->>'error'='grant_exists','duplicate active grant refused');
 write_grant:=(pg_temp.issue('00000000-0000-4000-8000-000000000e61','00000000-0000-4000-8000-000000000f72','connector.write','{crm.write}',7)#>>'{grant,id}')::uuid;
 perform pg_temp.ok(write_grant is not null,'karya write grant on production');

 r:=pg_temp.resolve('spiffe://test/grant/drishti','connector.read');
 perform pg_temp.ok(r->>'grantId'=read_grant::text and r->>'credentialId'='00000000-0000-4000-8000-000000000f61' and r->>'grantType'='client_credentials','live read grant resolves with its credential');
 perform pg_temp.ok(pg_temp.resolve('spiffe://test/grant/drishti','connector.write') is null,'no write resolution for drishti');
 perform pg_temp.ok(pg_temp.resolve('spiffe://test/grant/other','connector.read') is null,'unknown workload resolves nothing');
 perform pg_temp.ok(public.resolve_broker_grant('00000000-0000-4000-8000-000000000b61',gen_random_uuid(),'00000000-0000-4000-8000-000000000e61','spiffe://test/grant/drishti','connector.read') is null,'wrong estate resolves nothing');

 perform set_config('grant_test.read_grant', read_grant::text, true);
end $$;

-- Every lifecycle input is re-read at resolution time. Fixture changes run as
-- the owner; assertions run as the backend role.
create function pg_temp.check_resolves(expected boolean, message text) returns void language plpgsql as $$
begin
 perform pg_temp.ok((public.resolve_broker_grant('00000000-0000-4000-8000-000000000b61','00000000-0000-4000-8000-000000000c61',
   '00000000-0000-4000-8000-000000000e61','spiffe://test/grant/drishti','connector.read') is not null) = expected, message);
end $$;
reset role;
update public.workload_identities set status='disabled' where id='00000000-0000-4000-8000-000000000f71';
set local role service_role;
select pg_temp.check_resolves(false,'disabled workload resolves nothing');
reset role;
update public.workload_identities set status='active' where id='00000000-0000-4000-8000-000000000f71';
insert into public.kill_switch_state(scope_key,scope,tenant_id,engaged) values ('00000000-0000-4000-8000-000000000b61','tenant','00000000-0000-4000-8000-000000000b61',true)
 on conflict (scope_key) do update set engaged=true;
set local role service_role;
select pg_temp.check_resolves(false,'tenant kill switch blocks resolution');
reset role;
update public.kill_switch_state set engaged=false where scope_key='00000000-0000-4000-8000-000000000b61';
update public.connector_credentials set revoked_at=now() where id='00000000-0000-4000-8000-000000000f61';
set local role service_role;
select pg_temp.check_resolves(false,'revoked credential resolves nothing');
reset role;
update public.connector_credentials set revoked_at=null where id='00000000-0000-4000-8000-000000000f61';
set local role service_role;
select pg_temp.check_resolves(true,'resolves again once every input is live');
do $$
declare events bigint;
begin
 perform public.attest_connector_grant('00000000-0000-4000-8000-000000000b61','00000000-0000-4000-8000-000000000a61',
   current_setting('grant_test.read_grant')::uuid,'revoke',gen_random_uuid());
 perform pg_temp.check_resolves(false,'revoked grant resolves nothing');
end $$;
reset role;
update public.connectors set status='disabled' where id='00000000-0000-4000-8000-000000000e61';
set local role service_role;
do $$
declare events bigint;
begin
 select count(*) into events from public.audit_ledger;
 perform pg_temp.ok(pg_temp.issue('00000000-0000-4000-8000-000000000e61','00000000-0000-4000-8000-000000000f71','connector.read','{crm.read}',30)->>'error'='connector_inactive','no grant on a disabled connector');
 perform pg_temp.ok((select count(*)=events from public.audit_ledger),'refused issuance is not audited as success');
end $$;
rollback;
