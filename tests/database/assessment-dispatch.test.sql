begin;
create function pg_temp.id(n int) returns uuid language sql immutable as $$select ('68680000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m; end if; end$$;
create function pg_temp.reject(q text,code text) returns void language plpgsql as $$begin begin execute q; exception when others then if sqlstate=code then return; end if; raise; end; raise exception 'Unexpected success'; end$$;
insert into auth.users(id,email) values(pg_temp.id(1),'dispatch-fixture@test.invalid');
insert into public.users(id,email) values(pg_temp.id(1),'dispatch-fixture@test.invalid');
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'dispatch-fixture','Worker fixture');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(1),'owner');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('dispatch-fixture-v1',now(),'test','Synthetic fixture',2);
insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version)
 select 'WA-'||n,'dispatch-fixture-v1','Fixture','Fixture','SEC','low','[]','[]','[]','{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":1000000}','{}','dispatch-fixture-v1' from generate_series(1,2) n;
insert into public.estates(id,tenant_id,name,slug) values(pg_temp.id(22),pg_temp.id(11),'Synthetic estate','synthetic');
insert into public.engagements(id,tenant_id,estate_id,library_version,title) values(pg_temp.id(21),pg_temp.id(11),pg_temp.id(22),'dispatch-fixture-v1','New assessment');
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status)
 values(pg_temp.id(31),pg_temp.id(11),'parikshan','spiffe://axiom.test/parikshan','active');

-- Compatibility fixture only: preserve pre-0112 upgrade setup, and explicitly
-- assume the human writer for latest enqueue while claims retain service scope.
create function pg_temp.enqueue(job int default 51,hash text default repeat('a',64),cipher bytea default decode(repeat('ab',100),'hex')) returns jsonb language plpgsql as $$
declare prior text:=current_user; reply jsonb; policy jsonb; key_ref text; modern boolean:=false; historical boolean;
begin
 if to_regprocedure('public.enqueue_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text)') is not null then
  modern:=not has_function_privilege('service_role','public.enqueue_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text)','execute');
 end if;
 if not modern then
  return public.enqueue_assessment_dispatch(pg_temp.id(job),pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(22),pg_temp.id(21),pg_temp.id(41),hash,encode(sha256(convert_to(''||job::text,'UTF8')),'hex'),clock_timestamp()+interval '10 minutes','synthetic-key/v1',decode(repeat('ab',12),'hex'),cipher,decode(repeat('cd',32),'hex'));
 end if;
 if prior not in ('postgres','service_role','human_action_writer') then raise exception 'fixture writer denied' using errcode='42501'; end if;
 select exists(select 1 from public.assessment_dispatch_jobs where id=pg_temp.id(job)) into historical;
 execute 'set local role human_action_writer';
 begin
  if historical then
   reply:=public.enqueue_assessment_dispatch(pg_temp.id(job),pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(22),pg_temp.id(21),pg_temp.id(41),hash,encode(sha256(convert_to(''||job::text,'UTF8')),'hex'),clock_timestamp()+interval '10 minutes','synthetic-key/v1',decode(repeat('ab',12),'hex'),cipher,decode(repeat('cd',32),'hex'));
  else
   key_ref:='arn:aws:kms:ap-south-1:123456789012:key/'||pg_temp.id(61)::text;
   policy:=public.publish_assessment_dispatch_key_policy(pg_temp.id(11),pg_temp.id(1),pg_temp.id(41),0,'aws',key_ref,array[key_ref]);
   if policy ? 'error' then raise exception 'fixture policy refused'; end if;
   reply:=public.enqueue_assessment_dispatch(pg_temp.id(job),pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(22),pg_temp.id(21),pg_temp.id(41),hash,encode(sha256(convert_to(''||job::text,'UTF8')),'hex'),clock_timestamp()+interval '10 minutes',key_ref,decode(repeat('ab',12),'hex'),cipher,decode(repeat('cd',32),'hex'),(policy->>'revision')::integer,policy->>'fingerprint');
  end if;
 exception when others then execute format('set local role %I',prior); raise; end;
 execute format('set local role %I',prior); return reply;
end $$;
create function pg_temp.claim(job int default 51, tenant uuid default pg_temp.id(11)) returns jsonb language plpgsql as $$
declare revision integer; fingerprint text;
begin
 if to_regclass('public.assessment_dispatch_key_policies') is not null then
  select p.revision,p.fingerprint into revision,fingerprint from public.assessment_dispatch_key_policies p where tenant_id=tenant;
  return public.claim_assessment_dispatch(tenant,pg_temp.id(job),revision,fingerprint);
 end if;
 return public.claim_assessment_dispatch(tenant,pg_temp.id(job));
end $$;
set local role service_role;
create temporary table receipt as select pg_temp.enqueue() value;
select pg_temp.ok(pg_temp.enqueue()->>'run_id'=(select value->>'run_id' from receipt),'lost enqueue response returns same run');
select pg_temp.ok((select count(*)=1 from public.agent_runs where tenant_id=pg_temp.id(11)),'one run across retry');
select pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type='workload.task_delegated'),'one delegation audit across retry');
select pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type='assessment.requested'),'one exact human request across retries');
select pg_temp.ok((select actor_type='human' and actor_id=pg_temp.id(1)::text and input_hash=repeat('a',64) and approval_token_id is null and detail->>'purpose'='durable_assessment' and detail->>'job_id'=pg_temp.id(51)::text from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type='assessment.requested'),'hash-bound human request has no execution approval');
select pg_temp.ok(pg_temp.enqueue(51,repeat('c',64))->>'error'='dispatch_conflict','request content cannot change');
select pg_temp.reject('select pg_temp.enqueue(52,repeat(''a'',64),decode(''ab'',''hex''))','23514');
select pg_temp.ok((select count(*)=1 from public.agent_runs where tenant_id=pg_temp.id(11)),'invalid envelope rolls back delegation');
select pg_temp.reject('update public.assessment_dispatch_jobs set claimed_at=null','42501');
select pg_temp.reject('delete from public.assessment_dispatch_jobs','42501');
select pg_temp.ok(pg_temp.claim(51,pg_temp.id(99))->>'error'='dispatch_unavailable','foreign tenant refused');
reset role;
savepoint halted;
update public.kill_switch_state set engaged=true where scope_key='global';
set local role service_role;
select pg_temp.ok(pg_temp.claim(51)->>'error'='dispatch_unavailable','halt blocks private delivery');
reset role;
rollback to halted;
savepoint demoted;
update public.tenant_users set role='viewer' where user_id=pg_temp.id(1);
set local role service_role;
select pg_temp.ok(pg_temp.claim(51)->>'error'='dispatch_unavailable','demotion blocks private delivery');
reset role;
rollback to demoted;
savepoint revoked;
update public.workload_task_delegations set revoked_at=clock_timestamp() where tenant_id=pg_temp.id(11);
set local role service_role;
select pg_temp.ok(pg_temp.claim(51)->>'error'='dispatch_unavailable','revocation blocks private delivery');
reset role;
rollback to revoked;
savepoint archived;
update public.estates set status='archived' where id=pg_temp.id(22);
set local role service_role;
select pg_temp.ok(pg_temp.claim(51)->>'error'='dispatch_unavailable','archival blocks private delivery');
reset role;
rollback to archived;
savepoint expired;
update public.workload_task_delegations set created_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute' where tenant_id=pg_temp.id(11);
set local role service_role;
select pg_temp.ok(pg_temp.enqueue()->>'run_id'=(select value->>'run_id' from receipt),'historical retry returns same expired task');
select pg_temp.ok(pg_temp.claim(51)->>'error'='dispatch_unavailable','retry does not revive expired authority');
reset role;
rollback to expired;
create function pg_temp.fail_delegation() returns trigger language plpgsql as $$begin if new.action_type='workload.task_delegated' then raise exception 'synthetic audit failure'; end if; return new; end$$;
create trigger fail_delegation before insert on public.audit_ledger for each row execute function pg_temp.fail_delegation();
set local role service_role;
select pg_temp.reject('select pg_temp.enqueue(52)','P0001');
select pg_temp.ok((select count(*)=1 from public.agent_runs where tenant_id=pg_temp.id(11)),'audit failure leaves no queued run');
select pg_temp.ok((select count(*)=1 from public.assessment_dispatch_jobs where tenant_id=pg_temp.id(11)),'audit failure leaves no orphan job');
reset role;
drop trigger fail_delegation on public.audit_ledger;
set local role service_role;
select pg_temp.ok(pg_temp.claim(51)->>'ciphertext'=repeat('ab',100),'first live claim delivers encrypted payload');
select pg_temp.ok(pg_temp.claim(51)->>'error'='dispatch_reconciliation_required','no second delivery after response loss');
reset role;
set local role authenticated;
select pg_temp.reject('select * from public.assessment_dispatch_jobs','42501');
select pg_temp.reject('select pg_temp.claim(51)','42501');
select pg_temp.reject('select pg_temp.enqueue()','42501');
reset role;
rollback;
