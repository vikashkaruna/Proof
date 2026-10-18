-- Prefix: genuine custody + measured human plans + accepted execution168.
-- Explicit disposable SQL approval stand-ins; no browser/HMAC acceptance claim.
grant select on owned168_saved to human_action_writer;
create function pg_temp.observe170(k int default 270,actor int default 1,action uuid default null,batch uuid default null) returns jsonb language sql as $$
 select public.observe_owned_execution_effect(pg_temp.pg_id(1),pg_temp.id(actor),pg_temp.id(100+actor),pg_temp.pg_id(k),
 (s.v->>'planId')::uuid,coalesce(action,(s.v->>'actionId')::uuid),coalesce(batch,(b.v#>>'{batch,id}')::uuid))
 from owned168_saved s,owned168_saved b where s.name='source' and b.name='batch'
$$;
create temporary table observed170(v jsonb);
grant select,insert on observed170 to human_action_writer;
set local role human_action_writer;
insert into observed170 select pg_temp.observe170();
select pg_temp.ok((select v#>>'{observation,outcome}'='rollback_committed' and v#>>'{observation,currentMatchesLastCommit}'='true' from observed170),'lost rollback reply independently recovers exact committed undo');
select pg_temp.ok(pg_temp.observe170()=(select v from observed170),'lost observation reply returns original immutable receipt');
select pg_temp.human167_refused('select pg_temp.observe170(270,6)','22023');
select pg_temp.human167_refused('select pg_temp.observe170(271,1,pg_temp.pg_id(999))');
select pg_temp.human167_refused('select pg_temp.observe170(271,1,null,pg_temp.pg_id(999))');
reset role;
select pg_temp.ok((select count(*)=2 from owned_synthetic.operations),'readback creates no forward or rollback operation');
select pg_temp.ok((select execution_status='executing' from public.remediation_actions where id=(select(v->>'actionId')::uuid from owned168_saved where name='source')),'observation does not rewrite original execution status');
update public.approval_tokens set expires_at=clock_timestamp()-interval '1 second',status='revoked',revoked_at=clock_timestamp() where id=pg_temp.pg_id(241);
set local role human_action_writer;
select pg_temp.ok(pg_temp.observe170(272)#>>'{observation,approvalExpired}'='true' and pg_temp.observe170(272)#>>'{observation,approvalRevoked}'='true','expired revoked execution authority does not erase historical committed facts');
reset role;
set local role owned_target_controller;
select pg_temp.human167_refused('select pg_temp.owned168_execute(''forward'')');
select pg_temp.human167_refused('select pg_temp.owned168_execute(''rollback'')');
reset role;
-- An ABA/current drift is retained as drift, never described as restored now.
update owned_synthetic.resources set version=version+2 where resource_id=pg_temp.pg_id(181);
set local role human_action_writer;
select pg_temp.ok(pg_temp.observe170(273)#>>'{observation,currentMatchesLastCommit}'='false','same boolean after version drift is not exact restoration');
reset role;
do $$begin
 begin update public.mfa_session_attestations set revoked_at=clock_timestamp() where user_id=pg_temp.id(1);
 set local role human_action_writer;perform pg_temp.observe170(274);raise exception 'revoked MFA accepted';exception when insufficient_privilege then null;end;
 begin update public.tenant_users set role='approver' where tenant_id=pg_temp.pg_id(1) and user_id=pg_temp.id(1);
 set local role human_action_writer;perform pg_temp.observe170(274);raise exception 'approver readback accepted';exception when insufficient_privilege then null;end;
 begin update public.kill_switch_state set engaged=true where scope='global';
 set local role human_action_writer;perform pg_temp.observe170(274);raise exception 'killed source accepted';exception when insufficient_privilege then null;end;
end $$;
reset role;
select pg_temp.human167_refused('delete from owned_synthetic.effect_observations');
select pg_temp.human167_refused('truncate owned_synthetic.effect_observations');
select pg_temp.ok(not has_function_privilege('service_role','public.observe_owned_execution_effect(uuid,uuid,uuid,uuid,uuid,uuid,uuid)','EXECUTE'),'aggregate service cannot record human observation');
select pg_temp.ok(not has_function_privilege('owned_target_controller','public.observe_owned_execution_effect(uuid,uuid,uuid,uuid,uuid,uuid,uuid)','EXECUTE'),'worker/controller cannot impersonate a human observer');
select pg_temp.ok((select count(*)=0 from public.verify_ledger(pg_temp.pg_id(1))),'observations retain append-only chain');
-- Recover the original forward-only state without manufacturing new journals.
rollback to after_owned168_forward;
reset role;
grant select on owned168_saved to human_action_writer;
create function pg_temp.observe170forward(k int) returns jsonb language sql as $$
 select public.observe_owned_execution_effect(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(k),
 (s.v->>'planId')::uuid,(s.v->>'actionId')::uuid,(b.v#>>'{batch,id}')::uuid)
 from owned168_saved s,owned168_saved b where s.name='source' and b.name='batch'
$$;
set local role human_action_writer;
select pg_temp.ok(pg_temp.observe170forward(275)#>>'{observation,outcome}'='forward_committed','lost forward reply recovers committed operation only');
select pg_temp.ok(pg_temp.observe170forward(275)#>>'{observation,rollbackAllowed}'='false','readback never authorizes automatic undo');
reset role;
rollback to before_owned168_forward;
grant select on owned168_saved to human_action_writer;
create function pg_temp.observe170unknown() returns jsonb language sql as $$
 select public.observe_owned_execution_effect(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(276),
 (s.v->>'planId')::uuid,(s.v->>'actionId')::uuid,(b.v#>>'{batch,id}')::uuid)
 from owned168_saved s,owned168_saved b where s.name='source' and b.name='batch'
$$;
set local role human_action_writer;
select pg_temp.ok(pg_temp.observe170unknown()#>>'{observation,outcome}'='unknown','absent operation never proves no effect');
select pg_temp.ok(pg_temp.observe170unknown()#>>'{observation,currentMatchesLastCommit}' is null,'absent operation has no invented current commit match');
select pg_temp.ok(pg_temp.observe170unknown()#>>'{observation,retryAllowed}'='false','absent operation never allows automatic retry');
reset role;
select pg_temp.ok((select count(*)=0 from owned_synthetic.operations),'unknown observation leaves target and journal untouched');
rollback;
