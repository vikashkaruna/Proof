-- Provider calls belong to the BFF. These assertions verify durable binding,
-- failure/replay semantics and the database privilege boundary, not S3 itself.
begin;
create function pg_temp.assert_true(v boolean,m text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'ASSERTION FAILED: %',m; end if; end $$;
create function pg_temp.denied(s text) returns void language plpgsql as $$
begin begin execute s; exception when insufficient_privilege then return; end; raise exception 'not denied: %',s; end $$;
insert into auth.users(id,email) values
 ('99730000-0000-4000-8000-000000000001','evidence-owner@example.invalid'),
 ('99730000-0000-4000-8000-000000000002','evidence-viewer@example.invalid'),
 ('99730000-0000-4000-8000-000000000003','evidence-internal@example.invalid');
insert into public.users(id,email,is_axiom_internal) values
 ('99730000-0000-4000-8000-000000000001','evidence-owner@example.invalid',false),
 ('99730000-0000-4000-8000-000000000002','evidence-viewer@example.invalid',false),
 ('99730000-0000-4000-8000-000000000003','evidence-internal@example.invalid',true);
insert into public.tenants(id,slug,name) values
 ('99730000-0000-4000-8000-000000000010','evidence-a','Evidence A'),
 ('99730000-0000-4000-8000-000000000020','evidence-b','Evidence B');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('99730000-0000-4000-8000-000000000010','99730000-0000-4000-8000-000000000001','owner'),
 ('99730000-0000-4000-8000-000000000010','99730000-0000-4000-8000-000000000002','viewer');
create function pg_temp.evidence_request(k uuid,h text) returns jsonb language sql as $$
 select jsonb_build_object('content_hash',h,'byte_size',3,'mime_type','text/plain','filename','fixture.txt',
  'evidence_type','document','description','Synthetic database fixture','control_ids','[]'::jsonb,'engagement_id',null,
  'collected_by_agent','human','provider','s3-compatible','bucket','axiom-test-vault',
  'object_key','tenants/99730000-0000-4000-8000-000000000010/evidence-ingestions/'||k::text||'/'||h,
  'retention_policy','seven_years','legal_hold',false);
$$;
create function pg_temp.receipt(r public.evidence_ingestions) returns jsonb language sql as $$
 select (r.request-array['mime_type','filename','evidence_type','description','control_ids','retention_policy'])
  ||jsonb_build_object('tenant_id',r.tenant_id,'operation_id',r.id,'correlation_id',r.correlation_id,
    'version_id','fixture-version-'||r.id::text,'retain_until',r.retain_until,'readback_at',clock_timestamp(),
    'lock_mode','COMPLIANCE','verified',true,'encryption','AES256');
$$;
set local role service_role;
do $$
declare t uuid:='99730000-0000-4000-8000-000000000010'; a uuid:='99730000-0000-4000-8000-000000000001';
 k uuid:=gen_random_uuid(); k2 uuid:=gen_random_uuid(); q jsonb; x jsonb; r public.evidence_ingestions; receipt jsonb; e uuid;
begin
 q:=pg_temp.evidence_request(k,repeat('a',64));
 perform pg_temp.assert_true(public.begin_evidence_ingest(t,'99730000-0000-4000-8000-000000000002',k,q,gen_random_uuid())->>'error'='forbidden','viewer denied');
 perform pg_temp.assert_true(public.begin_evidence_ingest(t,'99730000-0000-4000-8000-000000000003',k,q,gen_random_uuid())->>'error'='forbidden','employee nonmember denied');
 perform pg_temp.assert_true(public.begin_evidence_ingest(t,a,k,q||'{"byte_size":null}',gen_random_uuid())->>'error'='invalid_request','null size denied');
 perform pg_temp.assert_true(public.begin_evidence_ingest(t,a,k,q||'{"provider":null}',gen_random_uuid())->>'error'='invalid_request','null provider denied');
 perform pg_temp.assert_true(public.begin_evidence_ingest(t,a,k,q||'{"byte_size":8388609}',gen_random_uuid())->>'error'='invalid_request','size bound');
 perform pg_temp.assert_true(public.begin_evidence_ingest(t,a,k,q||'{"object_key":"foreign/key"}',gen_random_uuid())->>'error'='invalid_request','key bound to tenant and operation');
 perform pg_temp.assert_true(public.begin_evidence_ingest(t,a,k,q||'{"engagement_id":"99730000-0000-4000-8000-000000000099"}',gen_random_uuid())->>'error'='engagement_not_found','unknown/foreign engagement refused');
 perform pg_temp.assert_true(public.begin_evidence_ingest(t,a,k,q||'{"control_ids":["invented"]}',gen_random_uuid())->>'error'='control_not_found','no invented controls');
 x:=public.begin_evidence_ingest(t,a,k,q,gen_random_uuid());
 select * into r from public.evidence_ingestions where id=(x->>'operation_id')::uuid;
 perform pg_temp.assert_true(r.status='pending' and r.evidence_id is null and r.retain_until>=r.created_at+interval '7 years','durable intent before upload');
 x:=public.begin_evidence_ingest(t,a,k,q,gen_random_uuid());
 perform pg_temp.assert_true((x->>'replayed')::boolean and (x->>'retain_until')::timestamptz=r.retain_until,'retry preserves retention deadline');
 perform pg_temp.assert_true(public.begin_evidence_ingest(t,a,k,q||'{"description":"changed"}',gen_random_uuid())->>'error'='idempotency_conflict','changed payload refused');
 perform pg_temp.assert_true(public.begin_evidence_ingest(t,a,k2,pg_temp.evidence_request(k2,repeat('a',64)),gen_random_uuid())->>'error'='content_ingestion_pending','second operation cannot duplicate uncertain upload');
 perform pg_temp.assert_true(public.note_evidence_ingest_failure(t,a,r.id,'provider_unavailable',gen_random_uuid())->>'status'='pending','provider failure remains pending');
 perform public.note_evidence_ingest_failure(t,a,r.id,'provider_unavailable',gen_random_uuid());
 perform pg_temp.assert_true((select count(*)=1 from public.audit_ledger where tenant_id=t and action_type='evidence.ingestion.pending'),'same failure replay appends once');
 receipt:=pg_temp.receipt(r);
 perform pg_temp.assert_true(public.settle_evidence_ingest(t,a,r.id,receipt||'{"version_id":123}',gen_random_uuid())->>'error'='invalid_receipt','numeric version cannot acquire string authority');
 perform pg_temp.assert_true(public.settle_evidence_ingest(t,a,r.id,receipt||'{"version_id":true}',gen_random_uuid())->>'error'='invalid_receipt','boolean version refused');
 perform pg_temp.assert_true(public.settle_evidence_ingest(t,a,r.id,receipt||'{"version_id":null}',gen_random_uuid())->>'error'='invalid_receipt','JSON null version refused');
 perform pg_temp.assert_true(public.settle_evidence_ingest(t,a,r.id,receipt||'{"version_id":"   "}',gen_random_uuid())->>'error'='receipt_mismatch','blank version refused');
 perform pg_temp.assert_true(public.settle_evidence_ingest(t,a,r.id,receipt||'{"readback_at":"now"}',gen_random_uuid())->>'error'='invalid_receipt','relative timestamp refused');
 perform pg_temp.assert_true(public.settle_evidence_ingest(t,a,r.id,receipt||'{"readback_at":null}',gen_random_uuid())->>'error'='invalid_receipt','null timestamp refused');
 perform pg_temp.assert_true(public.settle_evidence_ingest(t,a,r.id,receipt||'{"readback_at":"2026-09-27T03:00:00"}',gen_random_uuid())->>'error'='invalid_receipt','unqualified timezone refused');
 perform pg_temp.assert_true(public.settle_evidence_ingest(t,a,r.id,receipt||'{"verified":false}',gen_random_uuid())->>'error'='receipt_mismatch','unverified refused');
 perform pg_temp.assert_true(public.settle_evidence_ingest(t,a,r.id,receipt||'{"lock_mode":"GOVERNANCE"}',gen_random_uuid())->>'error'='receipt_mismatch','governance refused');
 perform pg_temp.assert_true(public.settle_evidence_ingest(t,a,r.id,receipt||'{"version_id":"null"}',gen_random_uuid())->>'error'='receipt_mismatch','null version refused');
 perform pg_temp.assert_true(public.settle_evidence_ingest(t,a,r.id,receipt||jsonb_build_object('retain_until',r.retain_until-interval '1 second'),gen_random_uuid())->>'error'='receipt_mismatch','short retention refused');
 perform pg_temp.assert_true(public.settle_evidence_ingest(t,a,r.id,receipt||jsonb_build_object('readback_at',now()-interval '1 hour'),gen_random_uuid())->>'error'='receipt_mismatch','stale readback refused');
 perform pg_temp.assert_true(public.settle_evidence_ingest(t,a,r.id,receipt||'{"tenant_id":"99730000-0000-4000-8000-000000000020"}',gen_random_uuid())->>'error'='receipt_mismatch','foreign metadata refused');
 perform pg_temp.assert_true(public.settle_evidence_ingest(t,a,r.id,receipt||jsonb_build_object('operation_id',gen_random_uuid()),gen_random_uuid())->>'error'='receipt_mismatch','foreign operation metadata refused');
 x:=public.settle_evidence_ingest(t,a,r.id,receipt,gen_random_uuid()); e:=(x->>'evidence_id')::uuid;
 perform pg_temp.assert_true(e is not null and x->>'status'='settled','matching readback settles atomically');
 perform pg_temp.assert_true((public.settle_evidence_ingest(t,a,r.id,receipt,gen_random_uuid())->>'replayed')::boolean,'identical settlement idempotent');
 perform pg_temp.assert_true(public.settle_evidence_ingest(t,a,r.id,receipt||'{"version_id":"new-version"}',gen_random_uuid())->>'error'='receipt_conflict','settled version immutable');
 perform pg_temp.assert_true((select count(*)=1 from public.evidence_object_versions where tenant_id=t),'one receipt');
 perform pg_temp.assert_true((select count(*)=1 from public.audit_ledger where tenant_id=t and action_type='evidence.ingestion.settled'),'one settlement audit');
 perform pg_temp.denied(format('update public.evidence set description=''tampered'' where id=%L',e));
 perform pg_temp.denied(format('delete from public.evidence where id=%L',e));
 perform pg_temp.denied(format('update public.evidence_object_versions set version_id=''fake'' where evidence_id=%L',e));
 perform pg_temp.denied(format('delete from public.evidence_ingestions where id=%L',r.id));
 perform pg_temp.assert_true(public.begin_evidence_ingest(t,a,k2,pg_temp.evidence_request(k2,repeat('a',64)),gen_random_uuid())->>'error'='content_already_registered','settled content not overwritten');
 -- A legacy writer can race upload completion. The existing row is never
 -- promoted or changed: uncertainty remains pending for explicit resolution.
 x:=public.begin_evidence_ingest(t,a,k2,pg_temp.evidence_request(k2,repeat('c',64))-array['filename','description','engagement_id'],gen_random_uuid());
 select * into r from public.evidence_ingestions where id=(x->>'operation_id')::uuid;
 perform pg_temp.assert_true(r.request ?& array['filename','description','engagement_id'],'optional metadata normalized without fabrication');
 receipt:=pg_temp.receipt(r);
 insert into public.evidence(tenant_id,content_hash,storage_uri,evidence_type,collected_by_agent)
 values(t,repeat('c',64),'fixture://legacy-race','document','legacy');
 perform pg_temp.assert_true(public.settle_evidence_ingest(t,a,r.id,receipt,gen_random_uuid())->>'error'='content_already_registered','legacy race does not acquire new receipt');
 perform pg_temp.assert_true((select status='pending' and evidence_id is null from public.evidence_ingestions where id=r.id),'conflict remains durable pending');
 perform pg_temp.assert_true((select count(*)=1 from public.evidence_object_versions where tenant_id=t),'legacy race created no receipt');
end $$;
reset role;
-- Retained parent references and settled state remain protected even for an
-- owner issuing ordinary SQL (superuser trigger disabling is outside the BFF).
do $$ begin
 begin delete from public.tenants where id='99730000-0000-4000-8000-000000000010';
 exception when foreign_key_violation or insufficient_privilege then return; end;
 raise exception 'retained tenant deleted';
end $$;
select pg_temp.denied('update public.evidence_object_versions set version_id=''changed''');
select pg_temp.denied('update public.evidence_ingestions set last_error_code=''changed'' where status=''settled''');
-- Membership revocation invalidates both settlement and reconciliation authority.
update public.tenant_users set role='viewer' where user_id='99730000-0000-4000-8000-000000000001';
set local role service_role;
select pg_temp.assert_true(public.settle_evidence_ingest('99730000-0000-4000-8000-000000000010','99730000-0000-4000-8000-000000000001',gen_random_uuid(),'{}',gen_random_uuid())->>'error'='forbidden','demoted actor refused');
select pg_temp.assert_true(public.note_evidence_ingest_failure('99730000-0000-4000-8000-000000000010','99730000-0000-4000-8000-000000000001',gen_random_uuid(),'provider_unavailable',gen_random_uuid())->>'error'='forbidden','demoted reconciler refused');
reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"99730000-0000-4000-8000-000000000003"}',true);
select pg_temp.assert_true((select count(*)=0 from public.evidence_object_versions),'internal nonmember cannot read receipts');
select pg_temp.denied('select public.begin_evidence_ingest(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),''{}'',gen_random_uuid())');
select set_config('request.jwt.claims','{"sub":"99730000-0000-4000-8000-000000000002"}',true);
select pg_temp.assert_true((select count(*)=1 from public.evidence_object_versions),'member can read real receipt');
rollback;
