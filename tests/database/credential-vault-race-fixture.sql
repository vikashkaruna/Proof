create schema vault_race;
create function vault_race.ok(value boolean,message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end $$;
create function vault_race.id(n int) returns uuid language sql immutable as $$select ('42430000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
insert into auth.users(id,email) values(vault_race.id(1),'vault-race@test.invalid');
insert into public.users(id,email) values(vault_race.id(1),'vault-race@test.invalid');
insert into public.tenants(id,slug,name) values(vault_race.id(2),'vault-race','Vault'),(vault_race.id(9),'vault-race-foreign','Foreign');
insert into public.tenant_users(tenant_id,user_id,role) values(vault_race.id(2),vault_race.id(1),'admin');
insert into public.estates(id,tenant_id,slug,name) values(vault_race.id(3),vault_race.id(2),'estate','Estate');
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) values(vault_race.id(4),vault_race.id(2),vault_race.id(3),'CRM','saas');
insert into public.connector_descriptors(id,slug,version,transport,target_binding,manifest) values(vault_race.id(5),'vault-race','1.0.0','rest','production','{"auth":"oauth2.client_credentials"}');
insert into public.connectors(id,tenant_id,system_id,descriptor_id,target_binding,name,endpoint_ref,assurance) values(vault_race.id(6),vault_race.id(2),vault_race.id(4),vault_race.id(5),'production','CRM','crm','high');
create function vault_race.envelope() returns jsonb language sql as $$ select jsonb_build_object('formatVersion',1,'algorithm','aes-256-gcm','grantType','client_credentials','descriptorSha256',content_sha256,'endpointRef','crm','targetBinding','production','keyRef','fixture/key','nonce',repeat('aa',12),'ciphertext',repeat('bb',32),'wrappedDataKey',repeat('cc',80)) from public.connector_descriptors where id=vault_race.id(5) $$;
create function vault_race.manage(op text,rev int,body jsonb default vault_race.envelope(),credential uuid default vault_race.id(7)) returns jsonb language sql as $$
 select public.manage_connector_credential(vault_race.id(2),vault_race.id(1),vault_race.id(6),credential,op,1,rev,body,gen_random_uuid()) $$;
select vault_race.manage('create',0);
