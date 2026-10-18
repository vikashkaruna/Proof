-- Owned disposable PostgreSQL only. Auth session/factor rows below are explicit
-- SQL stand-ins, NOT normal browser MFA, a measured host preflight, HMAC approval,
-- PostgREST crypto transport proof, SPIRE enrollment or any retained deployment.
alter table auth.sessions add column if not exists created_at timestamptz not null default clock_timestamp();
insert into public.mfa_session_attestations(user_id,session_id,factor_id,satisfied_at,expires_at)
 select pg_temp.id(n),pg_temp.id(100+n)::text,pg_temp.id(40+n),clock_timestamp()-interval '1 second',clock_timestamp()+interval '15 minutes' from generate_series(1,5)n;
insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values('owned169-test',clock_timestamp(),'fixture','Synthetic enrollment SQL fixture only',0);
insert into public.engagements(id,tenant_id,estate_id,library_version,title) values(pg_temp.pg_id(269),pg_temp.pg_id(1),pg_temp.pg_id(3),'owned169-test','Owned enrollment source');
create temporary table deployment169_saved(n int primary key,request jsonb,manifest jsonb,digest text,answer jsonb,fence jsonb);
insert into deployment169_saved(n,manifest)
 select n,jsonb_build_object('schemaVersion',1,'purpose','owned_synthetic_enrollment_v1','environment','local',
 'tenantId',pg_temp.pg_id(1),'engagementId',pg_temp.pg_id(269),'connectorId',pg_temp.pg_id(6),'fixtureId',pg_temp.pg_id(270+n),'resourceId',pg_temp.pg_id(280+n),'bindingId',pg_temp.pg_id(290+n),
 'custodyPolicyId','99143000-0000-4000-8000-000000000021','custodyEpoch',1,'scope','owned_synthetic_config.audit_log_enable','label','Owned synthetic audit configuration',
 'source',jsonb_build_object('engineSha256',owned_synthetic.engine_sha256(),'hostInstallerSha256',repeat('e',64),'issuerConfigurationSha256',repeat('f',64),'capabilitySha256','a5b3db560e0707307c69aa70dc6bd62ad4a4ae0612c39f9420db6d99c4a20fb9'),
 'deployment',jsonb_build_object('controllerName','axiom-proof-local-owned-execution-controller','controllerImage','sha256:'||repeat('a',64),'workerImage','sha256:'||repeat('b',64),'bffImage','sha256:'||repeat('c',64),'bffContainerId',repeat('b',64),'workloadApiVolume','axiom-workload-api-local','nodeId','spiffe://local.axiomproof.test/spire/agent/join_token/test','spiffeId','spiffe://local.axiomproof.test/agent/karya','workerUid',20005,'controllerUid',20106,'socketGid',20113,'dockerGid',999,'brokerPort',4000,'role','owned_target_controller','authenticator','authenticator','credentialLifetimeSeconds',600),
 'rollback','{"revokeNewBindingAndCredential":true,"retainResourcesAndJournals":true,"retainSharedRoleAndIdentity":true,"deleteAuditOrEvidence":false,"reverseTargetSetting":false,"requiresFreshRemediationApprovalForTargetUndo":true}'::jsonb,
 'reviewedAt',clock_timestamp()-interval '1 second','expiresAt',clock_timestamp()+interval '1 hour','limitations',jsonb_build_array('Synthetic SQL source fixture only; no actual deployment')) from generate_series(1,3)n;
update deployment169_saved set request=jsonb_build_object('operationKey',pg_temp.pg_id(300+n),'engagementId',pg_temp.pg_id(269),'connectorId',pg_temp.pg_id(6),'manifestSha256',owned_synthetic.snapshot_sha256(manifest),'reason','Explicit owned synthetic enrollment fixture','acknowledgeOwnedSynthetic',true);
update deployment169_saved set digest=owned_synthetic.deployment_operation_sha256(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.pg_id(300+n),pg_temp.pg_id(300+n),jsonb_build_object('phase','request','request',request));
grant select,update on deployment169_saved to human_action_writer,service_role;
create function pg_temp.deployment169_refused(statement text,code text default '42501') returns void language plpgsql as $$begin
 begin execute statement;exception when others then if sqlstate=code then return;end if;raise;end;
 raise exception 'Owned deployment statement unexpectedly accepted';
end $$;
create function pg_temp.deployment169_prepare(n int,actor int default 1) returns jsonb language sql as $$
 select public.prepare_owned_deployment_request(pg_temp.pg_id(1),pg_temp.id(actor),pg_temp.id(100+actor),s.request,s.manifest) from deployment169_saved s where s.n=$1
$$;
select pg_temp.ok(not has_function_privilege('service_role','public.prepare_owned_deployment_request(uuid,uuid,uuid,jsonb,jsonb)','EXECUTE'),'broad service role cannot request human enrollment');
select pg_temp.ok(not has_function_privilege('owned_target_controller','public.fence_owned_deployment_intent(uuid,uuid,uuid,uuid,jsonb)','EXECUTE'),'target controller cannot fence human requests');
set local role human_action_writer;
update deployment169_saved set answer=pg_temp.deployment169_prepare(1) where n=1;
select pg_temp.ok((select answer->>'state'='requested' and answer->'approval'='null'::jsonb and answer->'preflight'='null'::jsonb from deployment169_saved where n=1),'normal owner source creates metadata only');
select pg_temp.ok(pg_temp.deployment169_prepare(1)=(select answer from deployment169_saved where n=1),'exact owner request replay recovers original source');
select pg_temp.deployment169_refused('select pg_temp.deployment169_prepare(2,4)');
select pg_temp.deployment169_refused('select pg_temp.deployment169_prepare(2,3)');
select pg_temp.deployment169_refused('select public.prepare_owned_deployment_request(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),(select request||''{"sql":"arbitrary"}''::jsonb from deployment169_saved where n=2),(select manifest from deployment169_saved where n=2))','22023');
select pg_temp.ok(public.read_owned_deployment_operation(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(301),'request',pg_temp.pg_id(301))#>>'{data,outcome}'='recorded','request operation has authoritative receipt');
-- Fencing an absent initial request wins against its eventual late POST.
update deployment169_saved set fence=jsonb_build_object('operationKey',pg_temp.pg_id(322),'target',jsonb_build_object('phase','request','operationKey',pg_temp.pg_id(302),'canonicalRequestHash',digest),'reason','expired') where n=2;
update deployment169_saved set answer=public.fence_owned_deployment_intent(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(302),fence) where n=2;
select pg_temp.ok((select answer->>'disposition'='fenced_no_mutation' and answer->>'previousState'='not_recorded' from deployment169_saved where n=2),'absent request has immutable no-effect fence');
select pg_temp.ok(public.fence_owned_deployment_intent(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(302),(select fence from deployment169_saved where n=2))=(select answer from deployment169_saved where n=2),'lost fence reply recovers exact original receipt');
select pg_temp.deployment169_refused('select pg_temp.deployment169_prepare(2)');
select pg_temp.ok(public.read_owned_deployment_operation(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(302),'fence',pg_temp.pg_id(322))#>>'{data,phaseResult,receipt,fenceReceiptId}'=(select answer->>'fenceReceiptId' from deployment169_saved where n=2),'fence recovery preserves exact ledger receipt identity');
-- Queue/claim is read-only and never creates a ready preflight or approval.
select pg_temp.ok(public.prepare_owned_deployment_preflight(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(301),jsonb_build_object('operationKey',pg_temp.pg_id(340),'expectedManifestSha256',(select request->>'manifestSha256' from deployment169_saved where n=1)))->>'state'='requested','queued host observation remains pending');
select pg_temp.ok(public.read_owned_deployment_operation(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(301),'preflight',pg_temp.pg_id(340))#>>'{data,outcome}'='unconfirmed','lost queue reply has exact pending operation readback');
select pg_temp.ok(public.prepare_owned_deployment_preflight(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(301),jsonb_build_object('operationKey',pg_temp.pg_id(340),'expectedManifestSha256',(select request->>'manifestSha256' from deployment169_saved where n=1)))->'preflight'='null'::jsonb,'exact queue replay cannot manufacture completed preflight');
select pg_temp.deployment169_refused('select public.prepare_owned_deployment_preflight(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(301),jsonb_build_object(''operationKey'',pg_temp.pg_id(341),''expectedManifestSha256'',(select request->>''manifestSha256'' from deployment169_saved where n=1)))');
reset role;
set local role service_role;
select pg_temp.ok(public.claim_owned_deployment_preflight(pg_temp.pg_id(340),pg_temp.pg_id(350))->>'persistentMutations'='0','private host claim carries no persistent mutation authority');
select pg_temp.ok(public.claim_owned_deployment_preflight(pg_temp.pg_id(340),pg_temp.pg_id(350))->>'claimId'=pg_temp.pg_id(350)::text,'lost claim reply recovers same claim only');
select pg_temp.deployment169_refused('select public.claim_owned_deployment_preflight(pg_temp.pg_id(340),pg_temp.pg_id(351))');
reset role;
set local role human_action_writer;
select public.fence_owned_deployment_intent(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(301),jsonb_build_object('operationKey',pg_temp.pg_id(360),'target',jsonb_build_object('phase','preflight','operationKey',pg_temp.pg_id(340),'canonicalRequestHash',public.read_owned_deployment_operation(pg_temp.pg_id(1),pg_temp.id(1),pg_temp.id(101),pg_temp.pg_id(301),'preflight',pg_temp.pg_id(340))#>>'{data,canonicalRequestHash}'),'reason','superseded_after_no_effect'));
reset role;
set local role service_role;
select pg_temp.deployment169_refused('select public.claim_owned_deployment_preflight(pg_temp.pg_id(340),pg_temp.pg_id(350))');
reset role;
select pg_temp.ok((select count(*)=1 from owned_synthetic.deployment_preflight_claims),'single claim retained despite fence and refused second claim');
select pg_temp.ok((select count(*)=0 from owned_synthetic.resources),'all enrollment requests/fences leave actual target untouched');
select pg_temp.ok((select count(*)=0 from owned_synthetic.deployment_credentials),'no request/fence issues credentials');
select pg_temp.ok((select count(*)=0 from public.verify_ledger(pg_temp.pg_id(1))),'source/fence receipts preserve append-only ledger');
rollback;
