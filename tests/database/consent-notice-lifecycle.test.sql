-- 0072: the bytes and version reviewed by a principal survive publication.
begin;
create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end $$;
create function pg_temp.denied(statement text) returns void language plpgsql as $$
begin
  begin execute statement; exception when insufficient_privilege then return; end;
  raise exception 'not denied: %',statement;
end $$;
insert into auth.users(id,email) values
 ('99720000-0000-4000-8000-000000000001','notice-owner@example.invalid'),
 ('99720000-0000-4000-8000-000000000002','notice-viewer@example.invalid'),
 ('99720000-0000-4000-8000-000000000003','notice-internal@example.invalid');
insert into public.users(id,email,is_axiom_internal) values
 ('99720000-0000-4000-8000-000000000001','notice-owner@example.invalid',false),
 ('99720000-0000-4000-8000-000000000002','notice-viewer@example.invalid',false),
 ('99720000-0000-4000-8000-000000000003','notice-internal@example.invalid',true);
insert into public.tenants(id,slug,name) values
 ('99720000-0000-4000-8000-000000000010','notice-a','Notice A'),
 ('99720000-0000-4000-8000-000000000020','notice-b','Notice B');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('99720000-0000-4000-8000-000000000010','99720000-0000-4000-8000-000000000001','owner'),
 ('99720000-0000-4000-8000-000000000010','99720000-0000-4000-8000-000000000002','viewer');
create function pg_temp.register(p_key text,p_basis text,p_reviewed boolean,p_actor uuid)
returns jsonb language sql as $$
 select public.register_consent_purpose('99720000-0000-4000-8000-000000000010',p_key,
  'Visit analytics','विज़िट विश्लेषण',null,null,p_basis,'Original English notice','मूल हिंदी सूचना',
  p_reviewed,p_actor,gen_random_uuid());
$$;
create function pg_temp.capture(p_purpose uuid,p_version integer,p_language text,p_principal text)
returns jsonb language sql as $$
 select public.record_consent('99720000-0000-4000-8000-000000000010',p_purpose,p_version,
  'cookie_id',p_principal,p_language,'cookie',null,'99720000-0000-4000-8000-000000000001',gen_random_uuid());
$$;
-- Trusted BFF credentials still require a live manager membership and review.
set local role service_role;
select pg_temp.assert_true(pg_temp.register('refused','consent',false,'99720000-0000-4000-8000-000000000001')->>'error'='invalid_request','human review required');
select pg_temp.assert_true(pg_temp.register('refused','consent',true,'99720000-0000-4000-8000-000000000002')->>'error'='forbidden','viewer cannot publish');
select pg_temp.assert_true(pg_temp.register('refused','consent',true,'99720000-0000-4000-8000-000000000003')->>'error'='forbidden','employee flag is not authority');
do $$
declare p uuid; c uuid; w uuid; x jsonb; h text;
begin
 x:=pg_temp.register('analytics','consent',true,'99720000-0000-4000-8000-000000000001');
 p:=(x->>'purpose_id')::uuid;
 perform pg_temp.assert_true(p is not null and x->>'notice_version'='1','bilingual purpose registered');
 perform pg_temp.assert_true(pg_temp.register('analytics','consent',true,'99720000-0000-4000-8000-000000000001')->>'error'='purpose_exists','duplicate key refused');
 x:=pg_temp.capture(p,1,'hi','cookie-001'); c:=(x->>'consent_id')::uuid; h:=x->>'notice_snapshot_sha256';
 perform pg_temp.assert_true(c is not null and h ~ '^[0-9a-f]{64}$','Hindi cookie capture binds real hash');
 x:=public.publish_consent_notice('99720000-0000-4000-8000-000000000010',p,1,
  'Second English notice','दूसरी हिंदी सूचना',true,'99720000-0000-4000-8000-000000000001',gen_random_uuid());
 perform pg_temp.assert_true(x->>'notice_version'='2','new version published');
 perform pg_temp.assert_true((select notice_version=1 and notice_snapshot_sha256=h from public.consent_records where id=c),'existing capture stays on original version');
 perform pg_temp.assert_true((select notice_en='Original English notice' and notice_hi='मूल हिंदी सूचना' from public.consent_notice_versions where purpose_id=p and notice_version=1),'original bytes retained');
 perform pg_temp.assert_true(pg_temp.capture(p,1,'en','stale-cookie')->>'error'='stale_notice_version','stale principal review cannot capture latest');
 x:=public.publish_consent_notice('99720000-0000-4000-8000-000000000010',p,1,
  'Wrong','गलत',true,'99720000-0000-4000-8000-000000000001',gen_random_uuid());
 perform pg_temp.assert_true(x->>'error'='stale_notice_version','stale manager publication refused');
 x:=public.set_consent_purpose_active('99720000-0000-4000-8000-000000000010',p,false,'99720000-0000-4000-8000-000000000001',gen_random_uuid());
 perform pg_temp.assert_true(x->>'is_active'='false','deactivation recorded');
 perform pg_temp.assert_true(pg_temp.capture(p,2,'en','inactive-cookie')->>'error'='purpose_inactive','inactive refuses captures');
 x:=public.withdraw_consent('99720000-0000-4000-8000-000000000010',c,'Preference changed','hi','99720000-0000-4000-8000-000000000001',gen_random_uuid());
 w:=(x->>'withdrawal_id')::uuid;
 perform pg_temp.assert_true(w is not null,'deactivation does not prevent withdrawal');
 perform pg_temp.assert_true((select downstream_completed_at is null from public.consent_withdrawals where id=w),'withdrawal is not invented downstream completion');
 x:=public.set_consent_purpose_active('99720000-0000-4000-8000-000000000010',p,true,'99720000-0000-4000-8000-000000000001',gen_random_uuid());
 x:=pg_temp.capture(p,2,'en','cookie-001');
 perform pg_temp.assert_true((x->>'consent_id')::uuid=c and x->>'notice_snapshot_sha256'<>h,'regrant binds new bytes and same record');
 perform pg_temp.assert_true((select count(*)=2 from public.audit_ledger where action_type='consent.recorded' and target_ref=c::text),'both grants retained in ledger');
 x:=pg_temp.register('security','legitimate_uses',true,'99720000-0000-4000-8000-000000000001');
 perform pg_temp.assert_true(pg_temp.capture((x->>'purpose_id')::uuid,1,'en','legitimate-cookie')->>'error'='consent_not_applicable','legitimate uses is not revocable consent');
end $$;
reset role;
-- A legacy EN-only purpose is accurately snapshotted, never translated.
insert into public.consent_purposes(id,tenant_id,purpose_key,name_en,lawful_basis,notice_en,created_by)
values('99720000-0000-4000-8000-000000000030','99720000-0000-4000-8000-000000000010','legacy','Legacy','consent','Legacy EN','99720000-0000-4000-8000-000000000001');
insert into public.consent_notice_versions(tenant_id,purpose_id,notice_version,notice_en,notice_hi,snapshot_sha256,provenance,created_by)
select tenant_id,id,notice_version,notice_en,notice_hi,public.consent_notice_hash(id,notice_version,notice_en,notice_hi),'legacy_current',created_by
from public.consent_purposes where id='99720000-0000-4000-8000-000000000030';
select pg_temp.assert_true(pg_temp.capture('99720000-0000-4000-8000-000000000030',1,'hi','legacy-cookie')->>'error'='missing_notice','missing Hindi refused server-side');
select pg_temp.assert_true(pg_temp.capture('99720000-0000-4000-8000-000000000030',1,'en','legacy-cookie')->>'status'='granted','existing English notice usable');
select pg_temp.denied('update public.consent_notice_versions set notice_en=''rewritten''');
select pg_temp.denied('delete from public.consent_notice_versions');
select pg_temp.assert_true(to_regprocedure('public.record_consent(uuid,uuid,text,text,text,text,timestamp with time zone,uuid,uuid)') is null,'unchecked old overload removed');
set local role authenticated;
set local request.jwt.claims='{"sub":"99720000-0000-4000-8000-000000000002","role":"authenticated"}';
select pg_temp.assert_true((select count(*)>0 from public.consent_notice_versions),'tenant viewer can read history');
select pg_temp.denied('update public.consent_notice_versions set notice_en=''forged''');
select pg_temp.denied('delete from public.consent_records');
select pg_temp.denied($q$select public.set_consent_purpose_active('99720000-0000-4000-8000-000000000010','99720000-0000-4000-8000-000000000030',false,'99720000-0000-4000-8000-000000000001',gen_random_uuid())$q$);
set local request.jwt.claims='{"sub":"99720000-0000-4000-8000-000000000003","role":"authenticated"}';
select pg_temp.assert_true((select count(*)=0 from public.consent_notice_versions),'nonmember employee cannot read notices');
select pg_temp.assert_true((select count(*)=0 from public.consent_records),'nonmember employee cannot read principals');
reset role;
-- Every lifecycle RPC refuses viewers, foreign actors and revoked managers.
do $$
declare a uuid; c uuid; w uuid;
begin
 select id into c from public.consent_records where principal_ref='legacy-cookie';
 select id into w from public.consent_withdrawals limit 1;
 foreach a in array array['99720000-0000-4000-8000-000000000002'::uuid,'99720000-0000-4000-8000-000000000003'::uuid] loop
  perform pg_temp.assert_true(public.withdraw_consent('99720000-0000-4000-8000-000000000010',c,null,'en',a,gen_random_uuid())->>'error'='forbidden','unprivileged actor cannot withdraw');
  perform pg_temp.assert_true(public.set_consent_legal_hold('99720000-0000-4000-8000-000000000010',c,false,a,gen_random_uuid())->>'error'='forbidden','unprivileged actor cannot release hold');
  perform pg_temp.assert_true(public.complete_withdrawal_downstream('99720000-0000-4000-8000-000000000010',w,a,gen_random_uuid())->>'error'='forbidden','unprivileged actor cannot attest completion');
 end loop;
 update public.tenant_users set role='viewer' where user_id='99720000-0000-4000-8000-000000000001';
 perform pg_temp.assert_true(public.set_consent_legal_hold('99720000-0000-4000-8000-000000000010',c,true,'99720000-0000-4000-8000-000000000001',gen_random_uuid())->>'error'='forbidden','demoted owner loses authority');
 update public.tenant_users set role='owner' where user_id='99720000-0000-4000-8000-000000000001';
end $$;
-- Legacy status values are not proof of identity verification.
insert into public.dsars(id,tenant_id,kind,status,data_principal_email,data_principal_name,received_at,due_by,identity_verified)
values('99720000-0000-4000-8000-000000000040','99720000-0000-4000-8000-000000000010','erasure','identity_verification','request@example.invalid','Request',now(),now()+interval '30 days',false);
select pg_temp.assert_true(public.advance_dsar('99720000-0000-4000-8000-000000000010','99720000-0000-4000-8000-000000000040','in_fulfilment',null,null,'99720000-0000-4000-8000-000000000001',gen_random_uuid())->>'error'='identity_verification_required','status alone cannot authorize fulfilment');
select pg_temp.assert_true(public.verify_dsar_identity('99720000-0000-4000-8000-000000000010','99720000-0000-4000-8000-000000000040','Verified existing account','99720000-0000-4000-8000-000000000001',gen_random_uuid())->>'identityVerified'='true','human verification recorded');
select pg_temp.assert_true(public.advance_dsar('99720000-0000-4000-8000-000000000010','99720000-0000-4000-8000-000000000040','in_fulfilment',null,null,'99720000-0000-4000-8000-000000000001',gen_random_uuid())->>'status'='in_fulfilment','verified request can advance');
rollback;
