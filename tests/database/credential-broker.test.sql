begin;
create function pg_temp.ok(value boolean,message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end $$;
create function pg_temp.id(n int) returns uuid language sql immutable as $$select ('42440000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
insert into auth.users(id,email) values(pg_temp.id(1),'broker@test.invalid');
insert into public.users(id,email) values(pg_temp.id(1),'broker@test.invalid');
insert into public.tenants(id,slug,name) values(pg_temp.id(2),'broker-read','Vault'),(pg_temp.id(9),'broker-read-foreign','Foreign');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(2),pg_temp.id(1),'admin');
insert into public.estates(id,tenant_id,slug,name) values(pg_temp.id(3),pg_temp.id(2),'estate','Estate');
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) values(pg_temp.id(4),pg_temp.id(2),pg_temp.id(3),'CRM','saas');
insert into public.connector_descriptors(id,slug,version,transport,target_binding,manifest) values(pg_temp.id(5),'broker-read','1.0.0','rest','production','{"auth":"oauth2.client_credentials"}');
insert into public.connectors(id,tenant_id,system_id,descriptor_id,target_binding,name,endpoint_ref,assurance) values(pg_temp.id(6),pg_temp.id(2),pg_temp.id(4),pg_temp.id(5),'production','CRM','crm','high');
create function pg_temp.envelope() returns jsonb language sql as $$ select jsonb_build_object('formatVersion',1,'algorithm','aes-256-gcm','grantType','client_credentials','descriptorSha256',content_sha256,'endpointRef','crm','targetBinding','production','keyRef','fixture/key','nonce',repeat('aa',12),'ciphertext',repeat('bb',32),'wrappedDataKey',repeat('cc',80)) from public.connector_descriptors where id=pg_temp.id(5) $$;
create function pg_temp.manage(op text,rev int,body jsonb default pg_temp.envelope(),credential uuid default pg_temp.id(7)) returns jsonb language sql as $$
 select public.manage_connector_credential(pg_temp.id(2),pg_temp.id(1),pg_temp.id(6),credential,op,1,rev,body,gen_random_uuid()) $$;
select pg_temp.manage('create',0);
update public.connectors set status='active' where id=pg_temp.id(6);
create function pg_temp.read_credential(patch jsonb default '{}') returns jsonb language sql as $$
 select public.read_broker_credential(
   coalesce((patch->>'tenant')::uuid,pg_temp.id(2)),coalesce((patch->>'estate')::uuid,pg_temp.id(3)),
   coalesce((patch->>'connector')::uuid,pg_temp.id(6)),coalesce((patch->>'credential')::uuid,pg_temp.id(7)),
   coalesce((patch->>'connectorVersion')::integer,1),coalesce((patch->>'revision')::integer,1),
   coalesce(patch->>'hash',(select content_sha256 from public.connector_descriptors where id=pg_temp.id(5))),
   coalesce(patch->>'endpoint','crm'),coalesce(patch->>'binding','production'),coalesce(patch->>'grant','client_credentials')) $$;
set local role service_role;
select pg_temp.ok(pg_temp.read_credential()->>'format_version'='1','live context returns encrypted v1 record');
do $$declare patch jsonb;begin
 for patch in select value from jsonb_array_elements(jsonb_build_array(
 jsonb_build_object('tenant',pg_temp.id(9)),jsonb_build_object('estate',pg_temp.id(9)),
 jsonb_build_object('connector',pg_temp.id(9)),jsonb_build_object('credential',pg_temp.id(9)),
 '{"connectorVersion":2}'::jsonb,'{"revision":2}'::jsonb,'{"hash":"bad"}'::jsonb,
 '{"endpoint":"other"}'::jsonb,'{"binding":"sandbox"}'::jsonb,'{"grant":"jwt_bearer"}'::jsonb)) loop
 perform pg_temp.ok(pg_temp.read_credential(patch) is null,'foreign/stale context refused');
 end loop;
end $$;
reset role;
update public.connector_credentials set revoked_at=now() where id=pg_temp.id(7);
set local role service_role;
select pg_temp.ok(pg_temp.read_credential() is null,'revocation observed');
reset role;
update public.connector_credentials set revoked_at=null,created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' where id=pg_temp.id(7);
set local role service_role;
select pg_temp.ok(pg_temp.read_credential() is null,'expiry observed');
reset role;
update public.connector_credentials set expires_at=null where id=pg_temp.id(7);
update public.connectors set status='disabled' where id=pg_temp.id(6);
set local role service_role;
select pg_temp.ok(pg_temp.read_credential() is null,'disabled registration refused');
reset role;
update public.connectors set status='active' where id=pg_temp.id(6);
update public.estate_systems set status='archived' where id=pg_temp.id(4);
set local role service_role;
select pg_temp.ok(pg_temp.read_credential() is null,'archived system refused');
reset role;
update public.estate_systems set status='active' where id=pg_temp.id(4);
update public.estates set status='archived' where id=pg_temp.id(3);
set local role service_role;
select pg_temp.ok(pg_temp.read_credential() is null,'archived estate refused');
reset role;
select pg_temp.ok(not has_function_privilege('authenticated','public.read_broker_credential(uuid,uuid,uuid,uuid,integer,integer,text,text,text,text)','execute'),'browser private RPC denied');
select pg_temp.ok(not has_function_privilege('anon','public.read_broker_credential(uuid,uuid,uuid,uuid,integer,integer,text,text,text,text)','execute'),'anonymous private RPC denied');
rollback;
