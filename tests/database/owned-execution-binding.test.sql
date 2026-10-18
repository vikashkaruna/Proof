-- Prefix: genuine custody foundation + real measured human-plan fixture.
-- Explicit disposable SQL accepted-state stand-in, not browser MFA or HMAC proof.
select pg_temp.ok(owned_synthetic.execution_operation_id('89110000-0000-4000-8000-000000000001','89110000-0000-4000-8000-000000000002','forward')='9f5d97bf-30fc-8a17-bc46-ebfaf6ca5b68'::uuid,'BFF and SQL deterministic operation UUID parity');
create temporary table owned168_saved(name text primary key,v jsonb);
grant select,insert on owned168_saved to owned_target_controller;
grant select on human167_saved to owned_target_controller;
insert into owned168_saved select 'source',receipt from human167_saved where n=1;
insert into owned168_saved select 'signed',jsonb_build_object('spec',jsonb_build_object(
 'planId',v->>'planId','actionIds',jsonb_build_array(v->>'actionId'),'approverId',pg_temp.id(1),
 'mode','batch','concurrency',1,'stopOnFailure',true,'nonce','owned168-explicit-sql-stand-in',
 'expiresAt',clock_timestamp()+interval '10 minutes','contentDigest',public.action_set_content_digest(pg_temp.pg_id(1),(v->>'planId')::uuid,array[(v->>'actionId')::uuid])),
 'signature',repeat('f',64)) from owned168_saved where name='source';
insert into public.approval_tokens(id,tenant_id,plan_id,action_ids,approver_id,mode,signature,signed_payload,nonce,expires_at,status)
 select pg_temp.pg_id(241),pg_temp.pg_id(1),(v#>>'{spec,planId}')::uuid,array[(v#>>'{spec,actionIds,0}')::uuid],pg_temp.id(1),'batch',v->>'signature',v->'spec',v#>>'{spec,nonce}',(v#>>'{spec,expiresAt}')::timestamptz,'consumed' from owned168_saved where name='signed';
update public.remediation_actions set approval_status='approved',approval_token_id=pg_temp.pg_id(241),approved_by=pg_temp.id(1),execution_status='executing',execution_request_key='owned168-synthetic-request',dispatch_status='pending'
 where id=(select(v->>'actionId')::uuid from owned168_saved where name='source');
insert into owned168_saved select 'batch',public.start_execution_batch(pg_temp.pg_id(1),(v#>>'{spec,planId}')::uuid,'owned168-synthetic-request',pg_temp.pg_id(242),v#>>'{spec,nonce}',v#>>'{spec,contentDigest}','batch',1,true,'owned168-synthetic-request',array[(v#>>'{spec,actionIds,0}')::uuid]) from owned168_saved where name='signed';
select pg_temp.ok(public.mark_execution_action_started(pg_temp.pg_id(1),(select(v->>'actionId')::uuid from owned168_saved where name='source'),(select(v#>>'{batch,id}')::uuid from owned168_saved where name='batch'),pg_temp.pg_id(242))?'ok','normal executor state records started exact action');
create function pg_temp.owned168_resolve(spiffe text default 'spiffe://local.axiomproof.test/agent/karya') returns jsonb language sql as $$
 select public.resolve_owned_execution_target(pg_temp.pg_id(1),(s.v->>'planId')::uuid,(s.v->>'actionId')::uuid,'owned168-synthetic-request',t.v,spiffe) from owned168_saved s,owned168_saved t where s.name='source' and t.name='signed'
$$;
create function pg_temp.owned168_execute(operation text) returns jsonb language sql as $$
 select public.execute_owned_synthetic_action(pg_temp.pg_id(1),(s.v->>'planId')::uuid,(s.v->>'actionId')::uuid,'owned168-synthetic-request',t.v,'spiffe://local.axiomproof.test/agent/karya',operation) from owned168_saved s,owned168_saved t where s.name='source' and t.name='signed'
$$;
set local role owned_target_controller;
select pg_temp.human167_refused('select pg_temp.owned168_resolve()');
reset role;
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status)
 values(pg_temp.pg_id(240),pg_temp.pg_id(1),'karya','spiffe://local.axiomproof.test/agent/karya','active');
-- Real PostgreSQL PostgREST role-switch protocol parity only. No JWT HTTP
-- validation is claimed by this native SQL fixture. The real installer must
-- prove the retained approval before granting this EXACT incoming edge.
do $$begin execute format('grant usage on schema %I to authenticator,owned_target_controller',pg_my_temp_schema()::regnamespace);end $$;
set session authorization authenticator;
select pg_temp.human167_refused('set local role owned_target_controller');
reset session authorization;
grant owned_target_controller to authenticator;
set session authorization authenticator;
set local role owned_target_controller;
select pg_temp.ok(current_user='owned_target_controller' and session_user='authenticator','actual authenticator can switch only after exact incoming grant');
select pg_temp.ok(pg_temp.owned168_resolve()->>'tenantId'=pg_temp.pg_id(1)::text,'native switched scoped role can call only its fixed binding RPC');
reset role;
reset session authorization;
revoke owned_target_controller from authenticator;
set local role owned_target_controller;
select pg_temp.human167_refused('select pg_temp.owned168_resolve(''spiffe://local.axiomproof.test/agent/sudhaar'')');
select pg_temp.ok(pg_temp.owned168_resolve()->'before'=(select proof->'before' from human167_saved where n=1),'binding resolves original retained actual measurement');
select pg_temp.human167_refused('select pg_temp.owned168_execute(''rollback'')');
select pg_temp.human167_refused('select pg_temp.owned168_execute(''arbitrary_sql'')','22023');
reset role;
-- Altered consumed scope, workload revocation and signature bytes are fences.
do $$begin
 begin update public.workload_identities set status='disabled' where id=pg_temp.pg_id(240);
 set local role owned_target_controller;perform pg_temp.owned168_resolve();raise exception 'revoked workload accepted';exception when insufficient_privilege then null;end;
 begin update owned168_saved set v=jsonb_set(v,'{signature}',to_jsonb(repeat('0',64))) where name='signed';
 set local role owned_target_controller;perform pg_temp.owned168_execute('forward');raise exception 'altered signed token accepted';exception when insufficient_privilege then null;end;
 begin
 perform pg_temp.owned168_resolve(); -- metadata was valid before revocation
 update public.approval_tokens set revoked_at=clock_timestamp() where id=pg_temp.pg_id(241);
 set local role owned_target_controller;perform pg_temp.owned168_execute('forward');raise exception 'token revoked after resolve accepted';exception when insufficient_privilege then null;end;
 begin update owned_synthetic.resources set version=99 where resource_id=pg_temp.pg_id(181);
 set local role owned_target_controller;perform pg_temp.owned168_execute('forward');raise exception 'changed actual source accepted';exception when serialization_failure then null;end;
 begin update public.approval_tokens set action_ids=array_append(action_ids,pg_temp.pg_id(249)) where id=pg_temp.pg_id(241);
 set local role owned_target_controller;perform pg_temp.owned168_execute('forward');raise exception 'mixed token accepted';exception when insufficient_privilege then null;end;
end $$;
reset role;
savepoint before_owned168_custody_revoke;
select pg_temp.write(pg_temp.request(80,'revoke',(select(v->>'eventId')::uuid from custody_saved where kind='activate')),1);
select pg_temp.ok((select state='revoked' from public.local_custody_policy_heads where policy_id=pg_temp.id(21)),'normal retained custody transition actually revokes source');
set local role owned_target_controller;
select pg_temp.human167_refused('select pg_temp.owned168_execute(''forward'')');
reset role;
rollback to before_owned168_custody_revoke;
select pg_temp.ok((select count(*)=0 from owned_synthetic.operations),'all refused bindings leave target journal empty');
savepoint before_owned168_forward;
set local role owned_target_controller;
insert into owned168_saved values('after',pg_temp.owned168_execute('forward'));
select pg_temp.ok(pg_temp.owned168_execute('forward')=(select v from owned168_saved where name='after'),'wrapper exact retry returns one committed actual transition');
select pg_temp.ok(public.read_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(191),pg_temp.pg_id(170))=(select v from owned168_saved where name='after'),'independent transaction-capable read surface exposes exact actual result');
savepoint after_owned168_forward;
insert into owned168_saved values('restored',pg_temp.owned168_execute('rollback'));
select pg_temp.ok(pg_temp.owned168_execute('rollback')=(select v from owned168_saved where name='restored'),'wrapper rollback exact replay performs no second undo');
select pg_temp.ok((select v->>'version'='2' and v->'audit_log_enabled'='false'::jsonb from owned168_saved where name='restored'),'rollback restores actual synthetic boolean with monotonic version');
reset role;
select pg_temp.ok((select count(*)=2 from owned_synthetic.operations),'singleton has exactly one forward and one rollback operation');
select pg_temp.ok(not has_function_privilege('service_role','public.execute_owned_synthetic_action(uuid,uuid,uuid,text,jsonb,text,text)','EXECUTE'),'aggregate runtime cannot directly call write wrapper');
select pg_temp.ok(not has_function_privilege('human_action_writer','public.execute_owned_synthetic_action(uuid,uuid,uuid,text,jsonb,text,text)','EXECUTE'),'planner/human writer cannot invoke target write wrapper');
select pg_temp.ok((select count(*)=0 from public.verify_ledger(pg_temp.pg_id(1))),'binding and target transitions preserve append-only proof');
rollback;
