begin;
create function pg_temp.id(n int) returns uuid language sql immutable as $$select ('76760000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m; end if; end$$;
create function pg_temp.reject(q text,code text) returns void language plpgsql as $$begin begin execute q; exception when others then if sqlstate=code then return; end if; raise; end; raise exception 'Unexpected success'; end$$;
insert into auth.users(id,email) values(pg_temp.id(1),'registration-lifecycle@test.invalid');
insert into public.users(id,email) values(pg_temp.id(1),'registration-lifecycle@test.invalid');
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'registration-lifecycle','Worker fixture');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(1),'owner');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('registration-lifecycle-v1',now(),'test','Synthetic fixture',2);
insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version)
 select 'WA-'||n,'registration-lifecycle-v1','Fixture','Fixture','SEC','low','[]','[]','[]','{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":1000000}','{}','registration-lifecycle-v1' from generate_series(1,2) n;
insert into public.estates(id,tenant_id,name,slug) values(pg_temp.id(22),pg_temp.id(11),'Synthetic estate','synthetic');
insert into public.engagements(id,tenant_id,estate_id,library_version,title) values(pg_temp.id(21),pg_temp.id(11),pg_temp.id(22),'registration-lifecycle-v1','New assessment');
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status)
 values(pg_temp.id(31),pg_temp.id(11),'parikshan','spiffe://axiom.test/agent/parikshan','active');
create temporary table issued as select (public.delegate_workload_task(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),'parikshan',pg_temp.id(22),pg_temp.id(21),pg_temp.id(41),repeat('a',64),repeat('b',64),array['control_library.read','findings.write'],clock_timestamp()+interval '10 minutes')->>'run_id')::uuid run_id;
grant select on issued to service_role;
create function pg_temp.start_tool(proof text default repeat('b',64),input_hash text default repeat('a',64),deadline timestamptz default clock_timestamp()+interval '5 minutes') returns jsonb language sql as $$
 select public.start_workload_assessment(pg_temp.id(11),(select run_id from issued),pg_temp.id(31),proof,input_hash,deadline)$$;
create function pg_temp.result() returns jsonb language sql immutable as $$select '{"library_version":"registration-lifecycle-v1","posture_score":50,"estimated_exposure_inr":10000000,"findings":[{"control_id":"WA-1","score":0,"risk_points":10,"rationale":"No answers comply"},{"control_id":"WA-2","score":100,"risk_points":0,"rationale":"All answers comply"}]}'::jsonb$$;
create function pg_temp.finish_tool(result jsonb default pg_temp.result(),deadline timestamptz default clock_timestamp()+interval '5 minutes') returns jsonb language sql as $$
 select public.complete_workload_assessment(pg_temp.id(11),(select run_id from issued),pg_temp.id(31),repeat('b',64),(select library_digest from public.workload_assessment_packets where run_id=(select run_id from issued)),result,deadline)$$;

create function pg_temp.manage(ver integer,state text,identity uuid default pg_temp.id(31),agent text default 'parikshan',subject text default 'spiffe://axiom.test/agent/parikshan',actor uuid default pg_temp.id(1)) returns jsonb language sql as $$
 select public.manage_workload_identity(pg_temp.id(11),actor,pg_temp.id(41),identity,ver,agent,subject,state) $$;
-- LIFECYCLE_FIXTURE_READY
set local role service_role;
select pg_temp.reject('update public.workload_identities set status=''disabled''','42501');
select pg_temp.reject('delete from public.workload_identities','42501');
select pg_temp.reject('insert into public.workload_identities(tenant_id,agent_name,spiffe_id) values(pg_temp.id(11),''parikshan'',''spiffe://test/agent/parikshan'')','42501');
select pg_temp.ok(pg_temp.manage(0,'active',pg_temp.id(32))->>'error'='registration_required','new identities cannot start active');
select pg_temp.ok(pg_temp.manage(0,'disabled',pg_temp.id(32),'drishti','spiffe://axiom.test/agent/karya')->>'error'='invalid_registration','agent-subject binding');
select pg_temp.ok(pg_temp.manage(0,'disabled',pg_temp.id(32),'drishti',E'spiffe://axiom.test/agent/drishti\n')->>'error'='invalid_registration','line endings refused');
select pg_temp.ok(pg_temp.manage(0,'disabled',pg_temp.id(32),'drishti','spiffe://axiom..test/agent/drishti')->>'error'='invalid_registration','noncanonical domain refused');
select pg_temp.ok(pg_temp.manage(0,'disabled',pg_temp.id(32),'drishti','spiffe://axiom.test/agent/drishti')->>'version'='1','reviewed disabled registration');
select pg_temp.ok(pg_temp.manage(0,'disabled',pg_temp.id(32),'drishti','spiffe://axiom.test/agent/drishti')->>'version'='1','lost creation reply recovers receipt');
select pg_temp.ok((select count(*)=1 from public.audit_ledger where action_type='workload.registration_changed'),'creation audit once');
select pg_temp.ok(pg_temp.manage(1,'active',pg_temp.id(32),'drishti','spiffe://axiom.test/agent/drishti')->>'version'='2','explicit activation');
select pg_temp.ok(pg_temp.manage(2,'active',pg_temp.id(32),'drishti','spiffe://evil.test/agent/drishti')->>'error'='binding_immutable','identity cannot be rebound');
select pg_temp.ok(pg_temp.manage(0,'disabled',pg_temp.id(33),'drishti','spiffe://axiom.test/agent/drishti')->>'error'='registration_conflict','subject remains unique');
select pg_temp.ok(pg_temp.manage(0,'disabled')->>'error'='version_conflict','stale status update refused');
select pg_temp.ok(pg_temp.start_tool() ? 'started_receipt','legacy reviewed assignment initially works');
select pg_temp.ok(pg_temp.manage(1,'disabled')->>'version'='2','disable under reviewed version');
select pg_temp.ok((select revoked_at is not null from public.workload_task_delegations where run_id=(select run_id from issued)),'disable revokes outstanding proof');
select pg_temp.ok(pg_temp.manage(1,'disabled')->>'version'='2','lost disable reply is idempotent');
select pg_temp.ok(pg_temp.finish_tool()->>'error'='task_refused','disabled worker cannot finish');
select pg_temp.ok(pg_temp.manage(2,'active')->>'version'='3','re-enable increments version');
select pg_temp.ok(pg_temp.finish_tool()->>'error'='task_refused','re-enable cannot revive old proof');
select pg_temp.ok(pg_temp.manage(1,'disabled')->>'error'='version_conflict','old disable replay cannot undo later activation');
reset role;
-- Real grant references use the read-capable agent; no connector is contacted.
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) values(pg_temp.id(81),pg_temp.id(11),pg_temp.id(22),'Fixture','database');
insert into public.connector_descriptors(id,slug,version,transport,target_binding,manifest) values(pg_temp.id(82),'registration','1','sql','sandbox','{}');
insert into public.connectors(id,tenant_id,system_id,descriptor_id,target_binding,name,endpoint_ref,assurance) values(pg_temp.id(83),pg_temp.id(11),pg_temp.id(81),pg_temp.id(82),'sandbox','Fixture','fixture','high');
insert into public.connector_grants(id,tenant_id,connector_id,workload_identity_id,agent_name,internal_scope,expires_at) values(pg_temp.id(84),pg_temp.id(11),pg_temp.id(83),pg_temp.id(32),'drishti','connector.read',now()+interval '1 hour');
set local role service_role;
select pg_temp.ok(pg_temp.manage(2,'disabled',pg_temp.id(32),'drishti','spiffe://axiom.test/agent/drishti')->>'version'='3','disable read agent');
select pg_temp.ok(pg_temp.manage(3,'active',pg_temp.id(32),'drishti','spiffe://axiom.test/agent/drishti')->>'version'='4','re-enable read agent');
select pg_temp.ok((select revoked_at is not null from public.connector_grants where id=pg_temp.id(84)),'old connector grant stays revoked');
reset role;
-- Audit failure rolls back status/version and revocation as one unit.
update public.workload_task_delegations set revoked_at=null where run_id=(select run_id from issued);
insert into public.connector_grants(id,tenant_id,connector_id,workload_identity_id,agent_name,internal_scope,expires_at) values(pg_temp.id(85),pg_temp.id(11),pg_temp.id(83),pg_temp.id(32),'drishti','connector.read',now()+interval '1 hour');
create function pg_temp.refuse_lifecycle_audit() returns trigger language plpgsql as $$begin if new.action_type='workload.registration_changed' then raise exception 'synthetic audit unavailable'; end if; return new; end$$;
create trigger reject_lifecycle_audit before insert on public.audit_ledger for each row execute function pg_temp.refuse_lifecycle_audit();
set local role service_role;
select pg_temp.reject('select pg_temp.manage(3,''disabled'')','P0001');
select pg_temp.reject('select pg_temp.manage(4,''disabled'',pg_temp.id(32),''drishti'',''spiffe://axiom.test/agent/drishti'')','P0001');
select pg_temp.ok((select revoked_at is null from public.connector_grants where id=pg_temp.id(85)),'audit failure rolls back grant revocation');
select pg_temp.ok((select status='active' and version=3 from public.workload_identities where id=pg_temp.id(31)),'audit failure preserves prior status');
select pg_temp.ok((select revoked_at is null from public.workload_task_delegations where run_id=(select run_id from issued)),'audit failure rolls back proof revocation');
reset role;
drop trigger reject_lifecycle_audit on public.audit_ledger;
update public.tenant_users set role='viewer' where user_id=pg_temp.id(1);
set local role service_role;
select pg_temp.ok(pg_temp.manage(3,'disabled')->>'error'='forbidden','viewer cannot administer');
reset role;
update public.tenant_users set role='axiom_analyst' where user_id=pg_temp.id(1);
set local role service_role;
select pg_temp.ok(pg_temp.manage(3,'disabled')->>'error'='forbidden','analyst cannot administer');
reset role;
update public.tenant_users set role='founder' where user_id=pg_temp.id(1);
set local role service_role;
select pg_temp.ok(pg_temp.manage(3,'disabled')->>'error'='forbidden','external founder denied');
reset role;
update public.users set is_axiom_internal=true where id=pg_temp.id(1);
set local role service_role;
select pg_temp.ok(pg_temp.manage(3,'disabled')->>'version'='4','internal founder may disable');
reset role;
update public.tenant_users set role='admin' where user_id=pg_temp.id(1);
set local role service_role;
select pg_temp.ok(pg_temp.manage(4,'active')->>'version'='5','tenant admin may activate');
select pg_temp.ok(public.manage_workload_identity(pg_temp.id(99),pg_temp.id(1),pg_temp.id(41),pg_temp.id(31),5,'parikshan','spiffe://axiom.test/agent/parikshan','disabled')->>'error'='forbidden','foreign tenant denied');
set local role authenticated;
select pg_temp.reject('select pg_temp.manage(5,''disabled'')','42501');
set local role anon;
select pg_temp.reject('select pg_temp.manage(5,''disabled'')','42501');
reset role;
rollback;
