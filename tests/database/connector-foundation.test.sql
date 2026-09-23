begin;
create function pg_temp.id(n int) returns uuid language sql immutable as $$select ('c0000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m; end if; end$$;
create function pg_temp.reject(q text,code text) returns void language plpgsql as $$
begin begin execute q; exception when others then if sqlstate=code then return; end if; raise; end; raise exception 'Unexpected success: %',q; end$$;
insert into auth.users(id,email) values(pg_temp.id(1),'connector-a@test.invalid');
insert into public.users(id,email) values(pg_temp.id(1),'connector-a@test.invalid');
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'conn-a','A'),(pg_temp.id(12),'conn-b','B');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(1),'axiom_analyst');
insert into public.estates(id,tenant_id,slug,name) values(pg_temp.id(21),pg_temp.id(11),'prod','A'),(pg_temp.id(22),pg_temp.id(12),'prod','B');
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) values(pg_temp.id(31),pg_temp.id(11),pg_temp.id(21),'A','database'),(pg_temp.id(32),pg_temp.id(12),pg_temp.id(22),'B','database');
-- Disposable administrator fixture; identity mutations are separately gated.
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id) values
 (pg_temp.id(61),pg_temp.id(11),'drishti','spiffe://test/agent/drishti'),
 (pg_temp.id(62),pg_temp.id(12),'karya','spiffe://test/agent/karya'),
 (pg_temp.id(63),pg_temp.id(11),'sudhaar','spiffe://test/agent/sudhaar');
set local role service_role;
select pg_temp.ok((select not rolbypassrls from pg_roles where rolname=current_user),'service has no bypass');
insert into public.connector_descriptors(id,slug,version,transport,target_binding,manifest) values(pg_temp.id(40),'postgres','1','sql','sandbox','{"read":"catalogue"}');
insert into public.connectors(id,tenant_id,system_id,descriptor_id,target_binding,name,endpoint_ref,assurance) values
 (pg_temp.id(51),pg_temp.id(11),pg_temp.id(31),pg_temp.id(40),'sandbox','A','fixture-a','high'),
 (pg_temp.id(52),pg_temp.id(12),pg_temp.id(32),pg_temp.id(40),'sandbox','B','fixture-b','high');
insert into public.connector_credentials(tenant_id,connector_id,grant_type,key_ref,algorithm,nonce,ciphertext,wrapped_data_key)
 select tenant_id,id,'cloud_iam','fixture-key','aes-256-gcm',decode(repeat('aa',12),'hex'),decode(repeat('bb',32),'hex'),decode('cc','hex') from public.connectors;
insert into public.connector_grants(tenant_id,connector_id,workload_identity_id,agent_name,internal_scope,expires_at) values
 (pg_temp.id(11),pg_temp.id(51),pg_temp.id(61),'drishti','connector.read',now()+interval '1 hour'),
 (pg_temp.id(12),pg_temp.id(52),pg_temp.id(62),'karya','connector.write',now()+interval '1 hour');
insert into public.connector_health_checks(tenant_id,connector_id,status,latency_ms) select tenant_id,id,'healthy',1 from public.connectors;
insert into public.mcp_tool_registry(tenant_id,connector_id,tool_name,tool_version,operation_class,description,input_schema)
 select tenant_id,id,'list','1','read','List metadata','{}' from public.connectors;
select pg_temp.ok((select count(*)=2 from public.connector_credentials),'broker can read both encrypted envelopes without BYPASSRLS');
select pg_temp.ok((select content_sha256=encode(sha256(convert_to(manifest::text,'UTF8')),'hex') from public.connector_descriptors limit 1),'stored manifest is hash pinned');
select pg_temp.ok((select bool_and(description_sha256=encode(sha256(convert_to(description,'UTF8')),'hex')) from public.mcp_tool_registry),'tool descriptions are hash pinned');
-- Tenant consistency holds even for privileged writers.
select pg_temp.reject('update public.connectors set system_id=pg_temp.id(32) where id=pg_temp.id(51)','23503');
select pg_temp.reject('update public.connector_credentials set connector_id=pg_temp.id(52) where tenant_id=pg_temp.id(11)','23503');
select pg_temp.reject('update public.connector_grants set connector_id=pg_temp.id(52) where tenant_id=pg_temp.id(11)','23503');
select pg_temp.reject('update public.connector_grants set workload_identity_id=pg_temp.id(62) where tenant_id=pg_temp.id(11)','23503');
select pg_temp.reject($q$update public.connector_grants set agent_name='karya',internal_scope='connector.write' where tenant_id=pg_temp.id(11)$q$,'23503');
select pg_temp.reject($q$update public.connector_grants set internal_scope='connector.write' where tenant_id=pg_temp.id(11)$q$,'23514');
select pg_temp.reject($q$update public.connector_grants set agent_name='sudhaar',workload_identity_id=pg_temp.id(63),internal_scope='connector.write' where tenant_id=pg_temp.id(11)$q$,'23514');
select pg_temp.reject('update public.connector_grants set expires_at=created_at','23514');
select pg_temp.reject($q$update public.connectors set target_binding='production' where id=pg_temp.id(51)$q$,'23503');
select pg_temp.reject($q$update public.connector_credentials set nonce=decode('aa','hex')$q$,'23514');
select pg_temp.reject($q$insert into public.connector_health_checks(tenant_id,connector_id,status) values(pg_temp.id(11),pg_temp.id(52),'healthy')$q$,'23503');
select pg_temp.reject($q$insert into public.mcp_tool_registry(tenant_id,connector_id,tool_name,tool_version,operation_class,description,input_schema) values(pg_temp.id(11),pg_temp.id(52),'list','2','read','metadata','{}')$q$,'23503');
select pg_temp.reject($q$insert into public.mcp_tool_registry(tenant_id,connector_id,tool_name,tool_version,operation_class,description,input_schema) values(pg_temp.id(11),pg_temp.id(51),'unknown','1','unclassified','metadata','{}')$q$,'23514');
select pg_temp.reject('delete from public.connectors where id=pg_temp.id(51)','23503');
select pg_temp.reject($q$update public.connector_descriptors set manifest='{}'$q$,'42501');
select pg_temp.reject('delete from public.mcp_tool_registry','42501');
select pg_temp.reject('update public.connector_health_checks set latency_ms=2','42501');
reset role;
set local role authenticated;
set local request.jwt.claims='{"sub":"c0000000-0000-4000-8000-000000000001","role":"authenticated","tenant_id":"c0000000-0000-4000-8000-000000000012"}';
select pg_temp.ok((select count(*)=1 from public.connectors),'forged tenant selection cannot expose connector B');
select pg_temp.ok((select count(*)=2 from public.workload_identities),'only assigned tenant workloads');
select pg_temp.ok((select count(*)=1 from public.connector_grants),'only assigned tenant grants');
select pg_temp.ok((select count(*)=1 from public.connector_health_checks),'only assigned tenant health');
select pg_temp.ok((select count(*)=1 from public.mcp_tool_registry),'only assigned tenant tools');
select pg_temp.ok((select count(*)=1 from public.connector_descriptors),'public non-secret descriptor catalogue readable');
select pg_temp.reject('select * from public.connector_credentials','42501');
select pg_temp.reject($q$update public.connectors set status='active'$q$,'42501');
select pg_temp.reject('delete from public.connector_grants','42501');
select pg_temp.reject('truncate public.connector_descriptors','42501');
select pg_temp.reject($q$insert into public.connector_health_checks(tenant_id,connector_id,status) values(pg_temp.id(11),pg_temp.id(51),'healthy')$q$,'42501');
set local request.jwt.claims='{"sub":"c0000000-0000-4000-8000-000000000001","role":"authenticated"}';
select pg_temp.ok((select count(*)=1 from public.connectors),'membership, not tenant claim, controls visibility');
reset role;
delete from public.tenant_users where user_id=pg_temp.id(1);
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.connectors),'membership revocation removes access');
select pg_temp.ok((select count(*)=0 from public.connector_grants),'membership revocation hides grants');
reset role;
set local role anon;
select pg_temp.reject('select * from public.connector_descriptors','42501');
select pg_temp.reject('select * from public.connectors','42501');
select pg_temp.reject('select * from public.connector_credentials','42501');
reset role;
rollback;
