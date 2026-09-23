begin;
create function pg_temp.id(n int) returns uuid language sql immutable as $$select ('72720000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m; end if; end$$;
create function pg_temp.reject(q text) returns void language plpgsql as $$begin begin execute q; exception when insufficient_privilege then return; end; raise exception 'Unexpected success: %',q; end$$;
insert into public.tenants(id,slug,name) values(pg_temp.id(1),'controller-scope-a','Scope A'),(pg_temp.id(2),'controller-scope-b','Scope B');
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status)
 values(pg_temp.id(11),pg_temp.id(1),'parikshan','spiffe://scope.test/agent/parikshan','active'),(pg_temp.id(12),pg_temp.id(2),'parikshan','spiffe://scope.test/agent/parikshan','active');
insert into controller_security.credentials(id,tenant_id,expires_at) values(pg_temp.id(3),pg_temp.id(1),now()+interval '1 hour');
select set_config('request.jwt.claims',jsonb_build_object('role','axiom_assessment_controller','sub',pg_temp.id(3),'tenant_id',pg_temp.id(1),'iat',floor(extract(epoch from now())),'exp',floor(extract(epoch from now()))+1800)::text,true);
set local role axiom_assessment_controller;
select pg_temp.ok(public.current_assessment_controller_tenant()=pg_temp.id(1),'effective tenant');
select pg_temp.ok((select count(id)=1 from public.workload_identities),'RLS scopes unfiltered reads');
select pg_temp.ok((select count(id)=0 from public.workload_identities where tenant_id=pg_temp.id(2)),'foreign read hidden');
select pg_temp.reject('select * from public.workload_identities');
select pg_temp.reject('select ciphertext from public.assessment_dispatch_jobs');
select pg_temp.reject('select * from controller_security.credentials');
select pg_temp.reject('select * from public.users');
select pg_temp.reject('update public.workload_identities set status=''disabled''');
select pg_temp.reject('delete from public.assessment_dispatch_jobs');
select pg_temp.reject('select controller_security.confirm_workload_assessment(pg_temp.id(1),pg_temp.id(9))');
select pg_temp.reject('select public.confirm_workload_assessment(pg_temp.id(2),pg_temp.id(9))');
select pg_temp.reject('select public.claim_assessment_dispatch(pg_temp.id(2),pg_temp.id(9))');
select pg_temp.reject('select public.reserve_assessment_schedules(''test'')');
select pg_temp.reject('select public.reserve_assessment_schedules(''test'',pg_temp.id(2))');
select pg_temp.reject('select public.acknowledge_assessment_schedule(pg_temp.id(2),pg_temp.id(9),pg_temp.id(9),''test'',''test'',pg_temp.id(9))');
select pg_temp.reject('select public.read_workload_task(pg_temp.id(2),pg_temp.id(9),pg_temp.id(9),''parikshan'',''proof'',''findings.write'')');
select pg_temp.reject('select public.start_workload_assessment(pg_temp.id(2),pg_temp.id(9),pg_temp.id(9),''proof'',''input'',now())');
select pg_temp.reject('select public.complete_workload_assessment(pg_temp.id(2),pg_temp.id(9),pg_temp.id(9),''proof'',''digest'',''{}''::jsonb,now())');
select pg_temp.ok(public.confirm_workload_assessment(pg_temp.id(1),pg_temp.id(9))->>'error'='confirmation_unavailable','own RPC reaches existing validation');
select pg_temp.ok(public.reserve_assessment_schedules('test',pg_temp.id(1))->'jobs'='[]'::jsonb,'own reserve no authority creation');
-- Exhaustive public function ACL surface: no future privilege widening hidden
-- by negative tests for only a few administrative functions.
select pg_temp.ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.prosecdef and has_function_privilege(current_user,p.oid,'EXECUTE')
 and p.proname not in ('has_tenant_role','current_assessment_controller_tenant','read_workload_task','start_workload_assessment',
 'complete_workload_assessment','confirm_workload_assessment','claim_assessment_dispatch','reserve_assessment_schedules','acknowledge_assessment_schedule')),'no additional definer authority');
reset role;
create temporary table controller_original_claims as select current_setting('request.jwt.claims') claims;
-- Invalid time/subject/role claims fail closed, even before signature-layer tests.
select set_config('request.jwt.claims',jsonb_set(claims::jsonb,'{exp}',to_jsonb(floor(extract(epoch from now()))-1))::text,true) from controller_original_claims;
set local role axiom_assessment_controller;
select pg_temp.ok(public.current_assessment_controller_tenant() is null,'expired bearer refused');
reset role;
select set_config('request.jwt.claims',jsonb_set(claims::jsonb,'{exp}',to_jsonb(floor(extract(epoch from now()))+7200))::text,true) from controller_original_claims;
set local role axiom_assessment_controller;
select pg_temp.ok(public.current_assessment_controller_tenant() is null,'excessive bearer lifetime refused');
reset role;
select set_config('request.jwt.claims',jsonb_set(claims::jsonb,'{sub}','"malformed"')::text,true) from controller_original_claims;
set local role axiom_assessment_controller;
select pg_temp.ok(public.current_assessment_controller_tenant() is null,'malformed subject refused');
reset role;
select set_config('request.jwt.claims',jsonb_set(claims::jsonb,'{role}','"service_role"')::text,true) from controller_original_claims;
set local role axiom_assessment_controller;
select pg_temp.ok(public.current_assessment_controller_tenant() is null,'claimed role alone insufficient');
reset role;
select set_config('request.jwt.claims',claims,true) from controller_original_claims;
update controller_security.credentials set created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' where id=pg_temp.id(3);
set local role axiom_assessment_controller;
select pg_temp.ok(public.current_assessment_controller_tenant() is null,'expired registration refused');
reset role;
update controller_security.credentials set created_at=now(),expires_at=now()+interval '1 hour' where id=pg_temp.id(3);
update controller_security.credentials set revoked_at=now() where id=pg_temp.id(3);
set local role axiom_assessment_controller;
select pg_temp.ok(public.current_assessment_controller_tenant() is null,'revoked immediately');
select pg_temp.ok((select count(id)=0 from public.workload_identities),'revoked RLS empty');
select pg_temp.reject('select public.confirm_workload_assessment(pg_temp.id(1),pg_temp.id(9))');
reset role;
update controller_security.credentials set revoked_at=null where id=pg_temp.id(3);
select set_config('request.jwt.claims',jsonb_set(current_setting('request.jwt.claims')::jsonb,'{tenant_id}',to_jsonb(pg_temp.id(2)))::text,true);
set local role axiom_assessment_controller;
select pg_temp.ok(public.current_assessment_controller_tenant() is null,'foreign signed claim cannot change registration');
reset role;
set local role service_role;
select pg_temp.reject('select * from controller_security.credentials');
select pg_temp.ok(public.confirm_workload_assessment(pg_temp.id(2),pg_temp.id(9))->>'error'='confirmation_unavailable','backend retains prior behavior');
rollback;
