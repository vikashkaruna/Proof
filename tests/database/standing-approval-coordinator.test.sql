-- Prefix emits a real measured167 plan with explicit disposable169 enrollment
-- stand-ins. Actual BFF HMAC/TOTP and deployed scheduling are separate gates.
set local role human_action_writer;
select pg_temp.human167_prepare(1);
update human167_saved set receipt=pg_temp.human167_record(1)where n=1;
reset role;
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status)values(pg_temp.pg_id(900),pg_temp.pg_id(1),'karya','spiffe://local.axiomproof.test/agent/karya','active');
create temporary table standing173_saved(name text primary key,v jsonb);
grant select,insert,update on standing173_saved to human_action_writer,service_role,agent_ledger_writer;
set local role human_action_writer;
insert into standing173_saved values('policy',public.create_standing_policy(pg_temp.pg_id(1),'Measured standing SQL fixture','{"action_types":["config.audit_log_enable"],"max_actions":1,"environments":["test"]}',clock_timestamp()+interval '10 minutes',pg_temp.id(1),pg_temp.id(6),pg_temp.pg_id(901)));
reset role;
-- No legacy approvedById row alone authorizes unattended work.
set local role agent_ledger_writer;
select pg_temp.ok(public.reserve_standing_policy_work()='{"work":[]}'::jsonb,'legacy policy not adopted automatically');
reset role;
create function pg_temp.standing173_intent(phase text,operation int)returns text language sql as $$
 select controller_security.canonical_questionnaire_json(jsonb_build_object('phase',$1,'request',case when $1='request'then
 jsonb_build_object('schemaVersion',1,'operationKey',pg_temp.pg_id($2),'tenantId',pg_temp.pg_id(1),'ownerId',pg_temp.id(1),'reviewerId',pg_temp.id(6),'previousRevisionId',null,
 'source',controller_security.standing173_source(pg_temp.pg_id(1),(select(receipt->>'planId')::uuid from human167_saved where n=1),(select(v#>>'{policy,id}')::uuid from standing173_saved where name='policy')),
 'expiresAt',to_char((clock_timestamp()+interval '4 minutes')at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'maxAuthorizations',1,'mode','individual','concurrency',1,'stopOnFailure',true,'reason','Explicit reviewed one-action standing SQL fixture')
 else jsonb_build_object('schemaVersion',1,'operationKey',pg_temp.pg_id($2),'revisionId',(select((v->>'text')::jsonb#>>'{request,operationKey}')::uuid from standing173_saved where name='request'),'requestSha256',(select encode(sha256(convert_to(v->>'text','UTF8')),'hex')from standing173_saved where name='request'),'reason','Explicit exact standing decision SQL fixture')end))
$$;
insert into standing173_saved values('request',jsonb_build_object('text',pg_temp.standing173_intent('request',902)));
insert into standing173_saved values('approve',jsonb_build_object('text',pg_temp.standing173_intent('approve',903)));
insert into standing173_saved values('revoke',jsonb_build_object('text',pg_temp.standing173_intent('revoke',904)));
create function pg_temp.standing173_mfa(intent text,actor int)returns uuid language plpgsql as $$
declare v jsonb:=intent::jsonb;op uuid:=(v#>>'{request,operationKey}')::uuid;digest text;binding text;ch jsonb;challenge uuid;begin
 digest:=encode(sha256(convert_to(intent,'UTF8')),'hex');binding:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.standing-policy.'||(v->>'phase'),1,pg_temp.pg_id(1)::text,pg_temp.id(actor)::text,pg_temp.id(100+actor)::text,digest)),'UTF8')),'hex');
 set local role service_role;
 ch:=public.issue_standing_policy_mfa_challenge(pg_temp.pg_id(1),pg_temp.id(actor),pg_temp.id(100+actor),pg_temp.id(40+actor),op,binding,300000);challenge:=(ch->>'id')::uuid;
 reset role;
 -- Explicit SQL factor-counter stand-in. Actual verifier regression is separate.
 update public.mfa_challenges set attempts=1 where id=challenge;
 set local role service_role;
 perform public.satisfy_standing_policy_mfa_challenge(pg_temp.pg_id(1),pg_temp.id(actor),pg_temp.id(100+actor),pg_temp.id(40+actor),op,binding,challenge,1,'totp');
 perform public.consume_standing_policy_mfa_challenge(pg_temp.pg_id(1),pg_temp.id(actor),pg_temp.id(100+actor),pg_temp.id(40+actor),op,binding,challenge,1,op);
 reset role;return challenge;
end $$;
create function pg_temp.standing173_record(name text,actor int)returns jsonb language plpgsql as $$
declare intent text;challenge uuid;result jsonb;begin
 select v->>'text'into strict intent from standing173_saved where standing173_saved.name=$1;
 challenge:=pg_temp.standing173_mfa(intent,actor);
 set local role human_action_writer;
 result:=public.record_standing_policy_revision(pg_temp.pg_id(1),pg_temp.id(actor),pg_temp.id(100+actor),intent,challenge);
 reset role;return result;
end $$;
create function pg_temp.standing173_refused(q text,code text default '42501')returns void language plpgsql as $$begin
 begin execute q;exception when others then if sqlstate=code then return;end if;raise;end;
 raise exception 'Standing statement unexpectedly succeeded';end $$;
-- Exact separation: broad backend may prepare/read, never seal/issue/kernel;
-- the agent writer cannot forge a human decision or use the interactive issuer.
select pg_temp.ok(not has_function_privilege('service_role','public.issue_standing_policy_approval(uuid,uuid,text,jsonb)','EXECUTE'),'broad backend cannot issue standing token');
select pg_temp.ok(not has_function_privilege('service_role','public.seal_standing_policy_delegation(uuid,uuid,text)','EXECUTE'),'broad backend cannot seal delegation');
select pg_temp.ok(not has_function_privilege('agent_ledger_writer','public.record_standing_policy_revision(uuid,uuid,uuid,text,uuid)','EXECUTE'),'agent cannot record human decision');
select pg_temp.ok(not has_function_privilege('service_role','controller_security.issue_plan_approval173(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid,uuid)','EXECUTE'),'backend cannot call extended private kernel');
select pg_temp.ok(not has_function_privilege('agent_ledger_writer','controller_security.issue_plan_approval173(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid,uuid)','EXECUTE'),'agent cannot call extended private kernel');
select pg_temp.ok(not has_table_privilege('agent_ledger_writer','controller_security.standing173_requests','INSERT'),'agent cannot forge retained human authority');
set local role service_role;
select pg_temp.standing173_refused('select public.reserve_standing_policy_work()');
reset role;
-- Request needs the actual current owner, scope and measured source; reviewer
-- approval is a second current session/factor decision, not approvedById.
select pg_temp.standing173_refused('select public.preflight_standing_policy_revision(pg_temp.pg_id(1),pg_temp.id(6),pg_temp.id(106),(select v->>''text''from standing173_saved where name=''request''))');
insert into standing173_saved values('ownerReceipt',pg_temp.standing173_record('request',1));
set local role agent_ledger_writer;
select pg_temp.ok(public.reserve_standing_policy_work()='{"work":[]}'::jsonb,'owner request alone confers no work');
reset role;
select pg_temp.standing173_refused('select public.preflight_standing_policy_revision(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),(select v->>''text''from standing173_saved where name=''approve''))');
insert into standing173_saved values('reviewReceipt',pg_temp.standing173_record('approve',6));
set local role human_action_writer;
select pg_temp.ok(public.read_standing_policy_revision_operation(pg_temp.pg_id(1),pg_temp.id(6),pg_temp.id(106),(select v->>'text'from standing173_saved where name='approve'))=(select v from standing173_saved where name='reviewReceipt'),'lost human reply returns original receipt');
reset role;
set local role agent_ledger_writer;
insert into standing173_saved values('sealWork',public.reserve_standing_policy_work());
insert into standing173_saved select 'sealClaim',public.claim_standing_policy_work(pg_temp.pg_id(1),(v#>>'{work,0,workId}')::uuid)from standing173_saved where name='sealWork';
select pg_temp.ok((select v->>'kind'='seal'and v->>'state'='claimed'from standing173_saved where name='sealClaim'),'dedicated seal claim before token');
select pg_temp.ok(public.claim_standing_policy_work(pg_temp.pg_id(1),(select(v->>'workId')::uuid from standing173_saved where name='sealClaim'))->>'state'='unconfirmed','repeated claim cannot relaunch original work');
-- Signature is an explicit SQL stand-in, actual domain HMAC is independently
-- verified by23 engine tests before the BFF can call this private writer.
insert into standing173_saved select 'sealReceipt',public.seal_standing_policy_delegation(pg_temp.pg_id(1),(v->>'workId')::uuid,repeat('a',64))from standing173_saved where name='sealClaim';
select pg_temp.ok((select v->>'state'='sealed'from standing173_saved where name='sealReceipt'),'reviewed exact delegation sealed once');
select pg_temp.ok(public.seal_standing_policy_delegation(pg_temp.pg_id(1),(select(v->>'workId')::uuid from standing173_saved where name='sealClaim'),repeat('a',64))=(select v from standing173_saved where name='sealReceipt'),'lost seal reply recovers original');
insert into standing173_saved values('approvalWork',public.reserve_standing_policy_work());
insert into standing173_saved select 'approvalClaim',public.claim_standing_policy_work(pg_temp.pg_id(1),(v#>>'{work,0,workId}')::uuid)from standing173_saved where name='approvalWork';
reset role;
insert into standing173_saved select 'tokenPayload',jsonb_build_object('planId',v#>'{currentSource,planId}','actionIds',jsonb_build_array(v#>'{currentSource,actionId}'),'approverId',v#>'{delegation,request,reviewerId}','mode','individual','concurrency',1,'stopOnFailure',true,
 'nonce',v->>'nonce','expiresAt',v->>'tokenExpiresAt','contentDigest',v#>>'{currentSource,contentDigest}','conditions',controller_security.standing173_conditions(pg_temp.pg_id(1),(v->>'workId')::uuid))from standing173_saved where name='approvalClaim';
-- Current authority/source gates hold under final issuance locks, and every
-- failure leaves the existing one-shot claimed work unchanged for reconciliation.
do $$begin
 begin update public.tenant_users set approval_scopes='{sql.other}'where tenant_id=pg_temp.pg_id(1)and user_id=pg_temp.id(6);
 set local role agent_ledger_writer;perform pg_temp.standing173_refused('select public.issue_standing_policy_approval(pg_temp.pg_id(1),(select(v->>''workId'')::uuid from standing173_saved where name=''approvalClaim''),repeat(''b'',64),(select v from standing173_saved where name=''tokenPayload''))');reset role;
 raise sqlstate 'P1730' using message='rollback scoped refusal';exception when sqlstate 'P1730'then null;end;
 begin update public.workload_identities set status='disabled'where id=pg_temp.pg_id(900);
 set local role agent_ledger_writer;perform pg_temp.standing173_refused('select public.issue_standing_policy_approval(pg_temp.pg_id(1),(select(v->>''workId'')::uuid from standing173_saved where name=''approvalClaim''),repeat(''b'',64),(select v from standing173_saved where name=''tokenPayload''))');reset role;
 raise sqlstate 'P1730' using message='rollback workload refusal';exception when sqlstate 'P1730'then null;end;
end $$;
set local role agent_ledger_writer;
select pg_temp.standing173_refused('select public.issue_standing_policy_approval(pg_temp.pg_id(1),(select(v->>''workId'')::uuid from standing173_saved where name=''approvalClaim''),repeat(''b'',64),(select v||''{"nonce":"00000000000000000000000000000000"}''::jsonb from standing173_saved where name=''tokenPayload''))');
insert into standing173_saved select 'issued',public.issue_standing_policy_approval(pg_temp.pg_id(1),(select(v->>'workId')::uuid from standing173_saved where name='approvalClaim'),repeat('b',64),v)from standing173_saved where name='tokenPayload';
select pg_temp.ok(public.issue_standing_policy_approval(pg_temp.pg_id(1),(select(v->>'workId')::uuid from standing173_saved where name='approvalClaim'),repeat('b',64),(select v from standing173_saved where name='tokenPayload'))=(select v from standing173_saved where name='issued'),'lost issuance returns original token/receipt');
select pg_temp.ok(public.reserve_standing_policy_work()='{"work":[]}'::jsonb,'one revision cannot authorize another token');
reset role;
select pg_temp.ok((select count(*)=1 from public.approval_tokens where id=(select(v->>'tokenId')::uuid from standing173_saved where name='issued')and approver_id=pg_temp.id(6)and status='issued'),'one token retains original actual named reviewer');
select pg_temp.ok((select actor_type='agent'and actor_id='standing-policy-coordinator'from public.audit_ledger where tenant_id=pg_temp.pg_id(1)and action_type='approval.token.issued'and approval_token_id=(select(v->>'tokenId')::uuid from standing173_saved where name='issued')),'issuance is agent/policy attributed, never human impersonation');
select pg_temp.ok((select count(*)=0 from owned_synthetic.operations),'standing issuer never mutates target');
select pg_temp.ok((select count(*)=0 from public.execution_batches),'standing issuer never claims execution');
-- Default legacy revoke return/actor behavior is identical when no173 work
-- exists. Deliberate subtransaction rollback preserves its original comparison.
set local role human_action_writer;
insert into standing173_saved values('legacyPolicy',public.create_standing_policy(pg_temp.pg_id(1),'Legacy revoke parity fixture','{"action_types":["config.audit_log_enable"]}',clock_timestamp()+interval '10 minutes',pg_temp.id(1),pg_temp.id(6),pg_temp.pg_id(980)));
reset role;
do $$declare original jsonb;actual jsonb;policy uuid:=(select(v#>>'{policy,id}')::uuid from standing173_saved where name='legacyPolicy');begin
 begin original:=controller_security.revoke_standing_policy_before173(pg_temp.pg_id(1),policy,pg_temp.id(1),pg_temp.pg_id(981));
 raise sqlstate 'P1730'using message='rollback original comparison';exception when sqlstate 'P1730'then null;end;
 set local role human_action_writer;
 actual:=public.revoke_standing_policy(pg_temp.pg_id(1),policy,pg_temp.id(1),pg_temp.pg_id(981));reset role;
 perform pg_temp.ok(actual=original,'legacy no173 revoke preserves original return exactly');
end $$;
-- Both reductions are transactional. Only genuine173 unconsumed tokens retire;
-- a legacy token on the same plan is an explicit SQL table stand-in and stays.
do $$declare token uuid:=(select(v->>'tokenId')::uuid from standing173_saved where name='issued');legacy uuid;begin
 begin
 insert into public.approval_tokens(tenant_id,plan_id,action_ids,approver_id,mode,concurrency,stop_on_failure,signature,signed_payload,nonce,expires_at,status)
 select tenant_id,plan_id,action_ids,approver_id,mode,concurrency,stop_on_failure,signature,signed_payload,repeat('9',32),expires_at,'issued'from public.approval_tokens where id=token returning id into legacy;
 set local role human_action_writer;
 perform public.revoke_standing_policy(pg_temp.pg_id(1),(select(v#>>'{policy,id}')::uuid from standing173_saved where name='policy'),pg_temp.id(1),pg_temp.pg_id(982));reset role;
 perform pg_temp.ok((select status='revoked'and revoked_at is not null from public.approval_tokens where id=token),'base policy revocation retires173 unconsumed token');
 perform pg_temp.ok((select status='issued'from public.approval_tokens where id=legacy),'legacy token untouched');
 raise sqlstate 'P1730'using message='rollback unconsumed comparison';exception when sqlstate 'P1730'then null;end;
 begin update public.approval_tokens set status='consumed',consumed_at=clock_timestamp()where id=token;
 set local role human_action_writer;perform public.revoke_standing_policy(pg_temp.pg_id(1),(select(v#>>'{policy,id}')::uuid from standing173_saved where name='policy'),pg_temp.id(1),pg_temp.pg_id(983));reset role;
 perform pg_temp.ok((select status='consumed'and revoked_at is null from public.approval_tokens where id=token),'consumed historical token not rewritten');
 raise sqlstate 'P1730'using message='rollback consumed comparison';exception when sqlstate 'P1730'then null;end;
end $$;
insert into standing173_saved values('revoked',pg_temp.standing173_record('revoke',1));
select pg_temp.ok((select status='revoked'from public.approval_tokens where id=(select(v->>'tokenId')::uuid from standing173_saved where name='issued')),'fresh human revocation retires only original unconsumed token');

-- A second explicitly reviewed revision authorizes only a different measured
-- action. Lose its approval handoff and recover by reading; never relaunch it.
set local role human_action_writer;
select pg_temp.human167_prepare(2);
update human167_saved set receipt=pg_temp.human167_record(2)where n=2;
reset role;
update standing173_saved set name='archived_'||name where name in('request','approve','revoke');
insert into standing173_saved select 'request',jsonb_build_object('text',controller_security.canonical_questionnaire_json(jsonb_build_object('phase','request','request',
 (v->>'text')::jsonb->'request'||jsonb_build_object('operationKey',pg_temp.pg_id(912),'previousRevisionId',pg_temp.pg_id(902),
 'source',controller_security.standing173_source(pg_temp.pg_id(1),(select(receipt->>'planId')::uuid from human167_saved where n=2),((v->>'text')::jsonb#>>'{request,source,policyId}')::uuid),
 'expiresAt',to_char((clock_timestamp()+interval '4 seconds')at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))))from standing173_saved where name='archived_request';
insert into standing173_saved values('approve',jsonb_build_object('text',pg_temp.standing173_intent('approve',913)));
select pg_temp.standing173_record('request',1);
select pg_temp.standing173_record('approve',6);
set local role agent_ledger_writer;
insert into standing173_saved values('orphanSeal',public.reserve_standing_policy_work());
select public.claim_standing_policy_work(pg_temp.pg_id(1),(select(v#>>'{work,0,workId}')::uuid from standing173_saved where name='orphanSeal'));
select public.seal_standing_policy_delegation(pg_temp.pg_id(1),(select(v#>>'{work,0,workId}')::uuid from standing173_saved where name='orphanSeal'),repeat('c',64));
insert into standing173_saved values('orphanWork',public.reserve_standing_policy_work());
insert into standing173_saved select 'orphanClaim',public.claim_standing_policy_work(pg_temp.pg_id(1),(v#>>'{work,0,workId}')::uuid)from standing173_saved where name='orphanWork';
select pg_temp.ok(public.reserve_standing_policy_work()=(select v from standing173_saved where name='orphanWork'),'pending handoff blocks another reservation');
select pg_temp.ok(public.claim_standing_policy_work(pg_temp.pg_id(1),(select(v->>'workId')::uuid from standing173_saved where name='orphanClaim'))->>'state'='unconfirmed','restart reads original claimed handoff without relaunch');
reset role;
-- Original immutable deadline is allowed to expire naturally, never rewritten.
select pg_sleep(4.1);
set local role agent_ledger_writer;
select pg_temp.ok(public.read_standing_policy_work(pg_temp.pg_id(1),(select(v->>'workId')::uuid from standing173_saved where name='orphanClaim'))->>'state'='unconfirmed','expired claimed handoff remains uncertain');
select pg_temp.ok(public.reserve_standing_policy_work()='{"work":[]}'::jsonb,'uncertain revision cannot mint replacement work');
reset role;
select pg_temp.ok(exists(select 1 from controller_security.standing173_suspensions where revision_id=pg_temp.pg_id(912)),'orphan suspension is durable and original-revision specific');
select pg_temp.ok((select count(*)=0 from public.approval_tokens where plan_id=(select(receipt->>'planId')::uuid from human167_saved where n=2)),'orphan never creates an execution approval');
rollback;
