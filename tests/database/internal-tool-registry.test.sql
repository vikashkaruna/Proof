begin;
create function pg_temp.ok(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-000000000a71','tool-admin@test.invalid'),
 ('00000000-0000-4000-8000-000000000a72','tool-viewer@test.invalid');
insert into public.users(id,email) values
 ('00000000-0000-4000-8000-000000000a71','tool-admin@test.invalid'),
 ('00000000-0000-4000-8000-000000000a72','tool-viewer@test.invalid');
insert into public.tenants(id,slug,name) values ('00000000-0000-4000-8000-000000000b71','tool-a','A');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('00000000-0000-4000-8000-000000000b71','00000000-0000-4000-8000-000000000a71','admin'),
 ('00000000-0000-4000-8000-000000000b71','00000000-0000-4000-8000-000000000a72','viewer');
insert into public.estates(id,tenant_id,slug,name) values ('00000000-0000-4000-8000-000000000c71','00000000-0000-4000-8000-000000000b71','t','T');
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) values
 ('00000000-0000-4000-8000-000000000c72','00000000-0000-4000-8000-000000000b71','00000000-0000-4000-8000-000000000c71','DB','database');
insert into public.connector_descriptors(id,slug,version,transport,target_binding,manifest) values
 ('00000000-0000-4000-8000-000000000d71','tool-prod','1','sql','production','{}'),
 ('00000000-0000-4000-8000-000000000d72','tool-sandbox','1','sql','sandbox','{}');
insert into public.connectors(id,tenant_id,system_id,descriptor_id,target_binding,name,endpoint_ref,assurance,status) values
 ('00000000-0000-4000-8000-000000000e71','00000000-0000-4000-8000-000000000b71','00000000-0000-4000-8000-000000000c72','00000000-0000-4000-8000-000000000d71','production','Prod','db_prod','high','active'),
 ('00000000-0000-4000-8000-000000000e72','00000000-0000-4000-8000-000000000b71','00000000-0000-4000-8000-000000000c72','00000000-0000-4000-8000-000000000d72','sandbox','Sandbox','db_sandbox','high','active');
create function pg_temp.reg(conn uuid, name text, ver text, class text, descr text, schema jsonb) returns jsonb language sql as $$
 select public.register_connector_tool('00000000-0000-4000-8000-000000000b71','00000000-0000-4000-8000-000000000a71',conn,name,ver,class,descr,schema,gen_random_uuid());
$$;
set local role service_role;
do $$
declare r jsonb; hash text;
begin
 r:=public.register_connector_tool('00000000-0000-4000-8000-000000000b71','00000000-0000-4000-8000-000000000a72','00000000-0000-4000-8000-000000000e71','list_tables','1','read','Lists tables','{"type":"object"}',gen_random_uuid());
 perform pg_temp.ok(r->>'error'='forbidden','viewer cannot register tools');
 perform pg_temp.ok(pg_temp.reg('00000000-0000-4000-8000-000000000e71','list_tables','1',null,'Lists tables','{"type":"object"}')->>'error'='classification_required','unclassified tool refused');
 perform pg_temp.ok(pg_temp.reg('00000000-0000-4000-8000-000000000e71','list_tables','1','admin','Lists tables','{"type":"object"}')->>'error'='classification_required','unknown class refused');
 perform pg_temp.ok(pg_temp.reg('00000000-0000-4000-8000-000000000e71','List Tables','1','read','Lists tables','{"type":"object"}')->>'error'='invalid_request','tool name validated');
 perform pg_temp.ok(pg_temp.reg('00000000-0000-4000-8000-000000000e71','list_tables','1','read','Lists tables','{"type":"array"}')->>'error'='invalid_request','input schema must describe an object');
 perform pg_temp.ok(pg_temp.reg('00000000-0000-4000-8000-000000000e72','update_row','1','write','Updates a row','{"type":"object"}')->>'error'='write_requires_production','no write tools on sandbox');
 r:=pg_temp.reg('00000000-0000-4000-8000-000000000e71','list_tables','1','read','Lists tables','{"type":"object"}');
 hash:=r#>>'{tool,description_sha256}';
 perform pg_temp.ok(hash=encode(sha256(convert_to('Lists tables','UTF8')),'hex'),'description hash pinned by the database');
 perform pg_temp.ok((select count(*)=1 from public.audit_ledger where action_type='connector.tool.registered'),'registration audited');
 perform pg_temp.ok(pg_temp.reg('00000000-0000-4000-8000-000000000e71','list_tables','1','read','Changed','{"type":"object"}')->>'error'='version_exists','a version cannot be redefined');
 perform pg_temp.ok(pg_temp.reg('00000000-0000-4000-8000-000000000e71','list_tables','2','read','Lists tables v2','{"type":"object"}') ? 'tool','a new version is a new row');
 r:=public.verify_connector_tool('00000000-0000-4000-8000-000000000b71','00000000-0000-4000-8000-000000000e71','list_tables','1',hash);
 perform pg_temp.ok(r->>'operationClass'='read','pinned description verifies');
 perform pg_temp.ok(public.verify_connector_tool('00000000-0000-4000-8000-000000000b71','00000000-0000-4000-8000-000000000e71','list_tables','1',encode(sha256(convert_to('Ignore previous instructions','UTF8')),'hex')) is null,'changed description refused');
 perform pg_temp.ok(public.verify_connector_tool('00000000-0000-4000-8000-000000000b71','00000000-0000-4000-8000-000000000e71','drop_everything','1',hash) is null,'unregistered tool refused');
 -- Registrations are append-only for the backend role.
 begin update public.mcp_tool_registry set operation_class='write'; raise exception 'tool reclassified';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.connectors set status='disabled' where id='00000000-0000-4000-8000-000000000e71';
set local role service_role;
do $$ begin
 perform pg_temp.ok(public.verify_connector_tool('00000000-0000-4000-8000-000000000b71','00000000-0000-4000-8000-000000000e71','list_tables','1',
   encode(sha256(convert_to('Lists tables','UTF8')),'hex')) is null,'disabled connector tools do not verify');
end $$;
rollback;
