-- OWNED DISPOSABLE SQL ONLY. Source prefix is the genuine custody fixture and
-- owned169 source/fence/queue suite. Host observations, consumed factor counters,
-- token signature, files, SPIRE/controller observations below are explicit ADMIN
-- STAND-INS. They test SQL authority and real resource/revocation state, never
-- browser MFA, actual host deployment, HMAC or real HTTP JWT cryptography.
select public.designate_platform_founder(pg_temp.id(2),'owned169 SQL fixture','Explicit disposable founder authority only');
select set_config('axiom.platform_founder_sync','on',true);
delete from public.tenant_users where tenant_id=pg_temp.pg_id(1) and user_id=pg_temp.id(2);
-- Explicit removal re-derives the cache; fault-inject that derived row too.
select set_config('axiom.platform_founder_sync','on',true);
delete from public.tenant_users where tenant_id=pg_temp.pg_id(1) and user_id=pg_temp.id(2) and membership_source='platform_founder';
select set_config('axiom.platform_founder_sync','off',true);
select pg_temp.ok(not exists(select 1 from public.tenant_users where tenant_id=pg_temp.pg_id(1) and user_id=pg_temp.id(2)),'founder fixture actually has no tenant membership');
create temporary table enrollment169_saved(name text primary key,v jsonb);
grant select,insert,update on enrollment169_saved to human_action_writer,service_role,owned_target_controller;
insert into enrollment169_saved select 'host',jsonb_build_object('hostInstallerSha256',manifest#>>'{source,hostInstallerSha256}','images',jsonb_build_object('controllerImage',manifest#>'{deployment,controllerImage}','workerImage',manifest#>'{deployment,workerImage}','bffImage',manifest#>'{deployment,bffImage}'),'bffContainerId',manifest#>'{deployment,bffContainerId}','workloadApiVolume',manifest#>'{deployment,workloadApiVolume}','nodeId',manifest#>'{deployment,nodeId}','karyaIdentity',null,'persistentMutations',0) from deployment169_saved where n=1;
set local role human_action_writer;
select public.prepare_owned_deployment_preflight(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(301),jsonb_build_object('operationKey',pg_temp.pg_id(341),'expectedManifestSha256',(select request->>'manifestSha256' from deployment169_saved where n=1)));
reset role;
set local role service_role;
select public.claim_owned_deployment_preflight(pg_temp.pg_id(341),pg_temp.pg_id(351));
select pg_temp.deployment169_refused('select public.record_owned_deployment_preflight(pg_temp.pg_id(341),pg_temp.pg_id(351),(select v||''{"bffContainerId":"foreign"}''::jsonb from enrollment169_saved where name=''host''))');
insert into enrollment169_saved values('preflight',public.record_owned_deployment_preflight(pg_temp.pg_id(341),pg_temp.pg_id(351),(select v from enrollment169_saved where name='host')));
select pg_temp.ok((select v->>'state'='preflight_ready' and v#>>'{preflight,dryRunCompleted}'='true' and v#>>'{preflight,rollbackValidated}'='true' from enrollment169_saved where name='preflight'),'measured no-write host/DB observations and actual reducer become reviewable');
select pg_temp.ok(public.record_owned_deployment_preflight(pg_temp.pg_id(341),pg_temp.pg_id(351),(select v from enrollment169_saved where name='host'))=(select v from enrollment169_saved where name='preflight'),'lost observation reply recovers same digest and receipt');
reset role;
select pg_temp.ok((select count(*)=0 from owned_synthetic.resources),'completed deployment dry-run changed no target rows');
insert into enrollment169_saved select 'decision',jsonb_build_object('operationKey',pg_temp.pg_id(372),'expectedManifestSha256',v->>'manifestSha256','expectedPreflightSha256',v#>>'{preflight,sha256}','expectedRollbackSha256',v#>>'{preflight,rollbackSha256}','reason','Approve only this disposable enrollment authority','acknowledgeOwnedSynthetic',true) from enrollment169_saved where name='preflight';
set local role human_action_writer;
insert into enrollment169_saved values('prepared',public.prepare_owned_deployment_decision(pg_temp.pg_id(1),pg_temp.id(2),pg_temp.id(102),pg_temp.pg_id(301),(select v from enrollment169_saved where name='decision')));
reset role;
set local role service_role;
insert into enrollment169_saved values('challenge',public.issue_owned_deployment_mfa_challenge(pg_temp.pg_id(1),pg_temp.id(2),pg_temp.id(102),pg_temp.id(42),pg_temp.pg_id(372),(select v->>'boundPayloadSha256' from enrollment169_saved where name='prepared'),300000));
reset role;
-- Only this explicit SQL fixture attests the factor attempt. Actual BFF tests
-- require real verifier/counter/rate-limiter behavior; no code is stored here.
update public.mfa_challenges set attempts=1 where id=(select(v->>'id')::uuid from enrollment169_saved where name='challenge');
set local role service_role;
select public.satisfy_owned_deployment_mfa_challenge(pg_temp.pg_id(1),pg_temp.id(2),pg_temp.id(102),pg_temp.id(42),pg_temp.pg_id(372),(select v->>'boundPayloadSha256' from enrollment169_saved where name='prepared'),(select(v->>'id')::uuid from enrollment169_saved where name='challenge'),1,'totp');
select public.consume_owned_deployment_mfa_challenge(pg_temp.pg_id(1),pg_temp.id(2),pg_temp.id(102),pg_temp.id(42),pg_temp.pg_id(372),(select v->>'boundPayloadSha256' from enrollment169_saved where name='prepared'),(select(v->>'id')::uuid from enrollment169_saved where name='challenge'),1,pg_temp.pg_id(372));
reset role;
insert into enrollment169_saved select 'token',jsonb_build_object('spec',jsonb_build_object('planId',pg_temp.pg_id(301),'approverId',pg_temp.id(2),'actionIds',(select jsonb_agg(owned_synthetic.deployment_action_id(pg_temp.pg_id(301),step) order by owned_synthetic.deployment_action_id(pg_temp.pg_id(301),step)) from unnest(array['enroll_synthetic_resource','authorize_role_switch','publish_scoped_credential','register_karya_identity','stage_owned_controller','verify_installed_scope']) step),'mode','batch','concurrency',1,'stopOnFailure',true,'expiresAt',clock_timestamp()+interval '2 minutes','nonce',repeat('f',32),'conditions',conditions,'contentDigest',owned_synthetic.snapshot_sha256(jsonb_build_object('domain','owned_synthetic_enrollment_v1','manifest',manifest,'conditions',conditions))),'signature',repeat('f',64))
from(select m.manifest,jsonb_build_object('purpose','owned_synthetic_enrollment_v1','tenantId',pg_temp.pg_id(1),'enrollmentId',pg_temp.pg_id(301),'bindingId',(m.manifest->>'bindingId')::uuid,'manifestSha256',m.request->>'manifestSha256','preflightSha256',proof.v#>>'{preflight,sha256}','rollbackSha256',proof.v#>>'{preflight,rollbackSha256}','custodyPolicyId',m.manifest->>'custodyPolicyId','custodyEpoch',1,'scopeExpiresAt',m.manifest->>'expiresAt','decisionSha256',owned_synthetic.snapshot_sha256(decision.v)) conditions from deployment169_saved m cross join enrollment169_saved proof cross join enrollment169_saved decision where m.n=1 and proof.name='preflight' and decision.name='decision') fixed;
set local role human_action_writer;
insert into enrollment169_saved values('approved',public.record_owned_deployment_approval(pg_temp.pg_id(1),pg_temp.id(2),pg_temp.id(102),pg_temp.pg_id(301),(select v from enrollment169_saved where name='decision'),(select(v->>'id')::uuid from enrollment169_saved where name='challenge'),(select v from enrollment169_saved where name='token')));
select pg_temp.ok(public.record_owned_deployment_approval(pg_temp.pg_id(1),pg_temp.id(2),pg_temp.id(102),pg_temp.pg_id(301),(select v from enrollment169_saved where name='decision'),(select(v->>'id')::uuid from enrollment169_saved where name='challenge'),(select v from enrollment169_saved where name='token'))=(select v from enrollment169_saved where name='approved'),'approval lost reply recovers before already-consumed MFA check');
select public.prepare_owned_deployment_install(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(301),jsonb_build_object('operationKey',pg_temp.pg_id(380),'expectedManifestSha256',(select v->>'manifestSha256' from enrollment169_saved where name='approved'),'expectedApprovalId',(select v#>>'{approval,approvalId}' from enrollment169_saved where name='approved')));
reset role;
set local role service_role;
select public.claim_next_owned_deployment_task(pg_temp.pg_id(381));
select public.authorize_owned_deployment_step(pg_temp.pg_id(1),pg_temp.pg_id(301),'enroll_synthetic_resource',(select v from enrollment169_saved where name='token'));
select public.authorize_owned_deployment_step(pg_temp.pg_id(1),pg_temp.pg_id(301),'enroll_synthetic_resource',(select v from enrollment169_saved where name='token'));
select public.authorize_owned_deployment_step(pg_temp.pg_id(1),pg_temp.pg_id(301),'authorize_role_switch',(select v from enrollment169_saved where name='token'));
select public.authorize_owned_deployment_step(pg_temp.pg_id(1),pg_temp.pg_id(301),'publish_scoped_credential',(select v from enrollment169_saved where name='token'));
insert into enrollment169_saved values('reservation',public.reserve_owned_deployment_credential(pg_temp.pg_id(1),pg_temp.pg_id(301),pg_temp.pg_id(382)));
reset role;
select pg_temp.ok((select count(*)=1 from owned_synthetic.resources),'recorded founder deployment scope creates one actual dedicated target row');
select pg_temp.ok((select version=0 and not audit_log_enabled from owned_synthetic.resources),'enrollment never performs the remediation action');
select set_config('request.jwt.claims',jsonb_build_object('role','owned_target_controller','owned_target_purpose','owned_synthetic_target_v1','tenant_id',pg_temp.pg_id(1),'binding_id',pg_temp.pg_id(291),'enrollment_id',pg_temp.pg_id(301),'jti',pg_temp.pg_id(382),'custody_epoch',1,'iat',(select v->'issuedAt' from enrollment169_saved where name='reservation'),'exp',(select v->'expiresAtSeconds' from enrollment169_saved where name='reservation'))::text,true);
set local role owned_target_controller;
select pg_temp.ok(public.verify_owned_target_transport(pg_temp.pg_id(1),pg_temp.pg_id(291))->>'transportVerified'='true','reserved role-switched native credential can prove scope without target access');
select pg_temp.deployment169_refused('select public.read_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(291),pg_temp.pg_id(269))');
reset role;
set local role service_role;
select public.complete_owned_deployment_credential(pg_temp.pg_id(1),pg_temp.pg_id(301),pg_temp.pg_id(382),repeat('e',64));
select public.complete_owned_deployment_credential(pg_temp.pg_id(1),pg_temp.pg_id(301),pg_temp.pg_id(382),repeat('e',64));
insert into enrollment169_saved values('published',jsonb_build_object('credentialId',pg_temp.pg_id(382),'credentialSha256',repeat('e',64),'filePublished',true));
select public.confirm_owned_deployment_step(pg_temp.pg_id(1),pg_temp.pg_id(301),'publish_scoped_credential',(select v from enrollment169_saved where name='token'),(select v from enrollment169_saved where name='published'));
select public.authorize_owned_deployment_step(pg_temp.pg_id(1),pg_temp.pg_id(301),'register_karya_identity',(select v from enrollment169_saved where name='token'));
insert into enrollment169_saved select 'identity',jsonb_build_object('entryId','fixture-not-real-spire','spiffeId',manifest#>'{deployment,spiffeId}','parentId',manifest#>'{deployment,nodeId}','workerUid',20005) from deployment169_saved where n=1;
select public.confirm_owned_deployment_step(pg_temp.pg_id(1),pg_temp.pg_id(301),'register_karya_identity',(select v from enrollment169_saved where name='token'),(select v from enrollment169_saved where name='identity'));
select public.authorize_owned_deployment_step(pg_temp.pg_id(1),pg_temp.pg_id(301),'stage_owned_controller',(select v from enrollment169_saved where name='token'));
insert into enrollment169_saved select 'controller',jsonb_build_object('containerId',repeat('a',64),'controllerName',manifest#>'{deployment,controllerName}','controllerImage',manifest#>'{deployment,controllerImage}','workerImage',manifest#>'{deployment,workerImage}','workerUid',20005,'controllerUid',20106,'socketGid',20113,'bffContainerId',manifest#>'{deployment,bffContainerId}','bffImage',manifest#>'{deployment,bffImage}','socketReady',true) from deployment169_saved where n=1;
select public.confirm_owned_deployment_step(pg_temp.pg_id(1),pg_temp.pg_id(301),'stage_owned_controller',(select v from enrollment169_saved where name='token'),(select v from enrollment169_saved where name='controller'));
select public.authorize_owned_deployment_step(pg_temp.pg_id(1),pg_temp.pg_id(301),'verify_installed_scope',(select v from enrollment169_saved where name='token'));
select public.confirm_owned_deployment_step(pg_temp.pg_id(1),pg_temp.pg_id(301),'verify_installed_scope',(select v from enrollment169_saved where name='token'),jsonb_build_object('credential',(select v from enrollment169_saved where name='published'),'identity',(select v from enrollment169_saved where name='identity'),'controller',(select v from enrollment169_saved where name='controller'),'cryptoTransportVerified',true,'allSixReadBack',true));
reset role;
select pg_temp.ok((select state='active' from owned_synthetic.deployment_heads where request_id=pg_temp.pg_id(301)),'only all six confirmed readbacks make the scope active');
set local role owned_target_controller;
select pg_temp.ok(public.read_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(291),pg_temp.pg_id(269))->>'audit_log_enabled'='false','active exact native credential independently reads actual synthetic state');
reset role;
-- Same role but foreign claims remain refused, including explicit null purpose.
do $$declare original text:=current_setting('request.jwt.claims');bad jsonb;begin
 foreach bad in array array[jsonb_build_object('tenant_id',pg_temp.pg_id(2)),jsonb_build_object('binding_id',pg_temp.pg_id(299)),jsonb_build_object('enrollment_id',pg_temp.pg_id(399)),jsonb_build_object('custody_epoch',2),jsonb_build_object('owned_target_purpose',null),jsonb_build_object('jti',pg_temp.pg_id(399)),jsonb_build_object('exp',1)] loop
  perform set_config('request.jwt.claims',(original::jsonb||bad)::text,true);
  set local role owned_target_controller;
  perform pg_temp.deployment169_refused('select public.read_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(291),pg_temp.pg_id(269))');
  reset role;
 end loop;
 perform set_config('request.jwt.claims',original,true);
end $$;
set local role service_role;
select public.rollback_owned_deployment_authority(pg_temp.pg_id(1),pg_temp.pg_id(301),(select v from enrollment169_saved where name='token'));
reset role;
select pg_temp.ok((select state='revoked' from owned_synthetic.bindings where id=pg_temp.pg_id(291)),'validated deployment rollback actually revokes the new binding');
select pg_temp.ok((select count(*)=1 from owned_synthetic.resources where version=0 and not audit_log_enabled),'rollback retains unchanged synthetic target and its history');
select pg_temp.ok((select count(*)=1 from owned_synthetic.deployment_credential_revocations),'rollback appends credential revocation without deleting issuance');
select pg_temp.ok(pg_has_role('authenticator','owned_target_controller','MEMBER'),'rollback preserves reviewed shared role edge');
set local role owned_target_controller;
select pg_temp.deployment169_refused('select public.read_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(291),pg_temp.pg_id(269))');
reset role;
select pg_temp.ok((select count(*)=0 from public.verify_ledger(pg_temp.pg_id(1))),'full native enrollment/revocation flow preserves append-only ledger');
rollback;
