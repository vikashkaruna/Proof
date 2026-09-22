begin;
create function pg_temp.id(n int) returns uuid language sql immutable as $$select ('47470000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m; end if; end$$;
create function pg_temp.reject(q text,code text) returns void language plpgsql as $$
begin begin execute q; exception when others then if sqlstate=code then return; end if; raise; end; raise exception 'Unexpected success'; end$$;
insert into auth.users(id,email) select pg_temp.id(n),'task-'||n||'@test.invalid' from generate_series(1,5) n;
insert into public.users(id,email,is_axiom_internal) select pg_temp.id(n),'task-'||n||'@test.invalid',n in (3,4) from generate_series(1,5) n;
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'task-a','A'),(pg_temp.id(12),'task-b','B');
insert into public.tenant_users(tenant_id,user_id,role) values
 (pg_temp.id(11),pg_temp.id(1),'owner'),(pg_temp.id(11),pg_temp.id(2),'admin'),
 (pg_temp.id(11),pg_temp.id(3),'axiom_analyst'),(pg_temp.id(11),pg_temp.id(4),'axiom_analyst'),(pg_temp.id(11),pg_temp.id(5),'viewer');
insert into public.estates(id,tenant_id,slug,name) values(pg_temp.id(21),pg_temp.id(11),'prod','A'),(pg_temp.id(22),pg_temp.id(12),'prod','B');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('task-test',now(),'test','synthetic task fixture',0);
insert into public.engagements(id,tenant_id,estate_id,library_version,title) values(pg_temp.id(31),pg_temp.id(11),pg_temp.id(21),'task-test','A');
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id) values
 (pg_temp.id(41),pg_temp.id(11),'drishti','spiffe://test/agent/drishti'),
 (pg_temp.id(42),pg_temp.id(12),'drishti','spiffe://test/agent/drishti'),
 (pg_temp.id(43),pg_temp.id(11),'lekha','spiffe://test/agent/lekha'),
 (pg_temp.id(44),pg_temp.id(11),'karya','spiffe://test/agent/karya');
update public.workload_identities set status='active' where tenant_id in (pg_temp.id(11),pg_temp.id(12));
create function pg_temp.issue(o jsonb default '{}') returns jsonb language sql as $$
 select public.delegate_workload_task(
 coalesce((o->>'tenant')::uuid,pg_temp.id(11)),coalesce((o->>'actor')::uuid,pg_temp.id(1)),
 coalesce((o->>'workload')::uuid,pg_temp.id(41)),coalesce(o->>'agent','drishti'),
 coalesce((o->>'estate')::uuid,pg_temp.id(21)),coalesce((o->>'engagement')::uuid,pg_temp.id(31)),
 pg_temp.id(51),repeat('b',64),coalesce(o->>'proof',repeat('a',64)),
 case when o?'scopes' then array(select jsonb_array_elements_text(o->'scopes')) else array['connector.read'] end,
 coalesce((o->>'expires')::timestamptz,clock_timestamp()+interval '5 minutes'))
$$;
create temp table issued(run_id uuid);
grant all on issued to service_role;
set local role service_role;
insert into issued select (pg_temp.issue()->>'run_id')::uuid;
select pg_temp.ok((select run_id is not null from issued),'owner can delegate');
select pg_temp.ok((select count(*)=1 from public.workload_task_delegations),'one delegation');
select pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type='workload.task_delegated'),'atomic delegation audit');
select pg_temp.ok((select detail::text not like '%proof%' from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type='workload.task_delegated'),'audit has no proof');
create function pg_temp.read_task() returns jsonb language sql as $$select public.read_workload_task(pg_temp.id(11),(select run_id from issued),pg_temp.id(41),'drishti',repeat('a',64),'connector.read')$$;
select pg_temp.ok(pg_temp.read_task()->>'estate_id'=pg_temp.id(21)::text,'authority has exact assigned estate');
select pg_temp.ok(not (pg_temp.read_task()?'proof_hash'),'lookup never returns stored proof hash');
select pg_temp.ok(public.read_workload_task(pg_temp.id(12),(select run_id from issued),pg_temp.id(41),'drishti',repeat('a',64),'connector.read') is null,'cross tenant refused');
select pg_temp.ok(public.read_workload_task(pg_temp.id(11),(select run_id from issued),pg_temp.id(42),'drishti',repeat('a',64),'connector.read') is null,'other workload refused');
select pg_temp.ok(public.read_workload_task(pg_temp.id(11),(select run_id from issued),pg_temp.id(41),'karya',repeat('a',64),'connector.read') is null,'other agent refused');
select pg_temp.ok(public.read_workload_task(pg_temp.id(11),(select run_id from issued),pg_temp.id(41),'drishti',repeat('c',64),'connector.read') is null,'run ID without matching proof refused');
select pg_temp.ok(public.read_workload_task(pg_temp.id(11),(select run_id from issued),pg_temp.id(41),'drishti',repeat('a',64),'connector.write') is null,'undelegated scope refused');
select pg_temp.ok(pg_temp.issue(jsonb_build_object('actor',pg_temp.id(5)))->>'error'='forbidden','viewer cannot delegate');
select pg_temp.ok(pg_temp.issue(jsonb_build_object('tenant',pg_temp.id(12)))->>'error'='forbidden','no membership cannot delegate');
select pg_temp.ok(pg_temp.issue(jsonb_build_object('workload',pg_temp.id(42)))->>'error'='workload_refused','cross tenant workload cannot delegate');
select pg_temp.ok(pg_temp.issue(jsonb_build_object('estate',pg_temp.id(22)))->>'error'='context_refused','cross tenant estate cannot delegate');
select pg_temp.ok(pg_temp.issue(jsonb_build_object('agent','karya','workload',pg_temp.id(44)))->>'error'='forbidden','Karya needs execution approval path');
select pg_temp.ok(pg_temp.issue(jsonb_build_object('agent','lekha','workload',pg_temp.id(43)))->>'error'='forbidden','owner cannot invoke internal agent');
select pg_temp.ok(pg_temp.issue(jsonb_build_object('expires',clock_timestamp()+interval '16 minutes'))->>'error'='invalid_delegation','excessive lifetime refused');
select pg_temp.ok(pg_temp.issue(jsonb_build_object('expires',clock_timestamp()-interval '1 second'))->>'error'='invalid_delegation','expired issuance refused');
select pg_temp.ok(pg_temp.issue('{"scopes":["connector.read","connector.read"]}')->>'error'='invalid_delegation','duplicate scopes refused');
select pg_temp.ok(pg_temp.issue('{"scopes":[null]}')->>'error'='invalid_delegation','null scope refused');
select pg_temp.ok(pg_temp.issue('{"proof":"invalid"}')->>'error'='invalid_delegation','malformed proof digest refused');
select pg_temp.reject('update public.workload_task_delegations set expires_at=now()+interval ''1 hour''','42501');
select pg_temp.reject('delete from public.workload_task_delegations','42501');
select pg_temp.reject('insert into public.workload_task_delegations select * from public.workload_task_delegations','42501');
reset role;
-- Each live authority source can independently remove access after issuance.
update public.tenant_users set role='viewer' where user_id=pg_temp.id(1);
select pg_temp.ok(pg_temp.read_task() is null,'initiator demotion immediately removes authority');
update public.tenant_users set role='owner' where user_id=pg_temp.id(1);
update public.workload_identities set status='disabled' where id=pg_temp.id(41);
select pg_temp.ok(pg_temp.read_task() is null,'disabled registration removes authority');
update public.workload_identities set status='active' where id=pg_temp.id(41);
update public.estates set status='archived' where id=pg_temp.id(21);
select pg_temp.ok(pg_temp.read_task() is null,'archived estate removes authority');
update public.estates set status='active' where id=pg_temp.id(21);
update public.engagements set status='cancelled' where id=pg_temp.id(31);
select pg_temp.ok(pg_temp.read_task() is null,'cancelled engagement removes authority');
update public.engagements set status='intake' where id=pg_temp.id(31);
update public.agent_runs set status='succeeded' where id=(select run_id from issued);
select pg_temp.ok(pg_temp.read_task() is null,'completed run removes authority');
update public.agent_runs set status='running',input_redacted_hash=repeat('c',64) where id=(select run_id from issued);
select pg_temp.ok(pg_temp.read_task() is null,'replaced run input removes authority');
update public.agent_runs set input_redacted_hash=repeat('b',64) where id=(select run_id from issued);
update public.kill_switch_state set engaged=true where scope_key='global';
select pg_temp.ok(pg_temp.read_task() is null,'global halt removes authority');
select pg_temp.ok(pg_temp.issue()->>'error'='halted','global halt prevents issuance');
update public.kill_switch_state set engaged=false where scope_key='global';
select pg_temp.ok(pg_temp.read_task() is not null,'all restored conditions permit assigned task');
savepoint tenant_halt_probe;
insert into public.kill_switch_state(scope_key,scope,tenant_id,engaged) values(pg_temp.id(11)::text,'tenant',pg_temp.id(11),true);
select pg_temp.ok(pg_temp.read_task() is null,'tenant halt removes task authority');
select pg_temp.ok(pg_temp.issue()->>'error'='halted','tenant halt prevents issuance');
rollback to tenant_halt_probe;
savepoint membership_probe;
delete from public.tenant_users where user_id=pg_temp.id(1);
select pg_temp.ok(pg_temp.read_task() is null,'removed membership removes task authority');
rollback to membership_probe;
savepoint completed_probe;
update public.agent_runs set completed_at=clock_timestamp() where id=(select run_id from issued);
select pg_temp.ok(pg_temp.read_task() is null,'completed timestamp blocks a stale running status');
rollback to completed_probe;
savepoint expiry_probe;
update public.workload_task_delegations set created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 minute';
select pg_temp.ok(pg_temp.read_task() is null,'expired task proof refused');
rollback to expiry_probe;
savepoint halt_probe;
delete from public.kill_switch_state where scope_key='global';
select pg_temp.ok(pg_temp.read_task() is null,'missing global halt state fails closed');
rollback to halt_probe;
-- Audit failure must undo run creation AND delegation/revocation, not just return failure.
create function pg_temp.fail_task_audit() returns trigger language plpgsql as $$begin if new.action_type in ('workload.task_delegated','workload.task_revoked') then raise exception 'synthetic audit unavailable'; end if; return new; end$$;
create trigger task_audit_failure before insert on public.audit_ledger for each row execute function pg_temp.fail_task_audit();
set local role service_role;
select pg_temp.reject($q$select pg_temp.issue('{"proof":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}')$q$,'P0001');
select pg_temp.reject('select public.revoke_workload_task(pg_temp.id(11),pg_temp.id(2),(select run_id from issued),pg_temp.id(51))','P0001');
select pg_temp.ok((select count(*)=1 from public.agent_runs where tenant_id=pg_temp.id(11)),'failed audit leaves no orphan run');
select pg_temp.ok((select count(*)=1 from public.workload_task_delegations),'failed audit leaves no delegation');
select pg_temp.ok(pg_temp.read_task() is not null,'failed revocation audit rolled back');
reset role;
drop trigger task_audit_failure on public.audit_ledger;
set local role service_role;
select pg_temp.ok(public.revoke_workload_task(pg_temp.id(11),pg_temp.id(5),(select run_id from issued),pg_temp.id(51))->>'error'='forbidden','viewer cannot revoke');
select pg_temp.ok(public.revoke_workload_task(pg_temp.id(11),pg_temp.id(3),(select run_id from issued),pg_temp.id(51))->>'error'='forbidden','analyst cannot revoke someone else task');
select pg_temp.ok(public.revoke_workload_task(pg_temp.id(11),pg_temp.id(2),(select run_id from issued),pg_temp.id(51))->>'revoked'='true','tenant admin can revoke');
select pg_temp.ok(pg_temp.read_task() is null,'revoked proof cannot be reused');
select pg_temp.ok(public.revoke_workload_task(pg_temp.id(11),pg_temp.id(2),(select run_id from issued),pg_temp.id(51))->>'revoked'='true','revocation idempotent');
select pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type='workload.task_revoked'),'no duplicate revocation audit');
reset role;
savepoint additional_issuers;
set local role service_role;
select pg_temp.ok(pg_temp.issue(jsonb_build_object('actor',pg_temp.id(2),'proof',repeat('e',64)))?'run_id','tenant admin can delegate');
select pg_temp.ok(pg_temp.issue(jsonb_build_object('actor',pg_temp.id(3),'agent','lekha','workload',pg_temp.id(43),'proof',repeat('f',64),'scopes',jsonb_build_array('ledger.read')))?'run_id','internal analyst can delegate internal agent');
reset role;
update public.users set is_axiom_internal=false where id=pg_temp.id(3);
select pg_temp.ok(public.read_workload_task(pg_temp.id(11),(select run_id from public.workload_task_delegations where proof_hash=repeat('f',64)),pg_temp.id(43),'lekha',repeat('f',64),'ledger.read') is null,'removed internal flag invalidates internal task');
rollback to additional_issuers;
-- Browser roles cannot read hashes, call any task RPC, or directly change state.
set local role authenticated;
select pg_temp.reject('select * from public.workload_task_delegations','42501');
select pg_temp.reject('select pg_temp.issue()','42501');
select pg_temp.reject('select public.read_workload_task(pg_temp.id(11),pg_temp.id(51),pg_temp.id(41),''drishti'',repeat(''a'',64),''connector.read'')','42501');
select pg_temp.reject('select public.revoke_workload_task(pg_temp.id(11),pg_temp.id(2),pg_temp.id(51),pg_temp.id(51))','42501');
reset role;
set local role anon;
select pg_temp.reject('select * from public.workload_task_delegations','42501');
select pg_temp.reject('select pg_temp.issue()','42501');
reset role;
rollback;
