-- Real DB authority, finalized assessment binding, founder draft & release gate for board reports.
begin;
create function pg_temp.ok(v boolean, m text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'ASSERTION FAILED: %', m; end if; end $$;

insert into auth.users(id, email)
  select ('99750000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'board-' || n || '@example.invalid'
  from generate_series(1, 5) n;

insert into public.users(id, email, full_name, is_axiom_internal)
  values
  ('99750000-0000-4000-8000-000000000001', 'board-1@example.invalid', 'Manager User', false),
  ('99750000-0000-4000-8000-000000000002', 'board-2@example.invalid', 'Internal Founder', true),
  ('99750000-0000-4000-8000-000000000003', 'board-3@example.invalid', 'External Founder', false),
  ('99750000-0000-4000-8000-000000000004', 'board-4@example.invalid', 'Viewer User', false),
  ('99750000-0000-4000-8000-000000000005', 'board-5@example.invalid', 'Foreign Tenant User', false);

insert into public.tenants(id, slug, name)
  values
  ('99750000-0000-4000-8000-000000000010', 'board-tenant-a', 'Board Tenant A'),
  ('99750000-0000-4000-8000-000000000020', 'board-tenant-b', 'Board Tenant B');

insert into public.tenant_users(tenant_id, user_id, role)
  values
  ('99750000-0000-4000-8000-000000000010', '99750000-0000-4000-8000-000000000001', 'admin'),
  ('99750000-0000-4000-8000-000000000010', '99750000-0000-4000-8000-000000000002', 'founder'),
  ('99750000-0000-4000-8000-000000000010', '99750000-0000-4000-8000-000000000003', 'founder'),
  ('99750000-0000-4000-8000-000000000010', '99750000-0000-4000-8000-000000000004', 'viewer'),
  ('99750000-0000-4000-8000-000000000020', '99750000-0000-4000-8000-000000000005', 'admin');

insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('board-test-lib', now(), 'fixture', 'synthetic', 1);

insert into public.controls(id, library_version, title, obligation, domain, severity, citations, evidence_required, assessment_questions, scoring, remediation_patterns, introduced_in_version)
  values ('BOARD-001', 'board-test-lib', 'Synthetic control', 'Fixture only', 'GOV', 'low', '[]', '[]', '[]', '{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":1000000}', '{}', 'board-test-lib');

insert into public.estates(id, tenant_id, name, slug)
  values ('99750000-0000-4000-8000-000000000050', '99750000-0000-4000-8000-000000000010', 'Board estate', 'board-estate');

insert into public.engagements(id, tenant_id, estate_id, library_version, title)
  values
  ('99750000-0000-4000-8000-000000000030', '99750000-0000-4000-8000-000000000010', '99750000-0000-4000-8000-000000000050', 'board-test-lib', 'Board Engagement');

insert into public.workload_identities(id, tenant_id, agent_name, spiffe_id, status)
  values ('99750000-0000-4000-8000-000000000041', '99750000-0000-4000-8000-000000000010', 'parikshan', 'spiffe://axiom.test/parikshan', 'active');

-- Produce an assessment through the real worker/confirmation RPC chain.
create temporary table board_issued as
select (public.delegate_workload_task(
  '99750000-0000-4000-8000-000000000010',
  '99750000-0000-4000-8000-000000000001',
  '99750000-0000-4000-8000-000000000041', 'parikshan',
  '99750000-0000-4000-8000-000000000050',
  '99750000-0000-4000-8000-000000000030', gen_random_uuid(),
  repeat('a',64), repeat('b',64),
  array['control_library.read','findings.write'], clock_timestamp()+interval '10 minutes'
)->>'run_id')::uuid run_id;
grant select on board_issued to service_role;

select public.start_workload_assessment(
  '99750000-0000-4000-8000-000000000010', (select run_id from board_issued),
  '99750000-0000-4000-8000-000000000041', repeat('b',64), repeat('a',64),
  clock_timestamp()+interval '5 minutes');
select public.complete_workload_assessment(
  '99750000-0000-4000-8000-000000000010', (select run_id from board_issued),
  '99750000-0000-4000-8000-000000000041', repeat('b',64),
  (select library_digest from public.workload_assessment_packets where run_id=(select run_id from board_issued)),
  '{"library_version":"board-test-lib","posture_score":85,"estimated_exposure_inr":1000000,"findings":[{"control_id":"BOARD-001","score":85,"risk_points":0,"rationale":"Synthetic fixture"}]}'::jsonb,
  clock_timestamp()+interval '5 minutes');

set local role service_role;
do $$
declare
 t uuid:='99750000-0000-4000-8000-000000000010';
 manager uuid:='99750000-0000-4000-8000-000000000001';
 founder uuid:='99750000-0000-4000-8000-000000000002';
 outsider uuid:='99750000-0000-4000-8000-000000000003';
 run uuid:=(select run_id from board_issued);
 eng uuid:='99750000-0000-4000-8000-000000000030';
 req public.board_report_requests;src public.board_request_sources;r public.reports;
 b public.board_artifact_builds; q jsonb; x jsonb; receipt jsonb; source_receipt jsonb; pdf_receipt jsonb;
 content text; pdf_hash text:=repeat('d',64); build_key uuid:=gen_random_uuid();
 wrong jsonb; count_before integer;
begin
 perform pg_temp.ok(public.confirm_workload_assessment(t,run)->>'status'='succeeded','real finalized assessment');
 x:=public.request_board_report(t,manager,gen_random_uuid(),eng,run,'Versioned Board Report',gen_random_uuid());
 select * into req from public.board_report_requests where id=(x->>'requestId')::uuid;
 select * into src from public.board_request_sources where request_id=req.id;
 content:=jsonb_build_object('schema_version',1,'kind','board_report','title',req.title,
  'source_sha256',src.source_sha256,'assessment_run_id',req.assessment_run_id,
  'assessment_result_digest',req.assessment_result_digest,'library_digest',req.library_digest)::text;
 x:=public.record_board_report_draft(t,founder,req.id,content,'<html>fixture</html>',gen_random_uuid());
 select * into r from public.reports where id=(x->>'reportId')::uuid;
 perform pg_temp.ok(r.content_sha256=encode(sha256(convert_to(content,'UTF8')),'hex'),'exact draft bytes');
 perform pg_temp.ok(public.release_report(t,r.id,founder,r.content_sha256,pdf_hash,gen_random_uuid())->>'error'='not_approved','unreviewed report refuses release');
 x:=public.review_report(t,r.id,'approved',null,founder,r.content_sha256,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='approved','immutable named review');
 perform pg_temp.ok(public.release_report(t,r.id,founder,r.content_sha256,pdf_hash,gen_random_uuid())->>'error'='report_artifact_unverified','review alone refuses release');
 q:=jsonb_build_object('provider','s3-compatible','bucket','board-test','retention_policy','seven_years',
  'legal_hold',false,'source_sha256',src.source_sha256,'content_sha256',r.content_sha256,
  'review_sha256',x->>'reviewHash','renderer_version','board-pdf-v1','artifacts',jsonb_build_array(
   jsonb_build_object('kind','source_json','mime_type','application/json','content_hash',src.source_sha256,
    'byte_size',octet_length(src.source_text),'object_key','tenants/'||t||'/reports/'||r.id||'/'||build_key||'/source_json/'||src.source_sha256),
   jsonb_build_object('kind','board_pdf','mime_type','application/pdf','content_hash',pdf_hash,
    'byte_size',1234,'object_key','tenants/'||t||'/reports/'||r.id||'/'||build_key||'/board_pdf/'||pdf_hash)));
 perform pg_temp.ok(public.begin_board_artifact_build(t,outsider,r.id,build_key,q,gen_random_uuid())->>'error'='founder_authority_required','external founder cannot build');
 perform pg_temp.ok(public.begin_board_artifact_build(t,founder,r.id,build_key,q||'{"unknown":true}'::jsonb,gen_random_uuid())->>'error'='invalid_request','strict intent keys');
 perform pg_temp.ok(public.begin_board_artifact_build(t,founder,r.id,build_key,jsonb_set(q,'{artifacts,0,content_hash}',to_jsonb(repeat('0',64))),gen_random_uuid())->>'error'='manifest_changed','source hash must match snapshot');
 perform pg_temp.ok(public.begin_board_artifact_build(t,founder,r.id,build_key,jsonb_set(q,'{artifacts,1,object_key}',to_jsonb('foreign-key'::text)),gen_random_uuid())->>'error'='invalid_request','typed deterministic key required');
 x:=public.begin_board_artifact_build(t,founder,r.id,build_key,q,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='pending' and x->>'replayed'='false','durable build intent before any object');
 select * into b from public.board_artifact_builds where id=(x->>'buildId')::uuid;
 perform pg_temp.ok(b.retain_until>clock_timestamp()+interval '6 years','fixed seven-year deadline');
 perform pg_temp.ok((public.begin_board_artifact_build(t,founder,r.id,build_key,q,gen_random_uuid())->>'replayed')::boolean,'exact begin replay');
 perform pg_temp.ok(public.begin_board_artifact_build(t,founder,r.id,gen_random_uuid(),q,gen_random_uuid())->>'error'='invalid_request','changed operation key is not a valid descriptor');
 perform pg_temp.ok(public.note_board_artifact_failure(t,founder,b.id,'object_version_not_found',gen_random_uuid())->>'status'='pending','missing object remains pending');
 perform pg_temp.ok(public.release_report(t,r.id,founder,r.content_sha256,pdf_hash,gen_random_uuid())->>'error'='build_not_settled','pending build refuses publication');
 source_receipt:=jsonb_build_object('provider','s3-compatible','bucket','board-test','object_key',q#>>'{artifacts,0,object_key}',
  'version_id','source-v1','content_hash',src.source_sha256,'byte_size',octet_length(src.source_text),
  'tenant_id',t,'engagement_id',eng,'collected_by_agent','board-report-builder','retain_until',b.retain_until,
  'readback_at',clock_timestamp(),'lock_mode','COMPLIANCE','verified',true,'legal_hold',false,
  'encryption','AES256','operation_id',b.id,'correlation_id',b.correlation_id);
 wrong:=source_receipt||'{"version_id":null}'::jsonb;
 perform pg_temp.ok(public.settle_board_artifact_version(t,founder,b.id,'source_json',wrong,gen_random_uuid()) ? 'error','null version refused');
 perform pg_temp.ok(public.settle_board_artifact_version(t,founder,b.id,'source_json',source_receipt||'{"verified":false}'::jsonb,gen_random_uuid()) ? 'error','unverified receipt refused');
 perform pg_temp.ok(public.settle_board_artifact_version(t,founder,b.id,'source_json',source_receipt||'{"lock_mode":"GOVERNANCE"}'::jsonb,gen_random_uuid()) ? 'error','noncompliance lock refused');
 perform pg_temp.ok(public.settle_board_artifact_version(t,founder,b.id,'source_json',source_receipt||jsonb_build_object('operation_id',gen_random_uuid()),gen_random_uuid()) ? 'error','wrong build binding refused');
 perform pg_temp.ok(public.settle_board_artifact_version(t,founder,b.id,'source_json',source_receipt||jsonb_build_object('readback_at',clock_timestamp()-interval '1 hour'),gen_random_uuid()) ? 'error','stale readback refused');
 x:=public.settle_board_artifact_version(t,founder,b.id,'source_json',source_receipt,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='pending','first typed receipt leaves build pending');
 perform pg_temp.ok((public.settle_board_artifact_version(t,founder,b.id,'source_json',source_receipt,gen_random_uuid())->>'replayed')::boolean,'identical receipt replay');
 perform pg_temp.ok(public.settle_board_artifact_version(t,founder,b.id,'source_json',source_receipt||'{"version_id":"other-v2"}'::jsonb,gen_random_uuid())->>'error'='receipt_conflict','changed version cannot replace receipt');
 perform pg_temp.ok(public.release_report(t,r.id,founder,r.content_sha256,pdf_hash,gen_random_uuid())->>'error'='build_not_settled','source-only state refuses release');
 pdf_receipt:=source_receipt||jsonb_build_object('object_key',q#>>'{artifacts,1,object_key}',
  'version_id','pdf-v1','content_hash',pdf_hash,'byte_size',1234,'readback_at',clock_timestamp());
 x:=public.settle_board_artifact_version(t,founder,b.id,'board_pdf',pdf_receipt,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='settled','both typed receipts settle build');
 perform pg_temp.ok((select count(*)=2 from public.board_artifact_versions where build_id=b.id),'exactly two immutable versions');
 perform pg_temp.ok(public.release_report(t,r.id,founder,r.content_sha256,repeat('e',64),gen_random_uuid())->>'error'='archive_hash_mismatch','wrong expected PDF digest refused');
 x:=public.release_report(t,r.id,founder,r.content_sha256,pdf_hash,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='published' and x->>'archiveHash'=pdf_hash,'founder releases exact reviewed PDF digest');
 perform pg_temp.ok((public.release_report(t,r.id,founder,r.content_sha256,pdf_hash,gen_random_uuid())->>'replayed')::boolean,'release idempotent');
 perform pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=t and action_type='report.released' and target_ref=r.id::text),'one release ledger entry');
 perform pg_temp.ok((select count(*)=2 from public.audit_ledger where tenant_id=t and action_type='report.artifact.settled' and target_ref=r.id::text),'one settlement ledger per typed receipt');
 perform pg_temp.ok(not has_table_privilege('service_role','public.board_artifact_versions','INSERT')
  and not has_table_privilege('service_role','public.board_artifact_builds','INSERT')
  and not has_table_privilege('authenticated','public.board_artifact_versions','SELECT'),'private SQL-only write boundary');
end $$;
reset role;
rollback;
