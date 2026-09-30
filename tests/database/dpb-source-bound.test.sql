-- An unreviewed, foreign or superseded DPB notification cannot become a report source.
begin;
create function pg_temp.assert_true(value boolean,message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end $$;
create function pg_temp.assert_eq(actual text,expected text,message text) returns void language plpgsql as $$
begin if actual is distinct from expected then raise exception 'ASSERTION FAILED: % expected %, got %',message,expected,actual; end if; end $$;

insert into auth.users(id,email) values
 ('91000000-0000-4000-8000-000000000001','dpb-owner@test.invalid'),
 ('91000000-0000-4000-8000-000000000002','dpb-reviewer@test.invalid'),
 ('91000000-0000-4000-8000-000000000003','dpb-founder@test.invalid'),
 ('91000000-0000-4000-8000-000000000004','dpb-outsider@test.invalid');
insert into public.users(id,email,is_axiom_internal) values
 ('91000000-0000-4000-8000-000000000001','dpb-owner@test.invalid',false),
 ('91000000-0000-4000-8000-000000000002','dpb-reviewer@test.invalid',false),
 ('91000000-0000-4000-8000-000000000003','dpb-founder@test.invalid',true),
 ('91000000-0000-4000-8000-000000000004','dpb-outsider@test.invalid',false);
insert into public.tenants(id,slug,name) values
 ('91000000-0000-4000-8000-000000000011','dpb-source-a','DPB Source A'),
 ('91000000-0000-4000-8000-000000000012','dpb-source-b','DPB Source B');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('91000000-0000-4000-8000-000000000011','91000000-0000-4000-8000-000000000001','owner'),
 ('91000000-0000-4000-8000-000000000011','91000000-0000-4000-8000-000000000002','admin'),
 ('91000000-0000-4000-8000-000000000011','91000000-0000-4000-8000-000000000003','founder'),
 ('91000000-0000-4000-8000-000000000012','91000000-0000-4000-8000-000000000004','owner');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('dpb-source-fixture',now(),'test','fixture',0);
insert into public.breaches(id,tenant_id,title,description,severity,status,detected_at,dpb_notification_due_by)
 values('91000000-0000-4000-8000-000000000021','91000000-0000-4000-8000-000000000011',
 'CRM exposure','Operator recorded CRM exposure','high','notifying_dpb',now(),now()+interval '72 hours');
insert into public.breach_notifications(id,tenant_id,breach_id,kind,status,subject,body,
 correlation_id,created_by,reviewed_by,reviewed_at)
values
 ('91000000-0000-4000-8000-000000000031','91000000-0000-4000-8000-000000000011',
  '91000000-0000-4000-8000-000000000021','dpb','reviewed','Notice','Recorded incident',
  gen_random_uuid(),'91000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000002',now()),
 ('91000000-0000-4000-8000-000000000032','91000000-0000-4000-8000-000000000011',
  '91000000-0000-4000-8000-000000000021','affected_principal','reviewed','Other','Not DPB',
  gen_random_uuid(),'91000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000002',now()),
 ('91000000-0000-4000-8000-000000000033','91000000-0000-4000-8000-000000000011',
  '91000000-0000-4000-8000-000000000021','dpb','draft','Draft','Not reviewed',
  gen_random_uuid(),'91000000-0000-4000-8000-000000000001',null,null);

select pg_temp.assert_eq((public.request_dpb_report(
 '91000000-0000-4000-8000-000000000011','91000000-0000-4000-8000-000000000001',
 '91000000-0000-4000-8000-000000000041','91000000-0000-4000-8000-000000000021',
 '91000000-0000-4000-8000-000000000032','Review',gen_random_uuid())->>'error'),
 'notification_not_reviewed','affected-principal notice is not DPB source');
select pg_temp.assert_eq((public.request_dpb_report(
 '91000000-0000-4000-8000-000000000011','91000000-0000-4000-8000-000000000001',
 '91000000-0000-4000-8000-000000000042','91000000-0000-4000-8000-000000000021',
 '91000000-0000-4000-8000-000000000033','Review',gen_random_uuid())->>'error'),
 'notification_not_reviewed','unreviewed notice is refused');
select pg_temp.assert_eq((public.request_dpb_report(
 '91000000-0000-4000-8000-000000000012','91000000-0000-4000-8000-000000000004',
 '91000000-0000-4000-8000-000000000043','91000000-0000-4000-8000-000000000021',
 '91000000-0000-4000-8000-000000000031','Review',gen_random_uuid())->>'error'),
 'breach_not_found','foreign tenant cannot source report');

select pg_temp.assert_true((public.request_dpb_report(
 '91000000-0000-4000-8000-000000000011','91000000-0000-4000-8000-000000000001',
 '91000000-0000-4000-8000-000000000044','91000000-0000-4000-8000-000000000021',
 '91000000-0000-4000-8000-000000000031','DPB review',gen_random_uuid())->>'requestId') is not null,
 'reviewed DPB notification creates a request');
select pg_temp.assert_true((select source_sha256=encode(sha256(convert_to(source_text,'UTF8')),'hex')
 and source_text::jsonb->>'kind'='dpb_breach_source'
 and source_text::jsonb->'notification'->>'status'='reviewed'
 from public.dpb_request_sources limit 1),'source is frozen and hashed');
select pg_temp.assert_eq((public.request_dpb_report(
 '91000000-0000-4000-8000-000000000011','91000000-0000-4000-8000-000000000001',
 '91000000-0000-4000-8000-000000000044','91000000-0000-4000-8000-000000000021',
 '91000000-0000-4000-8000-000000000031','DPB review',gen_random_uuid())->>'replayed'),
 'true','idempotent replay');
-- Historical replay remains the same frozen request after the live notice
-- changes. A fresh operation must still refuse the now-superseded notice.
update public.breach_notifications set status='superseded',superseded_by='91000000-0000-4000-8000-000000000033'
 where id='91000000-0000-4000-8000-000000000031';
select pg_temp.assert_eq((public.request_dpb_report(
 '91000000-0000-4000-8000-000000000011','91000000-0000-4000-8000-000000000001',
 '91000000-0000-4000-8000-000000000044','91000000-0000-4000-8000-000000000021',
 '91000000-0000-4000-8000-000000000031','DPB review',gen_random_uuid())->>'replayed'),
 'true','historical replay survives source supersession');
select pg_temp.assert_eq((public.request_dpb_report(
 '91000000-0000-4000-8000-000000000011','91000000-0000-4000-8000-000000000001',
 '91000000-0000-4000-8000-000000000045','91000000-0000-4000-8000-000000000021',
 '91000000-0000-4000-8000-000000000031','DPB review',gen_random_uuid())->>'error'),
 'notification_not_reviewed','fresh source cannot use superseded notice');

select pg_temp.assert_eq((public.record_dpb_report_draft(
 '91000000-0000-4000-8000-000000000011','91000000-0000-4000-8000-000000000003',
 (select id from public.dpb_report_requests limit 1),
 '{"schema_version":2,"kind":"dpb_notification_review_pack","request_id":"91000000-0000-4000-8000-000000000044","tenant_id":"91000000-0000-4000-8000-000000000011","source_sha256":"bad","title":"DPB review","generated_by":"dpb-report-builder"}',
 gen_random_uuid())->>'error'),'source_binding_mismatch','invented source digest refused');
select pg_temp.assert_eq((public.record_dpb_report_draft(
 '91000000-0000-4000-8000-000000000011','91000000-0000-4000-8000-000000000003',
 (select id from public.dpb_report_requests limit 1),
 (select jsonb_build_object('schema_version',2,'kind','dpb_notification_review_pack',
  'request_id',r.id,'tenant_id',r.tenant_id,'source_sha256',s.source_sha256,
  'title',r.title,'generated_by','dpb-report-builder','regulator_accepted',true)::text
  from public.dpb_report_requests r join public.dpb_request_sources s on s.request_id=r.id limit 1),
 gen_random_uuid())->>'error'),'source_binding_mismatch','invented acceptance claim refused');
select pg_temp.assert_eq((public.record_dpb_report_draft(
 '91000000-0000-4000-8000-000000000011','91000000-0000-4000-8000-000000000003',
 (select id from public.dpb_report_requests limit 1),
 (select jsonb_build_object('schema_version',2,'kind','dpb_notification_review_pack',
  'request_id',r.id,'tenant_id',r.tenant_id,'source_sha256',s.source_sha256,
  'title',r.title,'generated_by',null)::text
  from public.dpb_report_requests r join public.dpb_request_sources s on s.request_id=r.id limit 1),
 gen_random_uuid())->>'error'),'source_binding_mismatch','null producer cannot bypass exact manifest');

select pg_temp.assert_true((public.record_dpb_report_draft(
 '91000000-0000-4000-8000-000000000011','91000000-0000-4000-8000-000000000003',
 (select id from public.dpb_report_requests limit 1),
 (select jsonb_build_object('schema_version',2,'kind','dpb_notification_review_pack',
  'request_id',r.id,'tenant_id',r.tenant_id,'source_sha256',s.source_sha256,
  'title',r.title,'generated_by','dpb-report-builder')::text
  from public.dpb_report_requests r join public.dpb_request_sources s on s.request_id=r.id limit 1),
 gen_random_uuid())->>'reportId') is not null,'frozen source creates deterministic draft');
select pg_temp.assert_eq((public.release_report(
 '91000000-0000-4000-8000-000000000011',
 (select report_id from public.dpb_report_requests limit 1),
 '91000000-0000-4000-8000-000000000003',
 (select content_sha256 from public.reports where id=(select report_id from public.dpb_report_requests limit 1)),
 null,gen_random_uuid())->>'error'),'source_bound_workflow_required','generic release always refuses DPB');
select pg_temp.assert_eq((public.release_report(
 '91000000-0000-4000-8000-000000000011',gen_random_uuid(),
 '91000000-0000-4000-8000-000000000003',repeat('a',64),null,gen_random_uuid())->>'error'),
 'report_not_found','generic release preserves non-DPB delegation');

do $$
declare tenant uuid:='91000000-0000-4000-8000-000000000011';
 founder uuid:='91000000-0000-4000-8000-000000000003';
 report uuid;content_hash text;source_hash text;source_size bigint;build uuid;
 req jsonb;source_receipt jsonb;pdf_receipt jsonb;until_at text;
 dossier_request jsonb;dossier_receipt jsonb;dossier_id uuid;dossier_build uuid;proof text;dossier_key uuid:=gen_random_uuid();x jsonb;
begin
 select report_id into report from public.dpb_report_requests where tenant_id=tenant limit 1;
 select content_sha256 into content_hash from public.reports where id=report;
 select source_sha256,octet_length(source_text) into source_hash,source_size
  from public.dpb_request_sources where tenant_id=tenant limit 1;
 perform pg_temp.assert_eq((public.review_report(tenant,report,'approved',null,founder,
  content_hash,gen_random_uuid())->>'status'),'approved','founder review succeeds');
 perform pg_temp.assert_eq((public.release_dpb_report(tenant,report,founder,content_hash,
  repeat('a',64),gen_random_uuid())->>'error'),'build_not_settled','release requires retained versions');
 req:=jsonb_build_object('provider','s3-compatible','bucket','dpb-test','retention_policy','seven_years',
  'legal_hold',false,'source_sha256',source_hash,'content_sha256',content_hash,
  'review_sha256',(select review_sha256 from public.report_reviews where report_id=report),
  'renderer_version','chromium-dpb-v1','artifacts',jsonb_build_array(
   jsonb_build_object('kind','source_json','mime_type','application/json','content_hash',source_hash,
    'byte_size',source_size,'object_key','reports/dpb/'||tenant||'/'||report||'/source_json/'||source_hash),
   jsonb_build_object('kind','dpb_pdf','mime_type','application/pdf','content_hash',repeat('a',64),
    'byte_size',1000,'object_key','reports/dpb/'||tenant||'/'||report||'/dpb_pdf/'||repeat('a',64))));
 perform pg_temp.assert_true((public.begin_dpb_artifact_build(tenant,founder,report,gen_random_uuid(),
  req,gen_random_uuid())->>'buildId') is not null,'reviewed exact build begins');
 select id,retain_until::text into build,until_at from public.dpb_artifact_builds where report_id=report;
 source_receipt:=jsonb_build_object('provider','s3-compatible','bucket','dpb-test',
  'object_key','reports/dpb/'||tenant||'/'||report||'/source_json/'||source_hash,
  'version_id','source-v1','content_hash',source_hash,'byte_size',source_size,'mime_type','application/json',
  'retain_until',until_at,'readback_at',clock_timestamp(),'lock_mode','COMPLIANCE','legal_hold',false,'encryption','AES256');
 pdf_receipt:=jsonb_build_object('provider','s3-compatible','bucket','dpb-test',
  'object_key','reports/dpb/'||tenant||'/'||report||'/dpb_pdf/'||repeat('a',64),
  'version_id','pdf-v1','content_hash',repeat('a',64),'byte_size',1000,'mime_type','application/pdf',
  'retain_until',until_at,'readback_at',clock_timestamp(),'lock_mode','COMPLIANCE','legal_hold',false,'encryption','AES256');
 perform pg_temp.assert_eq((public.settle_dpb_artifact_version(tenant,founder,build,'source_json',
  source_receipt,gen_random_uuid())->>'status'),'pending','one exact version stays pending');
 perform pg_temp.assert_eq((public.settle_dpb_artifact_version(tenant,founder,build,'dpb_pdf',
  pdf_receipt,gen_random_uuid())->>'status'),'settled','both exact versions settle');
 perform pg_temp.assert_eq((public.release_report(tenant,report,founder,content_hash,
  repeat('a',64),gen_random_uuid())->>'error'),'source_bound_workflow_required',
  'generic release cannot bypass provider readback after settlement');
 perform pg_temp.assert_eq((public.release_dpb_report(tenant,report,founder,content_hash,
  repeat('b',64),gen_random_uuid())->>'error'),'artifact_mismatch','wrong PDF hash refused');
 perform pg_temp.assert_eq((public.release_dpb_report(tenant,report,founder,content_hash,
  null,gen_random_uuid())->>'error'),'invalid_request','missing PDF hash refused cleanly');
 perform pg_temp.assert_eq((public.release_dpb_report(tenant,report,founder,content_hash,
  repeat('a',64),gen_random_uuid())->>'status'),'published','founder releases only matching versions');
 perform pg_temp.assert_true((select released_archive_hash=repeat('a',64) and status='published'
  from public.reports where id=report),'released PDF hash is recorded');
 dossier_request:=jsonb_build_object('provider','s3-compatible','bucket','dpb-test',
  'source_sha256',source_hash,'pdf_sha256',repeat('a',64),
  'source_version_id',(select id::text from public.dpb_artifact_versions where build_id=build and artifact_kind='source_json'),
  'pdf_version_id',(select id::text from public.dpb_artifact_versions where build_id=build and artifact_kind='dpb_pdf'),
  'manifest_sha256',repeat('b',64),'archive_sha256',repeat('c',64),'archive_bytes',2000,
  'object_key','tenants/'||tenant||'/pramaan/dpb/'||report||'/'||dossier_key||'/'||repeat('c',64));
 perform pg_temp.assert_eq(public.begin_dpb_pramaan(tenant,'91000000-0000-4000-8000-000000000004',report,dossier_key,'Breach derivative',dossier_request,gen_random_uuid())->>'error','manager_authority_required','foreign user cannot create DPB dossier');
 perform pg_temp.assert_eq(public.begin_dpb_pramaan(tenant,founder,report,dossier_key,'Breach derivative',jsonb_set(dossier_request,'{source_sha256}',to_jsonb(repeat('0',64))),gen_random_uuid())->>'error','source_version_conflict','wrong breach source refused');
 perform pg_temp.assert_eq(public.begin_dpb_pramaan(tenant,founder,report,dossier_key,'Breach derivative',jsonb_set(dossier_request,'{pdf_version_id}',to_jsonb(gen_random_uuid()::text)),gen_random_uuid())->>'error','source_version_conflict','substituted DPB PDF version refused');
 x:=public.begin_dpb_pramaan(tenant,founder,report,dossier_key,'Breach derivative',dossier_request,gen_random_uuid());
 perform pg_temp.assert_eq(x->>'status','pending','released DPB report creates pending dossier');
 dossier_id:=(x->>'dossierId')::uuid;dossier_build:=(x->>'buildId')::uuid;
 perform pg_temp.assert_true((select engagement_id is null and dossier_type='dpb_statutory' from public.pramaan_dossiers where id=dossier_id),'DPB dossier is tenant-scoped');
 proof:=(select proof_seal_hash from public.pramaan_dossiers where id=dossier_id);
 perform pg_temp.assert_eq(public.seal_dpb_pramaan(tenant,founder,dossier_id,proof,gen_random_uuid())->>'error','archive_unverified','unsettled DPB archive cannot seal');
 dossier_receipt:=jsonb_build_object('provider','s3-compatible','bucket','dpb-test',
  'object_key',dossier_request->>'object_key','version_id','dpb-dossier-v1','content_hash',repeat('c',64),
  'byte_size',2000,'tenant_id',tenant,'engagement_id',null,'collected_by_agent','pramaan',
  'retain_until',(select retain_until from public.pramaan_dpb_builds where id=dossier_build)+interval '1 second',
  'readback_at',clock_timestamp(),'lock_mode','COMPLIANCE','verified',true,'legal_hold',false,
  'encryption','AES256','operation_id',dossier_build,
  'correlation_id',(select correlation_id from public.pramaan_dpb_builds where id=dossier_build));
 perform pg_temp.assert_eq(public.settle_dpb_pramaan(tenant,founder,dossier_build,dossier_receipt||'{"engagement_id":"invented"}'::jsonb,gen_random_uuid())->>'error','receipt_mismatch','invented DPB engagement refused');
 perform pg_temp.assert_eq(public.settle_dpb_pramaan(tenant,founder,dossier_build,dossier_receipt,gen_random_uuid())->>'status','settled','tenant-level DPB exact receipt settles');
 perform pg_temp.assert_eq(public.settle_dpb_pramaan(tenant,founder,dossier_build,dossier_receipt||'{"version_id":"different-version"}'::jsonb,gen_random_uuid())->>'error','receipt_conflict','settled DPB archive version immutable');
 perform pg_temp.assert_eq(public.seal_dpb_pramaan(tenant,founder,dossier_id,repeat('0',64),gen_random_uuid())->>'error','proof_seal_mismatch','changed DPB proof hash refused');
 perform pg_temp.assert_eq(public.seal_dpb_pramaan(tenant,founder,dossier_id,proof,gen_random_uuid())->>'status','sealed','founder seals DPB derivative');
 perform pg_temp.assert_true(not has_table_privilege('service_role','public.pramaan_dpb_builds','INSERT') and not has_table_privilege('service_role','public.pramaan_dpb_archives','INSERT') and not has_function_privilege('authenticated','public.begin_dpb_pramaan(uuid,uuid,uuid,uuid,text,jsonb,uuid)','EXECUTE'),'DPB dossier RPC-only boundary');
end $$;

set local role service_role;
select pg_temp.assert_true(not has_table_privilege('service_role','public.dpb_request_sources','INSERT'),
 'service role cannot forge source directly');
select pg_temp.assert_true(not has_table_privilege('service_role','public.dpb_report_requests','INSERT'),
 'service role cannot forge request directly');
select pg_temp.assert_true(not has_table_privilege('service_role','public.dpb_artifact_builds','INSERT')
 and not has_table_privilege('service_role','public.dpb_artifact_versions','INSERT'),
 'service role cannot forge a retained build or version directly');
select pg_temp.assert_true(not has_function_privilege('service_role',
 'public.release_report_pre_dpb(uuid,uuid,uuid,text,text,uuid)','EXECUTE'),
 'service role cannot invoke the renamed generic release');
select pg_temp.assert_true(not has_function_privilege('anon',
 'public.release_report_pre_dpb(uuid,uuid,uuid,text,text,uuid)','EXECUTE')
 and not has_function_privilege('authenticated',
 'public.release_report_pre_dpb(uuid,uuid,uuid,text,text,uuid)','EXECUTE'),
 'anon and authenticated cannot invoke the renamed generic release');
select pg_temp.assert_true(not has_function_privilege('service_role',
 'public.release_report(uuid,uuid,uuid,text,text,uuid)','EXECUTE')
 and has_function_privilege('statutory_proof_writer',
 'public.release_report(uuid,uuid,uuid,text,text,uuid)','EXECUTE'),
 'only statutory writer may invoke guarded generic release');
do $$ begin
  begin
    perform public.request_dpb_report(
      '91000000-0000-4000-8000-000000000011',
      '91000000-0000-4000-8000-000000000001', gen_random_uuid(),
      '91000000-0000-4000-8000-000000000021',
      '91000000-0000-4000-8000-000000000031','Forged request',gen_random_uuid());
    raise exception 'service_role unexpectedly invoked request_dpb_report';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role statutory_proof_writer;
select pg_temp.assert_eq(public.request_dpb_report(
 '91000000-0000-4000-8000-000000000011',
 '91000000-0000-4000-8000-000000000001',gen_random_uuid(),
 '91000000-0000-4000-8000-000000000021',
 '91000000-0000-4000-8000-000000000033','Unreviewed',gen_random_uuid())->>'error',
 'notification_not_reviewed','statutory writer invokes checked source RPC');
reset role;
update public.tenant_users set role='viewer'
 where tenant_id='91000000-0000-4000-8000-000000000011'
 and user_id='91000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"91000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select pg_temp.assert_true((select count(*)=0 from public.pramaan_dossiers where dossier_type='dpb_statutory'),
 'tenant viewer cannot read breach dossier metadata');
select set_config('request.jwt.claims','{"sub":"91000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
select pg_temp.assert_true((select count(*)=1 from public.pramaan_dossiers where dossier_type='dpb_statutory'),
 'internal founder can read breach dossier metadata');
rollback;
