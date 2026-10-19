-- Disposable SQL authority proof only. Prefix creates a genuine measured SQL
-- enrollment with explicit ADMIN MFA/token/host stand-ins, never live approval.
-- The short token expires by actual DB clock; immutable approval is not edited.
select pg_sleep(greatest(0,extract(epoch from ((select(v#>>'{spec,expiresAt}')::timestamptz from enrollment169_saved where name='token')-clock_timestamp())))+0.05);
set local role service_role;
select pg_temp.deployment169_refused('select public.rollback_owned_deployment_authority(pg_temp.pg_id(1),pg_temp.pg_id(301),(select v from enrollment169_saved where name=''token''))');
reset role;
-- Current start authority is deliberately removed through normal founder revoke
-- and role changes. A new current owner with a fresh factor must still stop it.
select public.revoke_platform_founder(pg_temp.id(2),'disposable native fixture','Original enrollment founder no longer authorized');
update public.tenant_users set role='reviewer' where tenant_id=pg_temp.pg_id(1) and user_id=pg_temp.id(1) and membership_source='explicit';
insert into auth.users(id,email) values(pg_temp.id(6),'owned169-new-owner@example.invalid');
insert into public.users(id,email,is_axiom_internal) values(pg_temp.id(6),'owned169-new-owner@example.invalid',false);
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.pg_id(1),pg_temp.id(6),'owner');
insert into auth.sessions(id,user_id,not_after) values(pg_temp.id(106),pg_temp.id(6),null);
insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted) values(pg_temp.id(46),pg_temp.id(6),'totp','active','explicit-disposable-factor-stand-in');
insert into public.mfa_session_attestations(user_id,session_id,factor_id,satisfied_at,expires_at)
 values(pg_temp.id(6),pg_temp.id(106)::text,pg_temp.id(46),clock_timestamp()-interval '1 second',clock_timestamp()+interval '15 minutes');
-- Fault injection only into the custody projection of this disposable fixture;
-- no historical event/approval/ledger is rewritten, no retained deployment.
update public.local_custody_policy_heads set state='revoked' where policy_id=pg_temp.id(21);
select pg_temp.ok(owned_synthetic.deployment_summary((select r from owned_synthetic.deployment_requests r where id=pg_temp.pg_id(301)))#>>'{currentAuthority,state}'='inactive','historical installation does not claim current authority after founder/custody loss');
insert into enrollment169_saved select 'stop',jsonb_build_object('operationKey',pg_temp.pg_id(390),'expectedManifestSha256',v->>'manifestSha256','expectedApprovalId',v#>>'{approval,approvalId}','reason','Current owner stops this exact retained authority','acknowledgeOwnedSynthetic',true) from enrollment169_saved where name='approved';
set local role human_action_writer;
select pg_temp.deployment169_refused('select public.prepare_owned_deployment_revocation(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(301),(select v from enrollment169_saved where name=''stop''))');
insert into enrollment169_saved values('stop_prepared',public.prepare_owned_deployment_revocation(pg_temp.pg_id(1),pg_temp.id(6),pg_temp.id(106),pg_temp.pg_id(301),(select v from enrollment169_saved where name='stop')));
select pg_temp.deployment169_refused('select public.record_owned_deployment_revocation(pg_temp.pg_id(1),pg_temp.id(6),pg_temp.id(106),pg_temp.pg_id(301),(select v from enrollment169_saved where name=''stop''),(select(v->>''id'')::uuid from enrollment169_saved where name=''challenge''))');
reset role;
set local role service_role;
insert into enrollment169_saved values('stop_challenge',public.issue_owned_deployment_revocation_mfa_challenge(pg_temp.pg_id(1),pg_temp.id(6),pg_temp.id(106),pg_temp.id(46),pg_temp.pg_id(390),(select v->>'boundPayloadSha256' from enrollment169_saved where name='stop_prepared'),300000));
reset role;
-- Actual TOTP is BFF-tested separately; this ADMIN fixture attests one attempt.
update public.mfa_challenges set attempts=1 where id=(select(v->>'id')::uuid from enrollment169_saved where name='stop_challenge');
set local role service_role;
select public.satisfy_owned_deployment_revocation_mfa_challenge(pg_temp.pg_id(1),pg_temp.id(6),pg_temp.id(106),pg_temp.id(46),pg_temp.pg_id(390),(select v->>'boundPayloadSha256' from enrollment169_saved where name='stop_prepared'),(select(v->>'id')::uuid from enrollment169_saved where name='stop_challenge'),1,'totp');
select public.consume_owned_deployment_revocation_mfa_challenge(pg_temp.pg_id(1),pg_temp.id(6),pg_temp.id(106),pg_temp.id(46),pg_temp.pg_id(390),(select v->>'boundPayloadSha256' from enrollment169_saved where name='stop_prepared'),(select(v->>'id')::uuid from enrollment169_saved where name='stop_challenge'),1,pg_temp.pg_id(390));
reset role;
set local role human_action_writer;
insert into enrollment169_saved values('stopped',public.record_owned_deployment_revocation(pg_temp.pg_id(1),pg_temp.id(6),pg_temp.id(106),pg_temp.pg_id(301),(select v from enrollment169_saved where name='stop'),(select(v->>'id')::uuid from enrollment169_saved where name='stop_challenge')));
select pg_temp.ok(public.record_owned_deployment_revocation(pg_temp.pg_id(1),pg_temp.id(6),pg_temp.id(106),pg_temp.pg_id(301),(select v from enrollment169_saved where name='stop'),(select(v->>'id')::uuid from enrollment169_saved where name='stop_challenge'))=(select v from enrollment169_saved where name='stopped'),'lost stop reply recovers before consumed MFA check');
select pg_temp.ok(public.read_owned_deployment_operation(pg_temp.pg_id(1),pg_temp.id(6),pg_temp.id(106),pg_temp.pg_id(301),'revoke',pg_temp.pg_id(390))#>>'{data,outcome}'='recorded','durable stop readback binds exact original operation');
reset role;
select pg_temp.ok((select v->>'state'='revoked' and v#>>'{currentAuthority,state}'='inactive' from enrollment169_saved where name='stopped'),'new current owner stops enrollment after original start authority and token expire');
set local role service_role;
select pg_temp.ok(public.read_owned_deployment_task_receipt(pg_temp.pg_id(381))->>'terminal'='authority_revoked_with_original_effect_history','exact human stop receipt proves only authority revocation while original effect history remains');
select pg_temp.ok(public.read_owned_deployment_task_receipt(pg_temp.pg_id(381))->>'requestId'=pg_temp.pg_id(301)::text,'stop receipt remains pinned to original claim request');
reset role;
select pg_temp.ok((select count(*)=1 from owned_synthetic.resources where version=0 and not audit_log_enabled),'fresh stop preserves actual target setting and resource');
select pg_temp.ok((select state='revoked' from owned_synthetic.bindings where id=pg_temp.pg_id(291)),'fresh stop revokes exact binding');
select pg_temp.ok((select count(*)=1 from owned_synthetic.deployment_credential_revocations),'fresh stop appends credential revocation');
select pg_temp.ok(pg_has_role('authenticator','owned_target_controller','MEMBER'),'fresh stop retains reviewed shared role');
select pg_temp.ok((select count(*)=0 from public.verify_ledger(pg_temp.pg_id(1))),'fresh stop preserves complete append-only ledger');
rollback;
