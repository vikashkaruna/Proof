-- 0183 signed-in website checks: web descriptors, append-only receipts with
-- ledger entries, constrained human writer and tenant/connector authority.
begin;
create function pg_temp.id(n int) returns uuid language sql immutable as $$select ('99183000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m;end if;end$$;
create function pg_temp.refused(sql text,code text,m text) returns void language plpgsql as $$
begin
 begin execute sql; exception when others then
  if sqlstate=code then return; end if;
  raise exception 'ASSERTION: % (expected %, got % %)',m,code,sqlstate,sqlerrm;
 end;
 raise exception 'ASSERTION: % (statement succeeded)',m;
end$$;
insert into auth.users(id,email) select pg_temp.id(n),'web-'||n||'@example.invalid' from generate_series(1,3) n;
insert into public.users(id,email) select pg_temp.id(n),'web-'||n||'@example.invalid' from generate_series(1,3) n;
insert into public.tenants(id,slug,name) values(pg_temp.id(10),'web-183-a','Synthetic web A'),(pg_temp.id(11),'web-183-b','Synthetic web B');
insert into public.tenant_users(tenant_id,user_id,role) values
 (pg_temp.id(10),pg_temp.id(1),'owner'),(pg_temp.id(10),pg_temp.id(2),'viewer'),(pg_temp.id(11),pg_temp.id(3),'owner');
insert into public.estates(id,tenant_id,slug,name) values(pg_temp.id(20),pg_temp.id(10),'web','Web estate');
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) values(pg_temp.id(21),pg_temp.id(10),pg_temp.id(20),'Portal','application');

-- The transport constraint admits web descriptors and still refuses unknown transports.
insert into public.connector_descriptors(id,slug,version,transport,target_binding,manifest) values
 (pg_temp.id(30),'website-authenticated','1.0.0','web','sandbox','{"auth":"legacy_static","target":"website-authenticated"}'),
 (pg_temp.id(31),'mariadb','1.0.0','sql','sandbox','{"auth":"legacy_static","target":"mariadb"}');
select pg_temp.refused($$insert into public.connector_descriptors(id,slug,version,transport,target_binding,manifest)
 values(pg_temp.id(32),'ftp','1.0.0','ftp','sandbox','{}')$$,'23514','unknown transport refused');
insert into public.connectors(id,tenant_id,system_id,descriptor_id,target_binding,name,endpoint_ref,assurance,status) values
 (pg_temp.id(40),pg_temp.id(10),pg_temp.id(21),pg_temp.id(30),'sandbox','Portal','portal_web','low','active'),
 (pg_temp.id(41),pg_temp.id(10),pg_temp.id(21),pg_temp.id(31),'sandbox','DB','portal_db','low','active'),
 (pg_temp.id(42),pg_temp.id(10),pg_temp.id(21),pg_temp.id(30),'sandbox','Old portal','old_portal','low','disabled');

create function pg_temp.result() returns jsonb language sql as $$select jsonb_build_object(
 'version','authenticated-website-scan/1','baseUrl','http://axiom-portal-a:8080','authMode','form_login',
 'checkedAt','2026-10-22T11:00:00Z','pages',jsonb_build_array(jsonb_build_object('path','/account','depth',0,
 'contentSha256',repeat('a',64),'forms','[]'::jsonb)),'skipped','[]'::jsonb,'evidence','{}'::jsonb)$$;
create function pg_temp.record(actor int,connector int,correlation int,status text,result jsonb,code text) returns jsonb
language plpgsql as $$declare v jsonb;prior text:=current_user;begin
 set local role human_action_writer;
 v:=public.record_authenticated_website_check(pg_temp.id(10),pg_temp.id(actor),pg_temp.id(connector),pg_temp.id(correlation),
  'http://axiom-portal-a:8080',status,result,code);
 execute format('set local role %I',prior);return v;
exception when others then execute format('set local role %I',prior);raise;end$$;

select count(*) as ledger_before from public.audit_ledger where tenant_id=pg_temp.id(10) \gset
select pg_temp.ok((pg_temp.record(1,40,60,'checked',pg_temp.result(),null))->>'status'='checked','owner records a checked scan');
select pg_temp.ok((pg_temp.record(1,40,61,'failed',null,'login_failed'))->>'error_code'='login_failed','owner records a failure');
select pg_temp.ok((select count(*) from public.audit_ledger where tenant_id=pg_temp.id(10))=:ledger_before+2,'each outcome has one ledger receipt');
select pg_temp.ok((select count(*)=2 from public.audit_ledger where tenant_id=pg_temp.id(10)
 and action_type='connector.website.checked' and detail->>'kind'='authenticated_website'),'receipts name the signed-in kind');
select pg_temp.refused($$select pg_temp.record(2,40,62,'checked',pg_temp.result(),null)$$,'42501','viewer cannot record');
select pg_temp.refused($$select pg_temp.record(3,40,63,'checked',pg_temp.result(),null)$$,'42501','foreign owner cannot record');
select pg_temp.refused($$select pg_temp.record(1,41,64,'checked',pg_temp.result(),null)$$,'42501','a SQL connector cannot carry a website check');
select pg_temp.refused($$select pg_temp.record(1,42,65,'checked',pg_temp.result(),null)$$,'42501','a disabled website connector cannot carry a check');
select pg_temp.refused($$select pg_temp.record(1,40,66,'checked',pg_temp.result()-'evidence',null)$$,'23514','incomplete result refused');
select pg_temp.refused($$select pg_temp.record(1,40,67,'checked',jsonb_set(pg_temp.result(),'{baseUrl}','"http://other"'),null)$$,'23514','result bound to its base URL');
select pg_temp.refused($$select pg_temp.record(1,40,68,'failed',pg_temp.result(),'x')$$,'23514','a failure carries no result');
select pg_temp.refused($$select pg_temp.record(1,40,60,'checked',pg_temp.result(),null)$$,'23505','an operation key records once');
select pg_temp.refused($$update public.authenticated_website_checks set error_code='changed'$$,'42501','receipts are immutable');
select pg_temp.refused($$delete from public.authenticated_website_checks$$,'42501','receipts cannot be deleted');
select pg_temp.ok(not has_table_privilege('authenticated','public.authenticated_website_checks','SELECT'),'browsers read only through the BFF');
select pg_temp.ok(not has_table_privilege('human_action_writer','public.authenticated_website_checks','INSERT'),'writer inserts only through the function');
select pg_temp.ok(not has_function_privilege('service_role','public.record_authenticated_website_check(uuid,uuid,uuid,uuid,text,text,jsonb,text)','EXECUTE'),'service role cannot record a human check');
rollback;
