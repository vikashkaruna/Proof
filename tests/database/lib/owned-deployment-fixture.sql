-- DISPOSABLE ADMIN FIXTURE ONLY. These are explicitly fabricated retained
-- enrollment/JTI rows for legacy 166--168 SQL unit fixtures, NOT live founder
-- approval, browser MFA, host observation, HMAC or PostgREST crypto evidence.
-- No deployment function or environment guard is weakened for these tests.
do $fixture169$
begin
 if to_regclass('owned_synthetic.deployment_approvals') is not null then
 execute $definition$
 create function pg_temp.fixture_owned169_enrollment(binding_id uuid) returns jsonb
 language plpgsql as $body$
 declare b owned_synthetic.bindings;rid uuid;aid uuid;cid uuid;manifest jsonb;receipt bigint;stamp timestamptz;expiry timestamptz;proof jsonb;begin
  if current_user not in('postgres','supabase_admin') then raise exception 'Disposable administrator fixture only';end if;
  select * into strict b from owned_synthetic.bindings where id=binding_id;
  insert into auth.users(id,email) values(pg_temp.id(7),'owned169-sql-founder@example.invalid') on conflict do nothing;
  insert into public.users(id,email,is_axiom_internal) values(pg_temp.id(7),'owned169-sql-founder@example.invalid',true) on conflict do nothing;
  insert into auth.sessions(id,user_id,not_after) values(pg_temp.id(107),pg_temp.id(7),null) on conflict do nothing;
  insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted) values(pg_temp.id(47),pg_temp.id(7),'totp','active','explicit-admin-fixture-not-secret') on conflict do nothing;
  insert into public.platform_founders(user_id,designated_by,designation_reason) values(pg_temp.id(7),'disposable169-admin-fixture','Explicit SQL enrollment authority stand-in only') on conflict do nothing;
  rid:=b.id;aid:=b.approval_reference;cid:=gen_random_uuid();stamp:=to_timestamp(floor(extract(epoch from clock_timestamp())));expiry:=least(stamp+interval '10 minutes',b.expires_at);
  manifest:=jsonb_build_object('schemaVersion',1,'purpose','owned_synthetic_enrollment_v1','environment','local','tenantId',b.tenant_id,'engagementId',b.engagement_id,'connectorId',b.connector_id,'fixtureId',b.fixture_id,'resourceId',b.resource_id,'bindingId',b.id,'custodyPolicyId',b.custody_policy_id,'custodyEpoch',b.custody_activation_epoch,'source',jsonb_build_object('engineSha256',b.engine_sha256),'expiresAt',b.expires_at,'limitations',jsonb_build_array('ADMIN SQL STAND-IN ONLY; no real enrollment'));
  receipt:=public.append_ledger(b.tenant_id,rid,'system','explicit-disposable169-admin-fixture',null,null,null,'deployment.owned_requested',rid::text,null,null,null,null,null,null,'pending','{"provenance":"explicit_admin_SQL_stand_in_not_real_approval"}'::jsonb);
  insert into owned_synthetic.deployment_requests(id,tenant_id,actor_id,session_id,request,request_sha256,manifest,manifest_sha256,engagement_id,connector_id,binding_id,fixture_id,resource_id,custody_policy_id,custody_epoch,expires_at,receipt_id)
  values(rid,b.tenant_id,pg_temp.id(1),pg_temp.id(101),'{"reason":"Explicit administrative SQL fixture only"}',repeat('a',64),manifest,owned_synthetic.snapshot_sha256(manifest),b.engagement_id,b.connector_id,b.id,b.fixture_id,b.resource_id,b.custody_policy_id,b.custody_activation_epoch,b.expires_at,receipt);
  insert into public.mfa_challenges(id,user_id,tenant_id,factor_id,purpose,bound_resource_ref,bound_payload_sha256,created_at,expires_at,satisfied_at,satisfied_with,consumed_at,consumed_for)
  values(cid,pg_temp.id(7),b.tenant_id,pg_temp.id(47),'owned_synthetic_enrollment',rid::text,repeat('a',64),stamp-interval '1 second',stamp+interval '5 minutes',stamp,'totp',stamp,rid::text);
  insert into owned_synthetic.deployment_approvals(id,tenant_id,request_id,actor_id,session_id,operation_key,challenge_id,decision,decision_sha256,signed_token,role_graph,preflight_sha256,rollback_sha256,scope_expires_at,receipt_id)
  values(aid,b.tenant_id,rid,pg_temp.id(7),pg_temp.id(107),rid,cid,'{"provenance":"ADMIN SQL STAND IN ONLY"}',repeat('a',64),jsonb_build_object('spec',jsonb_build_object('expiresAt',stamp+interval '5 minutes'),'signature',repeat('f',64)),owned_synthetic.deployment_role_graph(),repeat('b',64),repeat('c',64),b.expires_at,receipt);
  insert into owned_synthetic.deployment_heads(request_id,state,preflight,approval_id) values(rid,'active',jsonb_build_object('sha256',repeat('b',64),'rollbackSha256',repeat('c',64)),aid);
  -- No issuer/signing key or real token exists: claims below only test native SQL
  -- fences. The HTTP crypto test remains a separately required acceptance gate.
  cid:=gen_random_uuid();proof:=jsonb_build_object('provenance','ADMIN SQL CLAIM STAND IN ONLY');
  insert into owned_synthetic.deployment_credential_reservations(id,tenant_id,request_id,binding_id,approval_id,custody_epoch,reservation_sha256,metadata,issued_at,expires_at,receipt_id)
  values(cid,b.tenant_id,rid,b.id,aid,b.custody_activation_epoch,repeat('d',64),proof,stamp,expiry,receipt);
  insert into owned_synthetic.deployment_credentials(id,tenant_id,request_id,binding_id,approval_id,custody_epoch,token_sha256,issued_at,expires_at,receipt_id)
  values(cid,b.tenant_id,rid,b.id,aid,b.custody_activation_epoch,repeat('e',64),stamp,expiry,receipt);
  return jsonb_build_object('role','owned_target_controller','owned_target_purpose','owned_synthetic_target_v1','tenant_id',b.tenant_id,'binding_id',b.id,'enrollment_id',rid,'jti',cid,'custody_epoch',b.custody_activation_epoch,'iat',extract(epoch from stamp)::bigint,'exp',extract(epoch from expiry)::bigint);
 end $body$;
 $definition$;
 execute 'revoke all on function pg_temp.fixture_owned169_enrollment(uuid) from public';
 end if;
end
$fixture169$;
