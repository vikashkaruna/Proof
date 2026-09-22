begin;
create function pg_temp.id(n int) returns uuid language sql immutable as $$select ('69690000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m; end if; end$$;
create function pg_temp.reject(q text,code text) returns void language plpgsql as $$begin begin execute q; exception when others then if sqlstate=code then return; end if; raise; end; raise exception 'Unexpected success'; end$$;
insert into auth.users(id,email) values(pg_temp.id(1),'scheduling-fixture@test.invalid');
insert into public.users(id,email) values(pg_temp.id(1),'scheduling-fixture@test.invalid');
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'scheduling-fixture','Worker fixture');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(1),'owner');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('scheduling-fixture-v1',now(),'test','Synthetic fixture',2);
insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version)
 select 'WA-'||n,'scheduling-fixture-v1','Fixture','Fixture','SEC','low','[]','[]','[]','{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":1000000}','{}','scheduling-fixture-v1' from generate_series(1,2) n;
insert into public.estates(id,tenant_id,name,slug) values(pg_temp.id(22),pg_temp.id(11),'Synthetic estate','synthetic');
insert into public.engagements(id,tenant_id,estate_id,library_version,title) values(pg_temp.id(21),pg_temp.id(11),pg_temp.id(22),'scheduling-fixture-v1','New assessment');
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status)
 values(pg_temp.id(31),pg_temp.id(11),'parikshan','spiffe://axiom.test/parikshan','active');

create function pg_temp.enqueue(job int default 51,hash text default repeat('a',64),cipher bytea default decode(repeat('ab',100),'hex')) returns jsonb language sql as $$
 select public.enqueue_assessment_dispatch(pg_temp.id(job),pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(22),pg_temp.id(21),pg_temp.id(41),hash,encode(sha256(convert_to('scheduling-'||job::text,'UTF8')),'hex'),clock_timestamp()+interval '10 minutes','synthetic-key/v1',decode(repeat('ab',12),'hex'),cipher,decode(repeat('cd',32),'hex'))$$;

create function pg_temp.reserve(ns text default 'default') returns jsonb language sql as $$select public.reserve_assessment_schedules(ns,pg_temp.id(11),1)$$;
create function pg_temp.ack(ticket jsonb, execution uuid default pg_temp.id(61)) returns jsonb language sql as $$select public.acknowledge_assessment_schedule((ticket->>'tenantId')::uuid,(ticket->>'jobId')::uuid,(ticket->>'leaseId')::uuid,ticket->>'namespace',ticket->>'workflowId',execution)$$;
set local role service_role;
select pg_temp.enqueue();
create temporary table ticket as select pg_temp.reserve()->'jobs'->0 value;
select pg_temp.ok((select value->>'startBefore' is not null from ticket),'live pending assignment may be submitted');
select pg_temp.ok((select count(*)=7 from ticket,jsonb_object_keys(ticket.value)),'reservation is only opaque metadata');
select pg_temp.ok(pg_temp.reserve()->'jobs'='[]'::jsonb,'live lease cannot be reserved twice');
select pg_temp.ok(pg_temp.reserve('different')->'jobs'='[]'::jsonb,'namespace is pinned');
select pg_temp.ok(public.reserve_assessment_schedules('default',pg_temp.id(99),1)->'jobs'='[]'::jsonb,'tenant shard remains isolated');
select pg_temp.ok(public.reserve_assessment_schedules('default',null,11)->>'error'='scheduling_refused','bounded polling');
select pg_temp.ok(public.reserve_assessment_schedules('bad namespace',null,1)->>'error'='scheduling_refused','invalid namespace');
select pg_temp.ok(pg_temp.ack((select value from ticket)||jsonb_build_object('leaseId',pg_temp.id(99)))->>'error'='scheduling_refused','foreign lease refused');
select pg_temp.ok(pg_temp.ack((select value from ticket)||jsonb_build_object('tenantId',pg_temp.id(99)))->>'error'='scheduling_refused','foreign tenant refused');
select pg_temp.ok(pg_temp.ack((select value from ticket)||jsonb_build_object('namespace','different'))->>'error'='scheduling_refused','wrong namespace refused');
select pg_temp.ok(pg_temp.ack((select value from ticket)||jsonb_build_object('workflowId','arbitrary'))->>'error'='scheduling_refused','wrong workflow refused');
reset role;
-- Simulate a producer restart after a reservation or submission response was lost.
update public.assessment_dispatch_jobs set scheduling_lease_until=clock_timestamp()-interval '1 second',scheduling_next_at=clock_timestamp()-interval '1 second' where id=pg_temp.id(51);
set local role service_role;
select pg_temp.ok(pg_temp.ack((select value from ticket))->>'error'='scheduling_refused','expired lease refused');
create temporary table replacement as select pg_temp.reserve()->'jobs'->0 value;
select pg_temp.ok((select value->>'leaseId' from replacement)<>(select value->>'leaseId' from ticket),'restart gets new fence');
select pg_temp.ok((select value->>'workflowId' from replacement)=(select value->>'workflowId' from ticket),'retry keeps workflow ID');
select pg_temp.ok(pg_temp.ack((select value from ticket))->>'error'='scheduling_refused','stale producer cannot acknowledge new lease');
reset role;
create function pg_temp.fail_schedule() returns trigger language plpgsql as $$begin if new.action_type='workload.dispatch_scheduled' then raise exception 'synthetic scheduling audit failure'; end if; return new; end$$;
create trigger fail_schedule before insert on public.audit_ledger for each row execute function pg_temp.fail_schedule();
set local role service_role;
select pg_temp.reject('select pg_temp.ack((select value from replacement))','P0001');
select pg_temp.ok((select scheduling_status='pending' and scheduling_receipt is null from public.assessment_dispatch_jobs where id=pg_temp.id(51)),'audit failure rolls back submission receipt');
reset role;
drop trigger fail_schedule on public.audit_ledger;
set local role service_role;
create temporary table acknowledged as select pg_temp.ack((select value from replacement)) value;
select pg_temp.ok(pg_temp.ack((select value from replacement))->>'receipt'=(select value->>'receipt' from acknowledged),'lost ack response is idempotent');
select pg_temp.ok(pg_temp.ack((select value from replacement),pg_temp.id(62))->>'error'='scheduling_conflict','execution ID cannot be replaced');
select pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type='workload.dispatch_scheduled'),'one submission audit');
select pg_temp.ok((select claimed_at is null from public.assessment_dispatch_jobs where id=pg_temp.id(51)),'scheduling never claims private payload');
select pg_temp.ok((select status='queued' from public.agent_runs where id=(select run_id from public.assessment_dispatch_jobs where id=pg_temp.id(51))),'submission is not execution completion');
select pg_temp.ok(pg_temp.reserve()->'jobs'='[]'::jsonb,'acknowledged job stops being polled');
select pg_temp.enqueue(52);
reset role;
update public.workload_task_delegations set created_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute' where run_id=(select run_id from public.assessment_dispatch_jobs where id=pg_temp.id(52));
set local role service_role;
select pg_temp.ok(pg_temp.reserve()->'jobs'->0->'startBefore'='null'::jsonb,'expired job can only find existing workflow');
reset role;
-- Exhausted uncertain submission becomes an audited review handoff, not failure.
update public.assessment_dispatch_jobs set scheduling_attempts=8,scheduling_lease_until=clock_timestamp()-interval '1 second',scheduling_next_at=clock_timestamp()-interval '1 second' where id=pg_temp.id(52);
set local role service_role;
select pg_temp.ok(pg_temp.reserve()->'jobs'='[]'::jsonb,'no ninth submission');
select pg_temp.ok((select scheduling_status='needs_review' and scheduling_receipt is not null and claimed_at is null from public.assessment_dispatch_jobs where id=pg_temp.id(52)),'review handoff preserves task and claim');
select pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type='workload.dispatch_schedule_review'),'review is recorded once');
select pg_temp.reject('update public.assessment_dispatch_jobs set scheduling_attempts=0','42501');
select pg_temp.reject('insert into public.assessment_dispatch_jobs(id) values(pg_temp.id(99))','42501');
reset role;
set local role authenticated;
select pg_temp.reject('select * from public.assessment_dispatch_jobs','42501');
select pg_temp.reject('select public.reserve_assessment_schedules(''default'',null,1)','42501');
select pg_temp.reject('select public.acknowledge_assessment_schedule(pg_temp.id(11),pg_temp.id(51),pg_temp.id(99),''default'',''arbitrary'',pg_temp.id(61))','42501');
reset role;
set local role anon;
select pg_temp.reject('select public.reserve_assessment_schedules(''default'',null,1)','42501');
reset role;
rollback;
