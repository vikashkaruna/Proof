begin;
create function pg_temp.ok(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000000001','manager@test.invalid');
insert into public.users(id,email) values ('00000000-0000-4000-8000-000000000001','manager@test.invalid');
insert into public.tenants(id,slug,name) values
 ('00000000-0000-4000-8000-000000000011','manage-a','A'),
 ('00000000-0000-4000-8000-000000000012','manage-b','B');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001','admin');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values ('manage-test',now(),'test','test',0);
insert into public.engagements(id,tenant_id,library_version,title) values
 ('00000000-0000-4000-8000-000000000041','00000000-0000-4000-8000-000000000011','manage-test','Unassigned');
create function pg_temp.manage(op text, id uuid, body jsonb) returns jsonb language sql as $$
 select public.manage_estate('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001',op,id,body,gen_random_uuid());
$$;
set local role service_role;
do $$
declare estate uuid; system uuid; response jsonb; events bigint;
begin
 response:=pg_temp.manage('estate.create',null,'{"slug":"india-prod","name":"India production"}');
 estate:=(response#>>'{resource,id}')::uuid;
 perform pg_temp.ok(estate is not null, 'admin creates estate');
 perform pg_temp.ok((select count(*)=1 from public.audit_ledger where action_type='estate.created' and target_ref=estate::text),'creation audited');
 response:=pg_temp.manage('system.create',estate,'{"name":"CRM","systemKind":"saas","dataCategories":["contact"]}');
 system:=(response#>>'{resource,id}')::uuid;
 perform pg_temp.ok(system is not null,'system created');
 insert into public.system_data_categories(tenant_id,system_id,category_key,source) values ('00000000-0000-4000-8000-000000000011',system,'contact','observed');
 response:=pg_temp.manage('system.update',system,'{"name":"CRM v2","systemKind":"saas","dataCategories":["contact"],"status":"active","expectedVersion":1}');
 perform pg_temp.ok(response#>>'{resource,version}'='2','update increments version');
 perform pg_temp.ok((select count(*)=2 from public.system_data_categories where system_id=system),'observed and declared provenance coexist');
 response:=pg_temp.manage('system.update',system,'{"name":"CRM v3","systemKind":"saas","dataCategories":[],"status":"active","expectedVersion":2}');
 perform pg_temp.ok((select count(*)=1 from public.system_data_categories where system_id=system and source='observed'),'clearing declarations preserves observation');
 select count(*) into events from public.audit_ledger;
 response:=pg_temp.manage('system.update',system,'{"name":"Lost edit","systemKind":"saas","dataCategories":[],"status":"active","expectedVersion":1}');
 perform pg_temp.ok(response->>'error'='version_conflict','stale edit refused');
 perform pg_temp.ok((select count(*)=events from public.audit_ledger),'refused edit has no success event');
 response:=public.manage_estate('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000001','estate.update',estate,'{}',gen_random_uuid());
 perform pg_temp.ok(response->>'error'='forbidden','tenant membership repeated in transaction');
 response:=pg_temp.manage('engagement.assign','00000000-0000-4000-8000-000000000041',jsonb_build_object('estateId',estate,'confirmed',false));
 perform pg_temp.ok(response->>'error'='confirmation_required','assignment requires explicit confirmation');
 response:=pg_temp.manage('engagement.assign','00000000-0000-4000-8000-000000000041',jsonb_build_object('estateId',estate,'confirmed',true));
 perform pg_temp.ok(response#>>'{resource,estate_id}'=estate::text,'unstarted intake assigned');
 response:=pg_temp.manage('engagement.assign','00000000-0000-4000-8000-000000000041',jsonb_build_object('estateId',estate,'confirmed',true));
 perform pg_temp.ok(response->>'error'='already_assigned','cannot reinterpret existing scope');
 insert into public.connector_descriptors(id,slug,version,transport,target_binding,manifest)
 values ('00000000-0000-4000-8000-000000000051','management-test','1','sql','sandbox','{}');
 insert into public.connectors(tenant_id,system_id,descriptor_id,target_binding,name,endpoint_ref,status,assurance)
 values ('00000000-0000-4000-8000-000000000011',system,'00000000-0000-4000-8000-000000000051','sandbox','Archive guard','fixture','active','high');
 response:=pg_temp.manage('estate.update',estate,'{"name":"Blocked","status":"archived","expectedVersion":1}');
 perform pg_temp.ok(response->>'error'='active_connectors','estate with active connector cannot archive');
 response:=pg_temp.manage('system.update',system,'{"name":"Blocked","systemKind":"saas","dataCategories":[],"status":"archived","expectedVersion":3}');
 perform pg_temp.ok(response->>'error'='active_connectors','system with active connector cannot archive');
 update public.connectors set status='disabled' where system_id=system;
 response:=pg_temp.manage('estate.update',estate,'{"name":"Archived","status":"archived","expectedVersion":1}');
 perform pg_temp.ok(response#>>'{resource,status}'='archived','estate archived');
 response:=pg_temp.manage('system.create',estate,'{"name":"Late","systemKind":"other","dataCategories":[]}');
 perform pg_temp.ok(response->>'error'='estate_archived','archived estate refuses new inventory');
 -- Audit write failure must roll back inventory, not leave an unaudited mutation.
 begin
   perform public.manage_estate('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001','estate.create',null,'{"slug":"must-rollback","name":"Rollback"}',null);
   raise exception 'null correlation should fail';
 exception when not_null_violation then null;
 end;
 perform pg_temp.ok(not exists(select 1 from public.estates where slug='must-rollback'),'audit failure rolled back estate');
end $$;
reset role;
update public.tenant_users set role='axiom_analyst';
set local role service_role;
select pg_temp.ok(pg_temp.manage('estate.create',null,'{"slug":"forbidden","name":"No"}')->>'error'='forbidden','analyst cannot modify live estate');
reset role;
select pg_temp.ok(not has_function_privilege('authenticated','public.manage_estate(uuid,uuid,text,uuid,jsonb,uuid)','execute'),'browser cannot bypass BFF');
rollback;
