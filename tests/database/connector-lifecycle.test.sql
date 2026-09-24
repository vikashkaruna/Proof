begin;
create function pg_temp.ok(value boolean,message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end $$;
insert into auth.users(id,email) values ('41410000-0000-4000-8000-000000000011','connector@test.invalid');
insert into public.users(id,email) values ('41410000-0000-4000-8000-000000000011','connector@test.invalid');
insert into public.tenants(id,slug,name) values ('41410000-0000-4000-8000-000000000021','connector-lifecycle','Lifecycle'),('41410000-0000-4000-8000-000000000022','connector-foreign','Foreign');
insert into public.tenant_users(tenant_id,user_id,role) values ('41410000-0000-4000-8000-000000000021','41410000-0000-4000-8000-000000000011','admin');
insert into public.estates(id,tenant_id,slug,name) values ('41410000-0000-4000-8000-000000000031','41410000-0000-4000-8000-000000000021','estate','Estate');
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) values ('41410000-0000-4000-8000-000000000041','41410000-0000-4000-8000-000000000021','41410000-0000-4000-8000-000000000031','CRM','database');
create function pg_temp.descriptor() returns jsonb language sql as $$ select '{"schemaVersion":1,"id":"41410000-0000-4000-8000-000000000001","target":"postgresql","version":"1.0.0","transport":"sql","targetBinding":"production","assurance":"high","auth":"cloud_iam","capabilities":{"enumerate":{"operation":"sql.enumerate","mutating":false}},"dataCategoryHints":[],"rateLimit":{"requestsPerSecond":5,"burst":10}}'::jsonb $$;
create function pg_temp.manage(op text,id uuid,body jsonb) returns jsonb language sql as $$
 select public.manage_connector('41410000-0000-4000-8000-000000000021','41410000-0000-4000-8000-000000000011',op,id,body,pg_temp.descriptor(),gen_random_uuid()); $$;
-- Disposable administrator fixture; not a service-role write path.
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id) values('41410000-0000-4000-8000-000000000061','41410000-0000-4000-8000-000000000021','drishti','spiffe://test/drishti');
set local role service_role;
do $$
declare c uuid; result jsonb; events bigint; identity_id uuid;
 payload jsonb:='{"systemId":"41410000-0000-4000-8000-000000000041","descriptorId":"41410000-0000-4000-8000-000000000001","name":"Primary","endpointRef":"primary_crm"}';
begin
 result:=pg_temp.manage('create',null,payload);c:=(result#>>'{resource,id}')::uuid;
 perform pg_temp.ok(c is not null and result#>>'{resource,status}'='draft','registration starts draft');
 perform pg_temp.ok((select content_sha256=public.connector_content_sha256(manifest::text) from public.connector_descriptors where id='41410000-0000-4000-8000-000000000001'),'descriptor pinned to stored content');
 result:=pg_temp.manage('transition',c,'{"expectedVersion":1,"status":"active"}');
 perform pg_temp.ok(result#>>'{resource,version}'='2','enable increments version');
 perform pg_temp.ok(pg_temp.manage('edit',c,'{"expectedVersion":2,"name":"Changed","endpointRef":"new_ref"}')->>'error'='disable_before_edit','active configuration cannot change');
 perform pg_temp.ok(pg_temp.manage('transition',c,'{"expectedVersion":2,"status":"archived"}')->>'error'='invalid_transition','disable before archive');
 result:=public.manage_estate('41410000-0000-4000-8000-000000000021','41410000-0000-4000-8000-000000000011','estate.update','41410000-0000-4000-8000-000000000031','{"expectedVersion":1,"name":"Estate","status":"archived"}',gen_random_uuid());
 perform pg_temp.ok(result->>'error'='active_connectors','enabled registration blocks parent archive');
 identity_id:='41410000-0000-4000-8000-000000000061';
 insert into public.connector_grants(tenant_id,connector_id,workload_identity_id,agent_name,internal_scope,expires_at) values ('41410000-0000-4000-8000-000000000021',c,identity_id,'drishti','connector.read',now()+interval '1 hour');
 insert into public.connector_credentials(tenant_id,connector_id,grant_type,key_ref,algorithm,nonce,ciphertext,wrapped_data_key) values ('41410000-0000-4000-8000-000000000021',c,'cloud_iam','fixture','aes-256-gcm',decode(repeat('00',12),'hex'),decode(repeat('00',32),'hex'),decode('00','hex'));
 begin
  perform public.manage_connector('41410000-0000-4000-8000-000000000021','41410000-0000-4000-8000-000000000011','transition',c,'{"expectedVersion":2,"status":"disabled"}',pg_temp.descriptor(),null);
  raise exception 'audit failure should throw';
 exception when not_null_violation then null; end;
 perform pg_temp.ok((select status='active' and version=2 from public.connectors where id=c),'audit failure rolls disable back');
 perform pg_temp.ok((select bool_and(revoked_at is null) from public.connector_grants where connector_id=c),'audit failure rolls grant revocation back');
 result:=pg_temp.manage('transition',c,'{"expectedVersion":2,"status":"disabled"}');
 perform pg_temp.ok(result#>>'{resource,status}'='disabled','disable succeeds');
 perform pg_temp.ok((select bool_and(revoked_at is not null) from public.connector_grants where connector_id=c),'disable revokes grants');
 select count(*) into events from public.audit_ledger;
 perform pg_temp.ok(pg_temp.manage('transition',c,'{"expectedVersion":2,"status":"active"}')->>'error'='version_conflict','stale mutation refused');
 perform pg_temp.ok((select count(*)=events from public.audit_ledger),'refusals produce no success event');
 result:=pg_temp.manage('transition',c,'{"expectedVersion":3,"status":"active"}');
 perform pg_temp.ok(result#>>'{resource,status}'='active','reenable succeeds');
 perform pg_temp.ok((select bool_and(revoked_at is not null) from public.connector_grants where connector_id=c),'reenable cannot revive grants');
 result:=pg_temp.manage('transition',c,'{"expectedVersion":4,"status":"disabled"}');
 result:=public.manage_estate('41410000-0000-4000-8000-000000000021','41410000-0000-4000-8000-000000000011','estate.update','41410000-0000-4000-8000-000000000031','{"expectedVersion":1,"name":"Estate","status":"archived"}',gen_random_uuid());
 perform pg_temp.ok(result#>>'{resource,status}'='archived','inactive registration allows parent archive');
 perform pg_temp.ok(pg_temp.manage('transition',c,'{"expectedVersion":5,"status":"active"}')->>'error'='parent_archived','archived estate blocks reenable');
 perform pg_temp.ok(pg_temp.manage('create',null,payload)->>'error'='parent_archived','archived estate blocks registration');
 result:=pg_temp.manage('transition',c,'{"expectedVersion":5,"status":"archived"}');
 perform pg_temp.ok(result#>>'{resource,status}'='archived','can clean up under archived parent');
 perform pg_temp.ok((select bool_and(revoked_at is not null) from public.connector_credentials where connector_id=c),'archive revokes credentials');
 perform pg_temp.ok(pg_temp.manage('transition',c,'{"expectedVersion":6,"status":"active"}')->>'error'='invalid_transition','archive terminal');
 perform pg_temp.ok(pg_temp.manage('transition','41410000-0000-4000-8000-000000000022','{"expectedVersion":1,"status":"active"}')->>'error'='not_found','foreign id refused');
 result:=public.manage_estate('41410000-0000-4000-8000-000000000021','41410000-0000-4000-8000-000000000011','estate.update','41410000-0000-4000-8000-000000000031','{"expectedVersion":2,"name":"Estate","status":"active"}',gen_random_uuid());
 result:=public.manage_connector('41410000-0000-4000-8000-000000000021','41410000-0000-4000-8000-000000000011','create',null,payload,pg_temp.descriptor()||'{"auth":"legacy_static"}',gen_random_uuid());
 perform pg_temp.ok(result->>'error'='descriptor_conflict','existing descriptor cannot be republished with new contents');
 select count(*) into events from public.connectors;
 begin
  perform public.manage_connector('41410000-0000-4000-8000-000000000021','41410000-0000-4000-8000-000000000011','create',null,payload,pg_temp.descriptor(),null);
  raise exception 'audit failure should throw';
 exception when not_null_violation then null; end;
 perform pg_temp.ok((select count(*)=events from public.connectors),'audit failure rolls registration back');
end $$;
reset role;
update public.tenant_users set role='viewer' where tenant_id='41410000-0000-4000-8000-000000000021';
set local role service_role;
select pg_temp.ok(pg_temp.manage('create',null,'{}')->>'error'='forbidden','live demotion respected');
reset role;
select pg_temp.ok(not has_function_privilege('authenticated','public.manage_connector(uuid,uuid,text,uuid,jsonb,jsonb,uuid)','execute'),'browser cannot invoke lifecycle RPC');
rollback;
