-- Real DB authority, finalized assessment binding, founder draft & release gate for board reports.
begin;
create function pg_temp.ok(v boolean, m text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'ASSERTION FAILED: %', m; end if; end $$;

insert into auth.users(id, email)
  select ('99880000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'statutory-' || n || '@example.invalid'
  from generate_series(1, 5) n;

insert into public.users(id, email, full_name, is_axiom_internal)
  values
  ('99880000-0000-4000-8000-000000000001', 'statutory-1@example.invalid', 'Manager User', false),
  ('99880000-0000-4000-8000-000000000002', 'statutory-2@example.invalid', 'Internal Founder', true),
  ('99880000-0000-4000-8000-000000000003', 'statutory-3@example.invalid', 'External Founder', false),
  ('99880000-0000-4000-8000-000000000004', 'statutory-4@example.invalid', 'Viewer User', false),
  ('99880000-0000-4000-8000-000000000005', 'statutory-5@example.invalid', 'Foreign Tenant User', false);

insert into public.tenants(id, slug, name)
  values
  ('99880000-0000-4000-8000-000000000010', 'statutory-tenant-a', 'Statutory Tenant A'),
  ('99880000-0000-4000-8000-000000000020', 'statutory-tenant-b', 'Statutory Tenant B');

insert into public.tenant_users(tenant_id, user_id, role)
  values
  ('99880000-0000-4000-8000-000000000010', '99880000-0000-4000-8000-000000000001', 'admin'),
  ('99880000-0000-4000-8000-000000000010', '99880000-0000-4000-8000-000000000002', 'founder'),
  ('99880000-0000-4000-8000-000000000010', '99880000-0000-4000-8000-000000000003', 'founder'),
  ('99880000-0000-4000-8000-000000000010', '99880000-0000-4000-8000-000000000004', 'viewer'),
  ('99880000-0000-4000-8000-000000000020', '99880000-0000-4000-8000-000000000005', 'admin');

insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('statutory-test-lib', now(), 'fixture', 'synthetic', 1);

insert into public.controls(id, library_version, title, obligation, domain, severity, citations, evidence_required, assessment_questions, scoring, remediation_patterns, introduced_in_version)
  values ('AUDITOR-001', 'statutory-test-lib', 'Synthetic control', 'Fixture only', 'GOV', 'low', '[]', '[]', '[]', '{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":1000000}', '{}', 'statutory-test-lib');

insert into public.estates(id, tenant_id, name, slug)
  values ('99880000-0000-4000-8000-000000000050', '99880000-0000-4000-8000-000000000010', 'Statutory estate', 'statutory-estate');

insert into public.engagements(id, tenant_id, estate_id, library_version, title)
  values
  ('99880000-0000-4000-8000-000000000030', '99880000-0000-4000-8000-000000000010', '99880000-0000-4000-8000-000000000050', 'statutory-test-lib', 'Statutory Engagement');

insert into public.workload_identities(id, tenant_id, agent_name, spiffe_id, status)
  values ('99880000-0000-4000-8000-000000000041', '99880000-0000-4000-8000-000000000010', 'parikshan', 'spiffe://axiom.test/parikshan', 'active');

-- Produce an assessment through the real worker/confirmation RPC chain.
create temporary table statutory_issued as
select (public.delegate_workload_task(
  '99880000-0000-4000-8000-000000000010',
  '99880000-0000-4000-8000-000000000001',
  '99880000-0000-4000-8000-000000000041', 'parikshan',
  '99880000-0000-4000-8000-000000000050',
  '99880000-0000-4000-8000-000000000030', gen_random_uuid(),
  repeat('a',64), repeat('b',64),
  array['control_library.read','findings.write'], clock_timestamp()+interval '10 minutes'
)->>'run_id')::uuid run_id;
grant select on statutory_issued to service_role;

select public.start_workload_assessment(
  '99880000-0000-4000-8000-000000000010', (select run_id from statutory_issued),
  '99880000-0000-4000-8000-000000000041', repeat('b',64), repeat('a',64),
  clock_timestamp()+interval '5 minutes');
select public.complete_workload_assessment(
  '99880000-0000-4000-8000-000000000010', (select run_id from statutory_issued),
  '99880000-0000-4000-8000-000000000041', repeat('b',64),
  (select library_digest from public.workload_assessment_packets where run_id=(select run_id from statutory_issued)),
  '{"library_version":"statutory-test-lib","posture_score":85,"estimated_exposure_inr":1000000,"findings":[{"control_id":"AUDITOR-001","score":85,"risk_points":0,"rationale":"Synthetic fixture"}]}'::jsonb,
  clock_timestamp()+interval '5 minutes');

reset role; -- privileged lifecycle fixture; restricted writer and shared-key denial are tested separately
do $$
declare
 t uuid:='99880000-0000-4000-8000-000000000010';
 manager uuid:='99880000-0000-4000-8000-000000000001';
 founder uuid:='99880000-0000-4000-8000-000000000002';
 outsider uuid:='99880000-0000-4000-8000-000000000003';
 run uuid:=(select run_id from statutory_issued);
 eng uuid:='99880000-0000-4000-8000-000000000030';
 req public.statutory_report_requests;src public.statutory_request_sources;r public.reports;
 b public.statutory_artifact_builds; q jsonb; x jsonb; receipt jsonb; source_receipt jsonb; pdf_receipt jsonb;
 content text; pdf_hash text:=repeat('d',64); build_key uuid:=gen_random_uuid();
 wrong jsonb; count_before integer;
 dossier_request jsonb; dossier_receipt jsonb; dossier_id uuid; dossier_build uuid; dossier_proof text;
begin
 perform pg_temp.ok(public.request_statutory_report(t,manager,gen_random_uuid(),eng,run,'auditor','Premature auditor report',gen_random_uuid())->>'error'='assessment_not_finalized','unfinalized packet cannot enter auditor workflow');
 perform pg_temp.ok(public.confirm_workload_assessment(t,run)->>'status'='succeeded','real finalized assessment');
 perform pg_temp.ok(public.request_statutory_report(t,outsider,gen_random_uuid(),eng,run,'auditor','External founder request',gen_random_uuid())->>'error'='forbidden','non-internal founder cannot create an inaccessible request');
 perform pg_temp.ok(public.request_statutory_report(t,manager,gen_random_uuid(),eng,run,'dpb','False DPB',gen_random_uuid())->>'error'='invalid_request','DPB cannot derive from assessment');
 perform pg_temp.ok(public.request_statutory_report(t,manager,gen_random_uuid(),eng,run,'technical','False Technical',gen_random_uuid())->>'error'='invalid_request','technical register cannot derive from assessment');
 x:=public.request_statutory_report(t,manager,gen_random_uuid(),eng,run,'auditor','Assessment Auditor Report',gen_random_uuid());
 select * into req from public.statutory_report_requests where id=(x->>'requestId')::uuid;
 select * into src from public.statutory_request_sources where request_id=req.id;
 perform pg_temp.ok(src.source_sha256=encode(sha256(convert_to(src.source_text,'UTF8')),'hex'),'frozen source digest');
 perform pg_temp.ok((src.source_text::jsonb)->>'report_kind'='auditor','snapshot names auditor source');
 content:=jsonb_build_object('schema_version',2,'kind','auditor_pack','source_kind','finalized_assessment',
  'request_id',req.id,'tenant_id',t,'engagement_id',eng,'title',req.title,
  'source_sha256',src.source_sha256,'assessment_run_id',req.assessment_run_id,
  'assessment_result_digest',req.assessment_result_digest,'library_digest',req.library_digest,
  'library_version',req.library_version,'generated_by','statutory-report-builder','generated_at',clock_timestamp(),
  'posture_score',((src.source_text::jsonb)->>'result_text')::jsonb->'posture_score',
  'finalized_at',(src.source_text::jsonb)->>'finalized_at',
  'finalized_ledger_receipt',src.source_text::jsonb#>>'{receipts,finalized,id}',
  'findings',((src.source_text::jsonb)->>'result_text')::jsonb->'findings',
  'controls',jsonb_build_array(jsonb_build_object('id','AUDITOR-001','title','Synthetic control',
    'domain','GOV','severity','low')),
  'limitations','Assessment-derived findings only. No independent audit, evidence verification, or auditor attestation is represented.')::text;
 perform pg_temp.ok(public.record_source_bound_statutory_draft(t,outsider,req.id,content,'<html>fixture</html>',gen_random_uuid())->>'error'='founder_authority_required','non-internal founder cannot draft');
 perform pg_temp.ok(public.record_source_bound_statutory_draft(t,founder,req.id,jsonb_set(content::jsonb,'{source_sha256}',to_jsonb(repeat('0',64)))::text,'<html>fixture</html>',gen_random_uuid())->>'error'='assessment_source_conflict','substituted source refused');
 perform pg_temp.ok(public.record_source_bound_statutory_draft(t,founder,req.id,jsonb_set(content::jsonb,'{findings,0,score}','100'::jsonb)::text,'<html>fixture</html>',gen_random_uuid())->>'error'='assessment_source_conflict','invented finding score refused');
 perform pg_temp.ok(public.record_source_bound_statutory_draft(t,founder,req.id,(content::jsonb||'{"invented_claim":"certified"}'::jsonb)::text,'<html>fixture</html>',gen_random_uuid())->>'error'='assessment_source_conflict','extra unsourced claim refused');
 perform pg_temp.ok(public.record_source_bound_statutory_draft(t,founder,req.id,jsonb_set(content::jsonb,'{controls,0,title}',to_jsonb('Invented title'::text))::text,'<html>fixture</html>',gen_random_uuid())->>'error'='assessment_source_conflict','invented control title refused');
 x:=public.record_source_bound_statutory_draft(t,founder,req.id,content,'<html>fixture</html>',gen_random_uuid());
 select * into r from public.reports where id=(x->>'reportId')::uuid;
 perform pg_temp.ok(r.generated_by_agent='statutory-report-builder' and r.kind='auditor','producer and kind are honest');
 perform pg_temp.ok(public.record_source_bound_statutory_draft(t,founder,req.id,content||' ', '<html>fixture</html>',gen_random_uuid())->>'error'='idempotency_conflict','draft bytes cannot change under same request');
 perform pg_temp.ok(r.content_sha256=encode(sha256(convert_to(content,'UTF8')),'hex'),'exact draft bytes');
 perform pg_temp.ok(public.release_report(t,r.id,founder,r.content_sha256,pdf_hash,gen_random_uuid())->>'error'='not_approved','unreviewed report refuses release');
 x:=public.review_report(t,r.id,'approved',null,founder,r.content_sha256,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='approved','immutable named review');
 perform pg_temp.ok(public.release_report(t,r.id,founder,r.content_sha256,pdf_hash,gen_random_uuid())->>'error'='report_artifact_unverified','review alone refuses release');
 q:=jsonb_build_object('provider','s3-compatible','bucket','statutory-test','retention_policy','seven_years',
  'legal_hold',false,'source_sha256',src.source_sha256,'content_sha256',r.content_sha256,
  'review_sha256',x->>'reviewHash','renderer_version','statutory-auditor-pdf-v1','artifacts',jsonb_build_array(
   jsonb_build_object('kind','source_json','mime_type','application/json','content_hash',src.source_sha256,
    'byte_size',octet_length(src.source_text),'object_key','tenants/'||t||'/reports/'||r.id||'/'||build_key||'/source_json/'||src.source_sha256),
   jsonb_build_object('kind','statutory_pdf','mime_type','application/pdf','content_hash',pdf_hash,
    'byte_size',1234,'object_key','tenants/'||t||'/reports/'||r.id||'/'||build_key||'/statutory_pdf/'||pdf_hash)));
 perform pg_temp.ok(public.begin_statutory_artifact_build(t,outsider,r.id,build_key,q,gen_random_uuid())->>'error'='founder_authority_required','external founder cannot build');
 perform pg_temp.ok(public.begin_statutory_artifact_build(t,founder,r.id,build_key,q||'{"unknown":true}'::jsonb,gen_random_uuid())->>'error'='invalid_request','strict intent keys');
 perform pg_temp.ok(public.begin_statutory_artifact_build(t,founder,r.id,build_key,jsonb_set(q,'{artifacts,0,content_hash}',to_jsonb(repeat('0',64))),gen_random_uuid())->>'error'='manifest_changed','source hash must match snapshot');
 perform pg_temp.ok(public.begin_statutory_artifact_build(t,founder,r.id,build_key,jsonb_set(q,'{artifacts,1,object_key}',to_jsonb('foreign-key'::text)),gen_random_uuid())->>'error'='invalid_request','typed deterministic key required');
 x:=public.begin_statutory_artifact_build(t,founder,r.id,build_key,q,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='pending' and x->>'replayed'='false','durable build intent before any object');
 select * into b from public.statutory_artifact_builds where id=(x->>'buildId')::uuid;
 perform pg_temp.ok(b.retain_until>clock_timestamp()+interval '6 years','fixed seven-year deadline');
 perform pg_temp.ok((public.begin_statutory_artifact_build(t,founder,r.id,build_key,q,gen_random_uuid())->>'replayed')::boolean,'exact begin replay');
 perform pg_temp.ok(public.begin_statutory_artifact_build(t,founder,r.id,gen_random_uuid(),q,gen_random_uuid())->>'error'='invalid_request','changed operation key is not a valid descriptor');
 perform pg_temp.ok(public.note_statutory_artifact_failure(t,founder,b.id,'object_version_not_found',gen_random_uuid())->>'status'='pending','missing object remains pending');
 perform pg_temp.ok(public.release_report(t,r.id,founder,r.content_sha256,pdf_hash,gen_random_uuid())->>'error'='build_not_settled','pending build refuses publication');
 source_receipt:=jsonb_build_object('provider','s3-compatible','bucket','statutory-test','object_key',q#>>'{artifacts,0,object_key}',
  'version_id','source-v1','content_hash',src.source_sha256,'byte_size',octet_length(src.source_text),
  'tenant_id',t,'engagement_id',eng,'collected_by_agent','statutory-report-builder','retain_until',b.retain_until,
  'readback_at',clock_timestamp(),'lock_mode','COMPLIANCE','verified',true,'legal_hold',false,
  'encryption','AES256','operation_id',b.id,'correlation_id',b.correlation_id);
 wrong:=source_receipt||'{"version_id":null}'::jsonb;
 perform pg_temp.ok(public.settle_statutory_artifact_version(t,founder,b.id,'source_json',wrong,gen_random_uuid()) ? 'error','null version refused');
 perform pg_temp.ok(public.settle_statutory_artifact_version(t,founder,b.id,'source_json',source_receipt||'{"verified":false}'::jsonb,gen_random_uuid()) ? 'error','unverified receipt refused');
 perform pg_temp.ok(public.settle_statutory_artifact_version(t,founder,b.id,'source_json',source_receipt||'{"lock_mode":"GOVERNANCE"}'::jsonb,gen_random_uuid()) ? 'error','noncompliance lock refused');
 perform pg_temp.ok(public.settle_statutory_artifact_version(t,founder,b.id,'source_json',source_receipt||jsonb_build_object('operation_id',gen_random_uuid()),gen_random_uuid()) ? 'error','wrong build binding refused');
 perform pg_temp.ok(public.settle_statutory_artifact_version(t,founder,b.id,'source_json',source_receipt||jsonb_build_object('readback_at',clock_timestamp()-interval '1 hour'),gen_random_uuid()) ? 'error','stale readback refused');
 x:=public.settle_statutory_artifact_version(t,founder,b.id,'source_json',source_receipt,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='pending','first typed receipt leaves build pending');
 perform pg_temp.ok((public.settle_statutory_artifact_version(t,founder,b.id,'source_json',source_receipt,gen_random_uuid())->>'replayed')::boolean,'identical receipt replay');
 perform pg_temp.ok(public.settle_statutory_artifact_version(t,founder,b.id,'source_json',source_receipt||'{"version_id":"other-v2"}'::jsonb,gen_random_uuid())->>'error'='receipt_conflict','changed version cannot replace receipt');
 perform pg_temp.ok(public.release_report(t,r.id,founder,r.content_sha256,pdf_hash,gen_random_uuid())->>'error'='build_not_settled','source-only state refuses release');
 pdf_receipt:=source_receipt||jsonb_build_object('object_key',q#>>'{artifacts,1,object_key}',
  'version_id','pdf-v1','content_hash',pdf_hash,'byte_size',1234,'readback_at',clock_timestamp());
 x:=public.settle_statutory_artifact_version(t,founder,b.id,'statutory_pdf',pdf_receipt,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='settled','both typed receipts settle build');
 perform pg_temp.ok((select count(*)=2 from public.statutory_artifact_versions where build_id=b.id),'exactly two immutable versions');
 perform pg_temp.ok(public.release_report(t,r.id,founder,r.content_sha256,repeat('e',64),gen_random_uuid())->>'error'='archive_hash_mismatch','wrong expected PDF digest refused');
 x:=public.release_report(t,r.id,founder,r.content_sha256,pdf_hash,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='published' and x->>'archiveHash'=pdf_hash,'founder releases exact reviewed PDF digest');
 perform pg_temp.ok((public.release_report(t,r.id,founder,r.content_sha256,pdf_hash,gen_random_uuid())->>'replayed')::boolean,'release idempotent');
 perform pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=t and action_type='report.released' and target_ref=r.id::text),'one release ledger entry');
 perform pg_temp.ok((select count(*)=2 from public.audit_ledger where tenant_id=t and action_type='report.artifact.settled' and target_ref=r.id::text),'one settlement ledger per typed receipt');
 -- Pramaan auditor assurance uses this exact released assessment-derived report.
 dossier_request:=jsonb_build_object('provider','s3-compatible','bucket','statutory-test',
  'source_sha256',src.source_sha256,'pdf_sha256',pdf_hash,
  'source_version_id',(select id::text from public.statutory_artifact_versions where build_id=b.id and artifact_kind='source_json'),
  'pdf_version_id',(select id::text from public.statutory_artifact_versions where build_id=b.id and artifact_kind='statutory_pdf'),
  'manifest_sha256',repeat('a',64),'archive_sha256',repeat('b',64),'archive_bytes',2000,
  'object_key','tenants/'||t||'/pramaan/auditor/'||r.id||'/'||build_key||'/'||repeat('b',64));
 perform pg_temp.ok(public.begin_auditor_pramaan(t,'99880000-0000-4000-8000-000000000004',r.id,build_key,'Auditor assurance',dossier_request,gen_random_uuid())->>'error'='manager_authority_required','viewer cannot create auditor dossier');
 perform pg_temp.ok(public.begin_auditor_pramaan(t,manager,r.id,build_key,'Auditor assurance',jsonb_set(dossier_request,'{source_sha256}',to_jsonb(repeat('e',64))),gen_random_uuid())->>'error'='source_version_conflict','wrong frozen auditor source hash refused');
 x:=public.begin_auditor_pramaan(t,manager,r.id,build_key,'Auditor assurance',dossier_request,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='pending','released auditor source creates only pending dossier');
 dossier_id:=(x->>'dossierId')::uuid; dossier_build:=(x->>'buildId')::uuid;
 dossier_proof:=(select proof_seal_hash from public.pramaan_dossiers where id=dossier_id);
 perform pg_temp.ok(public.seal_auditor_pramaan(t,founder,dossier_id,dossier_proof,gen_random_uuid())->>'error'='archive_unverified','auditor seal requires archive readback');
 dossier_receipt:=jsonb_build_object('provider','s3-compatible','bucket','statutory-test',
  'object_key',dossier_request->>'object_key','version_id','auditor-dossier-v1','content_hash',repeat('b',64),
  'byte_size',2000,'tenant_id',t,'engagement_id',eng,'collected_by_agent','pramaan',
  'retain_until',(select retain_until from public.pramaan_auditor_builds where id=dossier_build)+interval '1 second',
  'readback_at',clock_timestamp(),'lock_mode','COMPLIANCE','verified',true,'legal_hold',false,
  'encryption','AES256','operation_id',dossier_build,
  'correlation_id',(select correlation_id from public.pramaan_auditor_builds where id=dossier_build));
 perform pg_temp.ok(public.settle_auditor_pramaan(t,manager,dossier_build,dossier_receipt||'{"lock_mode":"GOVERNANCE"}'::jsonb,gen_random_uuid())->>'error'='receipt_mismatch','governance lock cannot settle auditor archive');
 x:=public.settle_auditor_pramaan(t,manager,dossier_build,dossier_receipt,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='settled','verified auditor archive receipt settles');
 perform pg_temp.ok(public.seal_auditor_pramaan(t,manager,dossier_id,dossier_proof,gen_random_uuid())->>'error'='founder_authority_required','manager cannot seal auditor dossier');
 x:=public.seal_auditor_pramaan(t,founder,dossier_id,dossier_proof,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='sealed','founder seals exact retained auditor archive');
 perform pg_temp.ok((select dossier_type='auditor_assurance' and sealed_by=founder from public.pramaan_dossiers where id=dossier_id),'auditor dossier type and founder bound');
 perform pg_temp.ok(not has_table_privilege('service_role','public.pramaan_auditor_builds','INSERT')
  and not has_table_privilege('service_role','public.pramaan_auditor_archives','INSERT')
  and not has_function_privilege('authenticated','public.begin_auditor_pramaan(uuid,uuid,uuid,uuid,text,jsonb,uuid)','EXECUTE'),
  'auditor dossier has no direct service/client write');
 perform pg_temp.ok(not has_table_privilege('service_role','public.statutory_artifact_versions','INSERT')
  and not has_table_privilege('service_role','public.statutory_artifact_builds','INSERT')
  and not has_table_privilege('authenticated','public.statutory_artifact_versions','SELECT')
  and not has_table_privilege('service_role','public.statutory_request_sources','INSERT')
  and not has_function_privilege('service_role','public.record_statutory_report_draft(uuid,uuid,uuid,text,text,text,text,text,uuid)','EXECUTE'),
  'private SQL-only write boundary and legacy draft revoked');
end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"99880000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select pg_temp.ok((select count(*)=1 from public.statutory_report_requests
  where tenant_id='99880000-0000-4000-8000-000000000010'),
  'manager sees only own request');
select set_config('request.jwt.claims','{"sub":"99880000-0000-4000-8000-000000000004","role":"authenticated"}',true);
select pg_temp.ok((select count(*)=0 from public.statutory_report_requests
  where tenant_id='99880000-0000-4000-8000-000000000010'),
  'viewer cannot inspect private request');
select set_config('request.jwt.claims','{"sub":"99880000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select pg_temp.ok((select count(*)=1 from public.statutory_report_requests
  where tenant_id='99880000-0000-4000-8000-000000000010'),
  'internal founder can inspect tenant request');
select pg_temp.ok(not has_table_privilege('authenticated','public.statutory_request_sources','SELECT'),
  'frozen assessment source is service-only');
reset role;
rollback;
