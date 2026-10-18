-- Genuine custody-prefix + owned disposable PostgreSQL ONLY. SQL session/factor
-- fixtures are explicit stand-ins, never claimed as browser MFA/signed approval.
alter table auth.sessions add column if not exists created_at timestamptz not null default clock_timestamp();
insert into public.mfa_session_attestations(user_id,session_id,factor_id,satisfied_at,expires_at)
 select pg_temp.id(n),pg_temp.id(100+n)::text,pg_temp.id(40+n),clock_timestamp()-interval '1 second',clock_timestamp()+interval '15 minutes' from generate_series(1,5)n;
-- Additional synthetic admin demonstrates the exact dual-capability matrix.
insert into auth.users(id,email) values(pg_temp.id(6),'owned167-admin@example.invalid');
insert into public.users(id,email,is_axiom_internal) values(pg_temp.id(6),'owned167-admin@example.invalid',false);
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.pg_id(1),pg_temp.id(6),'admin');
insert into auth.sessions(id,user_id,not_after) values(pg_temp.id(106),pg_temp.id(6),null);
insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted) values(pg_temp.id(46),pg_temp.id(6),'totp','active','synthetic-sealed');
insert into public.mfa_session_attestations(user_id,session_id,factor_id,satisfied_at,expires_at)
 values(pg_temp.id(6),pg_temp.id(106)::text,pg_temp.id(46),clock_timestamp()-interval '1 second',clock_timestamp()+interval '15 minutes');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('owned167-test',clock_timestamp(),'fixture','Synthetic only',0);
insert into public.engagements(id,tenant_id,estate_id,library_version,title)
 values(pg_temp.pg_id(170),pg_temp.pg_id(1),pg_temp.pg_id(3),'owned167-test','Owned measured human demonstration');
insert into owned_synthetic.resources(fixture_id,resource_id) select pg_temp.pg_id(171),pg_temp.pg_id(180+n) from generate_series(1,4)n;
insert into owned_synthetic.bindings(id,tenant_id,connector_id,engagement_id,fixture_id,resource_id,environment,label,scope,custody_policy_id,custody_activation_epoch,engine_sha256,capability_sha256,approval_reference,expires_at)
 select pg_temp.pg_id(190+n),pg_temp.pg_id(1),pg_temp.pg_id(6),pg_temp.pg_id(170),pg_temp.pg_id(171),pg_temp.pg_id(180+n),'test',
 'Owned synthetic audit configuration','owned_synthetic_config.audit_log_enable','99143000-0000-4000-8000-000000000021',1,
 owned_synthetic.engine_sha256(),'a5b3db560e0707307c69aa70dc6bd62ad4a4ae0612c39f9420db6d99c4a20fb9',pg_temp.pg_id(200+n),clock_timestamp()+interval '15 minutes' from generate_series(1,4)n;
create temporary table human167_saved(n int primary key,request jsonb,digest text,proof jsonb,validation text,receipt jsonb);
insert into human167_saved(n,request,proof)
 select n,jsonb_build_object('operationKey',pg_temp.pg_id(210+n),'bindingId',pg_temp.pg_id(190+n),'engagementId',pg_temp.pg_id(170),
 'expectedSnapshotHash',owned_synthetic.snapshot_sha256(public.read_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(190+n),pg_temp.pg_id(170))),
 'reason','Explicit synthetic-only boolean configuration demonstration','acknowledgeOwnedSynthetic',true,'actionType','config.audit_log_enable','desiredEnabled',true),
 public.measure_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(190+n),pg_temp.pg_id(170)) from generate_series(1,4)n;
update human167_saved set digest=owned_synthetic.snapshot_sha256(jsonb_build_object('tenantId',pg_temp.pg_id(1),'actorId',pg_temp.id(1),'request',request)),validation=owned_synthetic.snapshot_sha256(proof);
grant select,update on human167_saved to human_action_writer;
create function pg_temp.human167_prepare(n int) returns jsonb language sql as $$
 select public.prepare_owned_human_plan(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),(s.request->>'operationKey')::uuid,s.request,s.digest) from human167_saved s where s.n=$1
$$;
create function pg_temp.human167_record(n int) returns jsonb language sql as $$
 select public.record_owned_measured_plan(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),(s.request->>'operationKey')::uuid,s.digest,
 (s.request->>'bindingId')::uuid,(s.request->>'engagementId')::uuid,s.proof,s.validation) from human167_saved s where s.n=$1
$$;
create function pg_temp.human167_refused(statement text,code text default '42501') returns void language plpgsql as $$
begin
 begin execute statement;exception when others then if sqlstate=code then return;end if;raise;end;
 raise exception 'Owned human statement unexpectedly accepted';
end $$;
-- Ordinary backend, browser and target roles cannot use the human source.
select pg_temp.ok(not has_function_privilege('service_role','public.prepare_owned_human_plan(uuid,uuid,uuid,uuid,jsonb,text)','EXECUTE'),'broad backend cannot create owned human source');
select pg_temp.ok(not has_function_privilege('owned_target_controller','public.record_owned_measured_plan(uuid,uuid,uuid,uuid,text,uuid,uuid,jsonb,text)','EXECUTE'),'target controller cannot create plans');
select pg_temp.ok(not has_table_privilege('human_action_writer','owned_synthetic.human_requests','UPDATE'),'human writer cannot alter journal directly');
set local role human_action_writer;
select pg_temp.ok(public.verify_owned_human_plan_authority(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101))='{"verified":true}','live owner session accepted');
select pg_temp.human167_refused('select public.verify_owned_human_plan_authority(pg_temp.pg_id(1),pg_temp.id(3),pg_temp.id(103))');
select pg_temp.human167_refused('select public.verify_owned_human_plan_authority(pg_temp.pg_id(1),pg_temp.id(4),pg_temp.id(104))');
select pg_temp.human167_refused('select public.verify_owned_human_plan_authority(pg_temp.pg_id(1),pg_temp.id(5),pg_temp.id(105))');
select pg_temp.human167_refused('select public.verify_owned_human_plan_authority(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(104))');
select pg_temp.ok(public.verify_owned_human_plan_authority(pg_temp.pg_id(1),pg_temp.id(6),pg_temp.id(106))='{"verified":true}','live admin session accepted');
select pg_temp.human167_refused('select public.verify_owned_human_plan_authority(pg_temp.pg_id(1),pg_temp.id(2),pg_temp.id(102))');
reset role;
select public.designate_platform_founder(pg_temp.id(2),'synthetic native fixture','Explicit disposable founder authority fixture');
set local role human_action_writer;
select pg_temp.ok(public.verify_owned_human_plan_authority(pg_temp.pg_id(1),pg_temp.id(2),pg_temp.id(102))='{"verified":true}','live designated internal founder accepted');
select pg_temp.ok(jsonb_array_length(public.read_owned_human_targets(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(170))->'targets')=4,'normal owner target list returns enrolled synthetic resources');
select pg_temp.ok(pg_temp.human167_prepare(1)->>'state'='pending','prepare retains pending source');
select pg_temp.ok(pg_temp.human167_prepare(1)->>'state'='pending','exact prepare replay recovers original source');
select pg_temp.human167_refused('select public.prepare_owned_human_plan(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(211),(select request||''{"desiredEnabled":false}''::jsonb from human167_saved where n=1),(select digest from human167_saved where n=1))','22023');
update human167_saved set receipt=pg_temp.human167_record(1) where n=1;
select pg_temp.ok(pg_temp.human167_record(1)=(select receipt from human167_saved where n=1),'exact measured persistence recovers original plan receipt');
select pg_temp.ok(pg_temp.human167_prepare(1)->>'state'='recorded','prepared recovery returns retained measured validation');
select pg_temp.human167_refused('select public.cancel_owned_human_request(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(211),(select digest from human167_saved where n=1),pg_temp.pg_id(230),''Cannot cancel an already recorded plan'')');
select pg_temp.ok(pg_temp.human167_prepare(2)->>'state'='pending','second source prepared');
select pg_temp.ok(pg_temp.human167_prepare(3)->>'state'='pending','third source prepared');
select pg_temp.ok(pg_temp.human167_prepare(4)->>'state'='pending','fourth source prepared');
reset role;
select pg_temp.ok((select count(*)=1 from public.remediation_plans where library_version='owned167-test'),'replays never create another plan');
select pg_temp.ok((select count(*)=1 from public.remediation_actions where plan_id=(select(receipt->>'planId')::uuid from human167_saved where n=1)
 and parameters='{"enabled":true}' and closes_finding_ids='{}' and approval_token_id is null and approval_status='draft'
 and rollback_validated and dry_run_status='dry_run_complete' and latest_dry_run_id is not null),'one fixed measured action has validated rollback, recorded dry run, no token and no finding closure');
select pg_temp.ok((select count(*)=0 from owned_synthetic.operations),'human source performs no target write');
select pg_temp.ok((select bool_and(version=0 and not audit_log_enabled) from owned_synthetic.resources),'all actual source values remain unchanged');
-- Failed live authority/source/proof changes roll back without a replacement plan.
do $$begin
 begin update public.mfa_session_attestations set revoked_at=clock_timestamp() where user_id=pg_temp.id(1);
 set local role human_action_writer;perform pg_temp.human167_record(2);raise exception 'revoked MFA accepted';exception when insufficient_privilege then null;end;
 begin update public.tenant_users set role='approver' where tenant_id=pg_temp.pg_id(1) and user_id=pg_temp.id(1);
 set local role human_action_writer;perform pg_temp.human167_record(2);raise exception 'approver source accepted';exception when insufficient_privilege then null;end;
 begin update owned_synthetic.resources set version=1 where resource_id=pg_temp.pg_id(182);
 set local role human_action_writer;perform pg_temp.human167_record(2);raise exception 'stale source accepted';exception when serialization_failure then null;end;
 begin update public.kill_switch_state set engaged=true where scope='global';
 set local role human_action_writer;perform pg_temp.human167_record(2);raise exception 'killed source accepted';exception when insufficient_privilege then null;end;
 begin update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=pg_temp.id(101);
 set local role human_action_writer;perform pg_temp.human167_record(2);raise exception 'expired session accepted';exception when insufficient_privilege then null;end;
 begin update human167_saved set proof=jsonb_set(proof,'{persistent_mutations}','1') where n=2;
 set local role human_action_writer;perform pg_temp.human167_record(2);raise exception 'fabricated measurement accepted';exception when serialization_failure then null;end;
end $$;
reset role;
-- Cancellation/outcome remain usable after target custody is no longer live.
update owned_synthetic.bindings set state='revoked' where id=pg_temp.pg_id(193);
set local role human_action_writer;
update human167_saved set receipt=public.cancel_owned_human_request(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(213),digest,pg_temp.pg_id(233),'Stop this unrecorded synthetic request') where n=3;
select pg_temp.ok(public.cancel_owned_human_request(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(213),(select digest from human167_saved where n=3),pg_temp.pg_id(233),'Stop this unrecorded synthetic request')=(select receipt from human167_saved where n=3),'exact cancellation replay preserves receipt');
select pg_temp.ok(public.read_owned_human_request_outcome(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(213),(select digest from human167_saved where n=3))->>'state'='cancelled','cancelled outcome survives revoked target binding');
select pg_temp.human167_refused('select pg_temp.human167_record(3)');
select pg_temp.human167_refused('select public.cancel_owned_human_request(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(213),(select digest from human167_saved where n=3),pg_temp.pg_id(234),''Changed cancellation request identity'')','23505');
select pg_temp.human167_refused('select public.read_owned_human_request_outcome(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(211),repeat(''0'',64))');
reset role;
select pg_temp.human167_refused('update owned_synthetic.human_requests set state=''pending'' where operation_key=pg_temp.pg_id(211)');
select pg_temp.human167_refused('delete from owned_synthetic.human_requests');
select pg_temp.ok((select count(*)=0 from public.verify_ledger(pg_temp.pg_id(1))),'all source receipts preserve append-only ledger chain');
select pg_temp.ok((select count(*)=1 from public.remediation_plans where library_version='owned167-test'),'all refusals/cancellations leave exactly the original plan');
rollback;
