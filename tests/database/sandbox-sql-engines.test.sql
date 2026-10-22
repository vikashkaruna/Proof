-- STAGED/UNEXECUTED alone: the runner composes this after the 0163 sandbox
-- suite (without its final rollback) so the same custody fixture is reused.
-- 0182 framework: the same sandbox authority serves the MySQL and MariaDB
-- plug-ins, and nothing else. Each engine gets its own descriptor, connector,
-- grant and enrollment under the one active custody policy.
create function pg_temp.engine_id(engine int,n int) returns uuid language sql immutable as $$select ('6363'||lpad(engine::text,4,'0')||'-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.enroll_engine(engine int,target text) returns void language plpgsql as $$
declare reviewed text;
begin
 insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) values(pg_temp.engine_id(engine,4),pg_temp.pg_id(1),pg_temp.pg_id(3),target||' disposable','database');
 insert into public.connector_descriptors(id,slug,version,transport,target_binding,manifest) values(pg_temp.engine_id(engine,5),target||'-sandbox','1','sql','sandbox',jsonb_build_object('auth','legacy_static','target',target));
 insert into public.connectors(id,tenant_id,system_id,descriptor_id,target_binding,name,endpoint_ref,assurance,status) values(pg_temp.engine_id(engine,6),pg_temp.pg_id(1),pg_temp.engine_id(engine,4),pg_temp.engine_id(engine,5),'sandbox',target,'disposable_'||target,'low','active');
 insert into public.connector_grants(id,tenant_id,connector_id,workload_identity_id,agent_name,internal_scope,target_scopes,expires_at) values(pg_temp.engine_id(engine,8),pg_temp.pg_id(1),pg_temp.engine_id(engine,6),pg_temp.pg_id(7),'drishti','connector.read','{sql.enumerate,sql.sample}',clock_timestamp()+interval '1 hour');
 select content_sha256 into reviewed from public.connector_descriptors where id=pg_temp.engine_id(engine,5);
 set local role axiom_sandbox_connector_operator;
 insert into public.postgresql_sandbox_deployments values(repeat('e',64),pg_temp.pg_id(1),pg_temp.engine_id(engine,6),reviewed,'disposable_'||target,'local',true,pg_temp.pg_id(9),'99143000-0000-4000-8000-000000000021',1,clock_timestamp()+interval '20 minutes',null);
 reset role;
end$$;
create function pg_temp.resolve_engine(engine int,operation text default null) returns jsonb language sql as $$
 select case when operation is null
  then public.resolve_sandbox_postgresql_read_grant(pg_temp.pg_id(1),pg_temp.pg_id(3),pg_temp.engine_id(engine,6),'spiffe://local.axiomproof.test/agent/drishti',repeat('e',64))
  else public.resolve_sandbox_postgresql_read_grant_for_operation(pg_temp.pg_id(1),pg_temp.pg_id(3),pg_temp.engine_id(engine,6),'spiffe://local.axiomproof.test/agent/drishti',repeat('e',64),operation) end
$$;
select pg_temp.enroll_engine(1,'mysql');
select pg_temp.enroll_engine(2,'mariadb');
select pg_temp.enroll_engine(3,'oracle');
set local role service_role;
select pg_temp.ok(pg_temp.resolve_engine(1)->>'targetBinding'='sandbox','MySQL sandbox enrollment admitted');
select pg_temp.ok(pg_temp.resolve_engine(2)->>'targetBinding'='sandbox','MariaDB sandbox enrollment admitted');
select pg_temp.ok(pg_temp.resolve_engine(2,'sample') is not null,'MariaDB operation-scoped sample admitted');
select pg_temp.ok(pg_temp.resolve_engine(3) is null,'a target without a plug-in is refused');
reset role;
select pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.pg_id(1) and detail->>'deployment_kind'='local_synthetic_mysql'),'MySQL enrollment receipt names its engine');
select pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.pg_id(1) and detail->>'deployment_kind'='local_synthetic_mariadb'),'MariaDB enrollment receipt names its engine');
select pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.pg_id(1) and detail->>'deployment_kind'='local_synthetic_unknown'),'an unknown engine is never labelled as a supported one');
update public.tenants set is_demo=false where id=pg_temp.pg_id(1);
set local role service_role;
select pg_temp.ok(pg_temp.resolve_engine(1) is null and pg_temp.resolve_engine(2) is null,'demo flag removal refuses every engine');
reset role;
update public.tenants set is_demo=true where id=pg_temp.pg_id(1);
update public.connector_grants set target_scopes='{sql.enumerate}' where id=pg_temp.engine_id(1,8);
set local role service_role;
select pg_temp.ok(pg_temp.resolve_engine(1,'enumerate') is not null and pg_temp.resolve_engine(1,'sample') is null,'MySQL grant scopes stay operation-bound');
reset role;
rollback;
