begin;
create function pg_temp.id(n int) returns uuid language sql immutable as $$select ('71710000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m; end if; end$$;
create function pg_temp.reject(q text,code text) returns void language plpgsql as $$begin begin execute q; exception when others then if sqlstate=code then return; end if; raise; end; raise exception 'Unexpected success'; end$$;
insert into auth.users(id,email) values(pg_temp.id(1),'policy-fixture@test.invalid');
insert into public.users(id,email) values(pg_temp.id(1),'policy-fixture@test.invalid');
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'policy-fixture','Worker fixture');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(1),'owner');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('policy-fixture-v1',now(),'test','Synthetic fixture',2);
insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version)
 select 'WA-'||n,'policy-fixture-v1','Fixture','Fixture','SEC','low','[]','[]','[]','{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":1000000}','{}','policy-fixture-v1' from generate_series(1,2) n;
insert into public.estates(id,tenant_id,name,slug) values(pg_temp.id(22),pg_temp.id(11),'Synthetic estate','synthetic');
insert into public.engagements(id,tenant_id,estate_id,library_version,title) values(pg_temp.id(21),pg_temp.id(11),pg_temp.id(22),'policy-fixture-v1','New assessment');
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status)
 values(pg_temp.id(31),pg_temp.id(11),'parikshan','spiffe://axiom.test/parikshan','active');

create function pg_temp.enqueue(job int default 51,hash text default repeat('a',64),cipher bytea default decode(repeat('ab',100),'hex')) returns jsonb language sql as $$
 select public.enqueue_assessment_dispatch(pg_temp.id(job),pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(22),pg_temp.id(21),pg_temp.id(41),hash,encode(sha256(convert_to('policy-legacy-'||job::text,'UTF8')),'hex'),clock_timestamp()+interval '10 minutes','synthetic-key/v1',decode(repeat('ab',12),'hex'),cipher,decode(repeat('cd',32),'hex'))$$;

create function pg_temp.ref(n int) returns text language sql immutable as $$select 'arn:aws:kms:ap-south-1:123456789012:key/'||pg_temp.id(n)::text$$;
create function pg_temp.publish(revision integer,primary_key integer default 61,keys integer[] default array[61]) returns jsonb language sql as $$
 select public.publish_assessment_dispatch_key_policy(pg_temp.id(11),pg_temp.id(1),pg_temp.id(41),revision,'aws',pg_temp.ref(primary_key),array(select pg_temp.ref(k) from unnest(keys) k))$$;
create function pg_temp.fingerprint() returns text language sql as $$select fingerprint from public.assessment_dispatch_key_policies where tenant_id=pg_temp.id(11)$$;
create function pg_temp.queued(job int,revision integer default null,digest text default null,key_id integer default 61) returns jsonb language sql as $$
 select public.enqueue_assessment_dispatch(pg_temp.id(job),pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(22),pg_temp.id(21),pg_temp.id(41),repeat('a',64),encode(sha256(convert_to('policy-'||job::text,'UTF8')),'hex'),clock_timestamp()+interval '10 minutes',pg_temp.ref(key_id),decode(repeat('ab',12),'hex'),decode(repeat('ab',100),'hex'),decode(repeat('cd',32),'hex'),revision,digest)$$;
create function pg_temp.claim(job int,revision integer default null,digest text default null) returns jsonb language sql as $$select public.claim_assessment_dispatch(pg_temp.id(11),pg_temp.id(job),revision,digest)$$;
-- POLICY_FIXTURE_READY
set local role service_role;
select pg_temp.ok(pg_temp.queued(51)->>'error'='policy_required','production keys need a managed policy');
select pg_temp.ok(pg_temp.publish(0)->>'revision'='1','initial reviewed policy recorded');
select pg_temp.ok(pg_temp.publish(0)->>'revision'='1','lost publication reply is idempotent');
select pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type='workload.dispatch_policy_published'),'one policy receipt');
select pg_temp.ok(pg_temp.queued(51)->>'error'='policy_stale','legacy call cannot bypass managed policy');
select pg_temp.ok(pg_temp.queued(51,1,repeat('f',64))->>'error'='policy_stale','foreign fingerprint denied');
select pg_temp.ok(pg_temp.queued(51,1,pg_temp.fingerprint(),62)->>'error'='policy_stale','writer must use current primary');
select pg_temp.ok(pg_temp.queued(51,1,pg_temp.fingerprint()) ? 'run_id','current writer can enqueue');
select pg_temp.ok(pg_temp.claim(51)->>'error'='policy_stale','old reader rejected before claim');
select pg_temp.ok((select claimed_at is null from public.assessment_dispatch_jobs where id=pg_temp.id(51)),'stale reader does not consume claim');
select pg_temp.ok(pg_temp.publish(1,62,array[61,62])->>'error'='policy_transition_refused','new primary must first be staged');
select pg_temp.ok(pg_temp.publish(1,61,array[61,62])->>'revision'='2','reader stage retains primary');
select pg_temp.ok(pg_temp.queued(52,1,repeat('f',64))->>'error'='policy_stale','stale writer cannot enqueue after staging');
select pg_temp.ok(pg_temp.claim(51,1,repeat('f',64))->>'error'='policy_stale','stale reader cannot claim after staging');
select pg_temp.ok(pg_temp.publish(1,62,array[61,62])->>'error'='policy_conflict','stale publisher refused');
select pg_temp.ok(pg_temp.publish(2,62,array[61,62])->>'revision'='3','promote only already-readable key');
select pg_temp.ok(pg_temp.publish(3,62,array[62])->>'error'='policy_transition_refused','cannot remove prior readable key');
select pg_temp.ok(pg_temp.queued(51)->>'run_id'=(select run_id::text from public.assessment_dispatch_jobs where id=pg_temp.id(51)),'old stable receipt recovery survives policy cutover');
select pg_temp.ok(pg_temp.claim(51,3,pg_temp.fingerprint())->>'key_ref'=pg_temp.ref(61),'new reader can claim retained old key');
select pg_temp.ok(pg_temp.claim(51,3,pg_temp.fingerprint()) ? 'error','claim remains single-use');
select pg_temp.ok(pg_temp.queued(52,3,pg_temp.fingerprint(),62) ? 'run_id','new jobs use new primary');
select pg_temp.reject('select public.claim_assessment_dispatch_unfenced(pg_temp.id(11),pg_temp.id(52))','42501');
select pg_temp.reject('update public.assessment_dispatch_key_policies set revision=1','42501');
select pg_temp.reject('delete from public.assessment_dispatch_key_policies','42501');
select pg_temp.ok(not has_function_privilege('service_role','public.enqueue_assessment_dispatch_unfenced(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea)','execute'),'old enqueue implementation is private');
reset role;
savepoint demoted;
update public.tenant_users set role='axiom_analyst' where tenant_id=pg_temp.id(11);
set local role service_role;
select pg_temp.ok(pg_temp.publish(3,62,array[61,62])->>'error'='policy_forbidden','analyst cannot publish a policy');
reset role;
rollback to demoted;
insert into public.tenants(id,slug,name) values(pg_temp.id(12),'policy-other','Other');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(12),pg_temp.id(1),'admin');
select pg_temp.ok(public.publish_assessment_dispatch_key_policy(pg_temp.id(12),pg_temp.id(1),pg_temp.id(41),0,'aws',pg_temp.ref(61),array[pg_temp.ref(61)])->>'error'='policy_keys_required','key resources cannot cross tenants');
select pg_temp.ok(public.publish_assessment_dispatch_key_policy(pg_temp.id(12),pg_temp.id(1),pg_temp.id(41),0,'aws',pg_temp.ref(63),array[pg_temp.ref(63)])->>'revision'='1','tenant admin may approve own distinct policy');
select pg_temp.ok(public.publish_assessment_dispatch_key_policy(pg_temp.id(11),pg_temp.id(1),pg_temp.id(41),3,'aws',pg_temp.ref(62)||chr(10),array[pg_temp.ref(62)||chr(10)])->>'error'='policy_refused','newline references refused');
select pg_temp.ok(public.publish_assessment_dispatch_key_policy(pg_temp.id(11),pg_temp.id(1),pg_temp.id(41),3,'gcp','projects/axiom-test/locations/asia-south1/keyRings/dispatch/cryptoKeys/key',array['projects/axiom-test/locations/asia-south1/keyRings/dispatch/cryptoKeys/key'])->>'error'='policy_transition_refused','provider changes cannot drop historical keys');
insert into public.tenants(id,slug,name) values(pg_temp.id(13),'policy-gcp','GCP');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(13),pg_temp.id(1),'owner');
select pg_temp.ok(public.publish_assessment_dispatch_key_policy(pg_temp.id(13),pg_temp.id(1),pg_temp.id(41),0,'gcp','projects/axiom-test/locations/asia-south1/keyRings/dispatch/cryptoKeys/key',array['projects/axiom-test/locations/asia-south1/keyRings/dispatch/cryptoKeys/key'])->>'revision'='1','canonical Mumbai GCP policy accepted');
select pg_temp.ok(public.publish_assessment_dispatch_key_policy(pg_temp.id(13),pg_temp.id(1),pg_temp.id(41),1,'gcp','projects/axiom-test/locations/us-central1/keyRings/dispatch/cryptoKeys/key',array['projects/axiom-test/locations/us-central1/keyRings/dispatch/cryptoKeys/key'])->>'error'='policy_refused','foreign-region GCP policy refused');
create function pg_temp.fail_policy() returns trigger language plpgsql as $$begin if new.action_type='workload.dispatch_policy_published' then raise exception 'synthetic audit failure'; end if; return new; end$$;
create trigger fail_policy before insert on public.audit_ledger for each row execute function pg_temp.fail_policy();
set local role service_role;
select pg_temp.reject('select pg_temp.publish(3,62,array[61,62,64])','P0001');
select pg_temp.ok((select revision=3 and not (pg_temp.ref(64)=any(readable_refs)) from public.assessment_dispatch_key_policies where tenant_id=pg_temp.id(11)),'audit failure rolls back publication and fence');
reset role;
drop trigger fail_policy on public.audit_ledger;
set local role authenticated;
select pg_temp.reject('select pg_temp.publish(3)','42501');
select pg_temp.reject('select * from public.assessment_dispatch_key_policies','42501');
reset role;
set local role anon;
select pg_temp.reject('select pg_temp.publish(3)','42501');
reset role;
rollback;
