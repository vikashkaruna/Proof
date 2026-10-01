begin;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'ASSERTION FAILED: %',m; end if; end $$;
insert into auth.users(id,email) select ('99430000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 'technical-'||n||'@example.invalid' from generate_series(1,4) n;
insert into public.users(id,email,is_axiom_internal) values
 ('99430000-0000-4000-8000-000000000001','technical-1@example.invalid',false),
 ('99430000-0000-4000-8000-000000000002','technical-2@example.invalid',true),
 ('99430000-0000-4000-8000-000000000003','technical-3@example.invalid',false),
 ('99430000-0000-4000-8000-000000000004','technical-4@example.invalid',false);
insert into public.tenants(id,slug,name) values
 ('99430000-0000-4000-8000-000000000010','technical-a','Technical A'),
 ('99430000-0000-4000-8000-000000000020','technical-b','Technical B');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('99430000-0000-4000-8000-000000000010','99430000-0000-4000-8000-000000000001','admin'),
 ('99430000-0000-4000-8000-000000000010','99430000-0000-4000-8000-000000000002','founder'),
 ('99430000-0000-4000-8000-000000000010','99430000-0000-4000-8000-000000000003','founder'),
 ('99430000-0000-4000-8000-000000000010','99430000-0000-4000-8000-000000000004','viewer');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('technical-test',now(),'fixture','synthetic',0);
insert into public.estates(id,tenant_id,name,slug) values
 ('99430000-0000-4000-8000-000000000050','99430000-0000-4000-8000-000000000010','Estate','technical-estate');
insert into public.engagements(id,tenant_id,estate_id,library_version,title) values
 ('99430000-0000-4000-8000-000000000030','99430000-0000-4000-8000-000000000010',
  '99430000-0000-4000-8000-000000000050','technical-test','Engagement');
insert into public.remediation_plans(id,tenant_id,engagement_id,library_version,title) values
 ('99430000-0000-4000-8000-000000000060','99430000-0000-4000-8000-000000000010',
  '99430000-0000-4000-8000-000000000030','technical-test','Recorded plan');
insert into public.remediation_actions(id,tenant_id,plan_id,sequence,action_type,description,
 risk_score,parameters,rollback_definition) values
 ('99430000-0000-4000-8000-000000000070','99430000-0000-4000-8000-000000000010',
  '99430000-0000-4000-8000-000000000060',1,'config.mfa_enforce','Enable MFA',45,
  '{"secret":"do-not-render"}'::jsonb,'{"revert":true}'::jsonb);
set local role postgres;
do $$
declare t uuid:='99430000-0000-4000-8000-000000000010';
 admin uuid:='99430000-0000-4000-8000-000000000001';
 founder uuid:='99430000-0000-4000-8000-000000000002';
 external_founder uuid:='99430000-0000-4000-8000-000000000003';
 viewer uuid:='99430000-0000-4000-8000-000000000004';
 plan uuid:='99430000-0000-4000-8000-000000000060';
 req public.technical_report_requests;src public.technical_request_sources;r public.reports;
 x jsonb;content text;op uuid:=gen_random_uuid();build_key uuid:=gen_random_uuid();
 q jsonb;b public.technical_artifact_builds;source_receipt jsonb;pdf_receipt jsonb;pdf_hash text:=repeat('d',64);
 dossier_request jsonb;dossier_receipt jsonb;dossier_id uuid;dossier_build uuid;proof text;dossier_key uuid:=gen_random_uuid();
begin
 perform pg_temp.ok(public.request_technical_report(t,viewer,gen_random_uuid(),plan,'Register',gen_random_uuid())->>'error'='forbidden','viewer cannot request');
 perform pg_temp.ok(public.request_technical_report(t,admin,gen_random_uuid(),gen_random_uuid(),'Register',gen_random_uuid())->>'error'='plan_not_found','foreign plan refused');
 perform pg_temp.ok(public.request_technical_report(t,admin,gen_random_uuid(),plan,'  ',gen_random_uuid())->>'error'='invalid_request','blank title refused');
 x:=public.request_technical_report(t,admin,op,plan,'Register',gen_random_uuid());
 perform pg_temp.ok(x->>'status'='requested','valid recorded plan request');
 select * into req from public.technical_report_requests where id=(x->>'requestId')::uuid;
 select * into src from public.technical_request_sources where request_id=req.id;
 perform pg_temp.ok(src.source_sha256=encode(sha256(convert_to(src.source_text,'UTF8')),'hex'),'exact source bytes hash');
 perform pg_temp.ok(src.source_text::jsonb->>'kind'='technical_plan_source','typed source');
 perform pg_temp.ok(src.source_text !~ 'do-not-render','raw parameters excluded');
 perform pg_temp.ok(jsonb_array_length(src.source_text::jsonb->'actions')=1,'frozen action count');
 perform pg_temp.ok((public.request_technical_report(t,admin,op,plan,'Register',gen_random_uuid())->>'replayed')::boolean,'request idempotent');
 perform pg_temp.ok(public.request_technical_report(t,admin,op,plan,'Changed',gen_random_uuid())->>'error'='idempotency_conflict','changed intent refused');
 content:=jsonb_build_object('schema_version',2,'kind','technical_recorded_register',
  'source_kind','recorded_remediation_plan','request_id',req.id,'tenant_id',t,'plan_id',plan,
  'source_sha256',src.source_sha256,'title',req.title,'generated_by','technical-report-builder')::text;
 perform pg_temp.ok(public.record_technical_report_draft(t,external_founder,req.id,content,gen_random_uuid())->>'error'='founder_authority_required','external founder refused');
 perform pg_temp.ok(public.record_technical_report_draft(t,founder,req.id,
  (content::jsonb||'{"independent_execution_certified":true}'::jsonb)::text,gen_random_uuid())->>'error'='source_binding_mismatch','invented claim refused');
 perform pg_temp.ok(public.record_technical_report_draft(t,founder,req.id,
  (content::jsonb||jsonb_build_object('source_sha256',repeat('0',64)))::text,gen_random_uuid())->>'error'='source_binding_mismatch','changed source refused');
 x:=public.record_technical_report_draft(t,founder,req.id,content,gen_random_uuid());
 select * into r from public.reports where id=(x->>'reportId')::uuid;
 perform pg_temp.ok(r.kind='technical' and r.content_text=content,'draft exact manifest');
 perform pg_temp.ok(public.release_report(t,r.id,founder,r.content_sha256,repeat('d',64),gen_random_uuid())->>'error'='source_bound_workflow_required','generic release closed');
 perform pg_temp.ok(public.release_technical_report(t,r.id,founder,r.content_sha256,repeat('d',64),gen_random_uuid())->>'error'='not_approved','unreviewed release closed');
 x:=public.review_report(t,r.id,'approved',null,founder,r.content_sha256,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='approved','founder review recorded');
 perform pg_temp.ok(public.release_technical_report(t,r.id,founder,r.content_sha256,pdf_hash,gen_random_uuid())->>'error'='build_not_settled','review alone cannot release');
 q:=jsonb_build_object('provider','s3-compatible','bucket','technical-test',
  'retention_policy','seven_years','legal_hold',false,'source_sha256',src.source_sha256,
  'content_sha256',r.content_sha256,'review_sha256',x->>'reviewHash',
  'renderer_version','chromium-technical-v1','artifacts',jsonb_build_array(
    jsonb_build_object('kind','source_json','mime_type','application/json',
      'content_hash',src.source_sha256,'byte_size',octet_length(src.source_text),
      'object_key','reports/technical/'||t||'/'||r.id||'/source_json/'||src.source_sha256),
    jsonb_build_object('kind','technical_pdf','mime_type','application/pdf',
      'content_hash',pdf_hash,'byte_size',1234,
      'object_key','reports/technical/'||t||'/'||r.id||'/technical_pdf/'||pdf_hash)));
 perform pg_temp.ok(public.begin_technical_artifact_build(t,founder,r.id,build_key,
   q||'{"invented":true}'::jsonb,gen_random_uuid())->>'error'='invalid_request','extra build claims refused');
 x:=public.begin_technical_artifact_build(t,founder,r.id,build_key,q,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='pending','build intent recorded');
 select * into b from public.technical_artifact_builds where id=(x->>'buildId')::uuid;
 perform pg_temp.ok(public.release_technical_report(t,r.id,founder,r.content_sha256,pdf_hash,gen_random_uuid())->>'error'='build_not_settled','pending build cannot release');
 source_receipt:=jsonb_build_object('provider','s3-compatible','bucket','technical-test',
  'object_key',q#>>'{artifacts,0,object_key}','version_id','source-v1',
  'content_hash',src.source_sha256,'byte_size',octet_length(src.source_text),
  'mime_type','application/json','retain_until',b.retain_until,
  'readback_at',clock_timestamp(),'lock_mode','COMPLIANCE','legal_hold',false,'encryption','AES256');
 perform pg_temp.ok(public.settle_technical_artifact_version(t,founder,b.id,'source_json',
   source_receipt||'{"lock_mode":"GOVERNANCE"}'::jsonb,gen_random_uuid())->>'error'='receipt_mismatch','noncompliant lock refused');
 x:=public.settle_technical_artifact_version(t,founder,b.id,'source_json',source_receipt,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='pending','source alone insufficient');
 pdf_receipt:=source_receipt||jsonb_build_object('object_key',q#>>'{artifacts,1,object_key}',
  'version_id','pdf-v1','content_hash',pdf_hash,'byte_size',1234,'mime_type','application/pdf',
  'readback_at',clock_timestamp());
 x:=public.settle_technical_artifact_version(t,founder,b.id,'technical_pdf',pdf_receipt,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='settled','both immutable versions settled');
 perform pg_temp.ok(public.release_technical_report(t,r.id,founder,r.content_sha256,repeat('e',64),gen_random_uuid())->>'error'='artifact_mismatch','wrong PDF refused');
 x:=public.release_technical_report(t,r.id,founder,r.content_sha256,pdf_hash,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='published','exact reviewed report released');
 perform pg_temp.ok((public.release_technical_report(t,r.id,founder,r.content_sha256,pdf_hash,gen_random_uuid())->>'replayed')::boolean,'release replay stable');
 dossier_request:=jsonb_build_object('provider','s3-compatible','bucket','technical-test',
  'source_sha256',src.source_sha256,'pdf_sha256',pdf_hash,
  'source_version_id',(select id::text from public.technical_artifact_versions where build_id=b.id and artifact_kind='source_json'),
  'pdf_version_id',(select id::text from public.technical_artifact_versions where build_id=b.id and artifact_kind='technical_pdf'),
  'manifest_sha256',repeat('a',64),'archive_sha256',repeat('b',64),'archive_bytes',2000,
  'object_key','tenants/'||t||'/pramaan/technical/'||r.id||'/'||dossier_key||'/'||repeat('b',64));
 perform pg_temp.ok(public.begin_technical_pramaan(t,viewer,r.id,dossier_key,'Plan derivative',dossier_request,gen_random_uuid())->>'error'='manager_authority_required','viewer cannot create technical dossier');
 perform pg_temp.ok(public.begin_technical_pramaan(t,admin,r.id,dossier_key,'Plan derivative',jsonb_set(dossier_request,'{pdf_sha256}',to_jsonb(repeat('e',64))),gen_random_uuid())->>'error'='source_version_conflict','wrong technical PDF refused');
 perform pg_temp.ok(public.begin_technical_pramaan(t,admin,r.id,dossier_key,'Plan derivative',jsonb_set(dossier_request,'{source_version_id}',to_jsonb(gen_random_uuid()::text)),gen_random_uuid())->>'error'='source_version_conflict','substituted technical source version refused');
 x:=public.begin_technical_pramaan(t,admin,r.id,dossier_key,'Plan derivative',dossier_request,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='pending','released technical report creates pending dossier');
 dossier_id:=(x->>'dossierId')::uuid;dossier_build:=(x->>'buildId')::uuid;
 proof:=(select proof_seal_hash from public.pramaan_dossiers where id=dossier_id);
 perform pg_temp.ok(public.seal_technical_pramaan(t,founder,dossier_id,proof,gen_random_uuid())->>'error'='archive_unverified','unsettled technical archive cannot seal');
 dossier_receipt:=jsonb_build_object('provider','s3-compatible','bucket','technical-test',
  'object_key',dossier_request->>'object_key','version_id','technical-dossier-v1','content_hash',repeat('b',64),
  'byte_size',2000,'tenant_id',t,'engagement_id','99430000-0000-4000-8000-000000000030',
  'collected_by_agent','pramaan','retain_until',(select retain_until from public.pramaan_technical_builds where id=dossier_build)+interval '1 second',
  'readback_at',clock_timestamp(),'lock_mode','COMPLIANCE','verified',true,'legal_hold',false,
  'encryption','AES256','operation_id',dossier_build,
  'correlation_id',(select correlation_id from public.pramaan_technical_builds where id=dossier_build));
 perform pg_temp.ok(public.settle_technical_pramaan(t,admin,dossier_build,dossier_receipt||'{"lock_mode":"GOVERNANCE"}'::jsonb,gen_random_uuid())->>'error'='receipt_mismatch','technical governance lock refused');
 perform pg_temp.ok(public.settle_technical_pramaan(t,admin,dossier_build,dossier_receipt,gen_random_uuid())->>'status'='settled','technical exact receipt settles');
 perform pg_temp.ok(public.settle_technical_pramaan(t,admin,dossier_build,dossier_receipt||'{"version_id":"different-version"}'::jsonb,gen_random_uuid())->>'error'='receipt_conflict','settled technical archive version immutable');
 perform pg_temp.ok(public.seal_technical_pramaan(t,admin,dossier_id,proof,gen_random_uuid())->>'error'='founder_authority_required','admin cannot seal technical dossier');
 perform pg_temp.ok(public.seal_technical_pramaan(t,founder,dossier_id,repeat('0',64),gen_random_uuid())->>'error'='proof_seal_mismatch','changed technical proof hash refused');
 perform pg_temp.ok(public.seal_technical_pramaan(t,founder,dossier_id,proof,gen_random_uuid())->>'status'='sealed','founder seals technical derivative');
 perform pg_temp.ok(not has_table_privilege('service_role','public.pramaan_technical_builds','INSERT') and not has_table_privilege('service_role','public.pramaan_technical_archives','INSERT') and not has_function_privilege('authenticated','public.begin_technical_pramaan(uuid,uuid,uuid,uuid,text,jsonb,uuid)','EXECUTE'),'technical dossier RPC-only boundary');
 perform pg_temp.ok(not has_table_privilege('service_role','public.technical_request_sources','INSERT') and
  not has_table_privilege('service_role','public.technical_artifact_versions','INSERT') and
  not has_function_privilege('service_role','public.release_report_pre_technical(uuid,uuid,uuid,text,text,uuid)','EXECUTE'),'no direct or hidden generic write');
end $$;
reset role;
insert into public.dry_runs(id,tenant_id,action_id,plan_id,status,refusal_reason,renderable,
 parameters_hash,rollback_definition_hash,correlation_id) values
 ('99430000-0000-4000-8000-000000000080','99430000-0000-4000-8000-000000000010',
  '99430000-0000-4000-8000-000000000070','99430000-0000-4000-8000-000000000060',
  'refused','fixture_refusal',false,repeat('a',64),repeat('b',64),gen_random_uuid());
update public.remediation_actions set latest_dry_run_id='99430000-0000-4000-8000-000000000080'
 where id='99430000-0000-4000-8000-000000000070';
set local role postgres;
do $$
declare before_count integer;
begin
 select count(*) into before_count from public.technical_report_requests;
 perform pg_temp.ok(public.request_technical_report(
  '99430000-0000-4000-8000-000000000010',
  '99430000-0000-4000-8000-000000000001',gen_random_uuid(),
  '99430000-0000-4000-8000-000000000060','Mismatched dry run',gen_random_uuid()
 )->>'error'='dry_run_source_mismatch','stale linked dry run cannot back a source');
 perform pg_temp.ok((select count(*) from public.technical_report_requests)=before_count,
  'refused source creates no request row');
end $$;
reset role;
insert into public.dry_runs(id,tenant_id,action_id,plan_id,status,diff,renderable,
 parameters_hash,rollback_definition_hash,correlation_id) values
 ('99430000-0000-4000-8000-000000000081','99430000-0000-4000-8000-000000000010',
  '99430000-0000-4000-8000-000000000070','99430000-0000-4000-8000-000000000060',
  'succeeded','{"changes":[]}'::jsonb,true,
  encode(sha256(convert_to('{"secret": "do-not-render"}'::jsonb::text,'UTF8')),'hex'),
  encode(sha256(convert_to('{"revert": true}'::jsonb::text,'UTF8')),'hex'),gen_random_uuid());
insert into public.approval_tokens(id,tenant_id,plan_id,action_ids,approver_id,mode,signature,
 signed_payload,nonce,expires_at) values
 ('99430000-0000-4000-8000-000000000082','99430000-0000-4000-8000-000000000010',
  '99430000-0000-4000-8000-000000000060',array['99430000-0000-4000-8000-000000000070'::uuid],
  '99430000-0000-4000-8000-000000000001','individual','fixture-signature','{}',
  'technical-fixture-nonce',now()+interval '1 hour');
insert into public.execution_batches(id,tenant_id,plan_id,request_key,correlation_id,
 approval_token_id,content_digest,mode,concurrency,stop_on_failure,status,finished_at) values
 ('99430000-0000-4000-8000-000000000083','99430000-0000-4000-8000-000000000010',
  '99430000-0000-4000-8000-000000000060','technical-fixture-batch',gen_random_uuid(),
  '99430000-0000-4000-8000-000000000082',repeat('c',64),'individual',1,true,
  'completed',clock_timestamp());
insert into public.rollback_executions(id,tenant_id,action_id,batch_id,definition,
 definition_hash,triggered_by,status,correlation_id,finished_at) values
 ('99430000-0000-4000-8000-000000000084','99430000-0000-4000-8000-000000000010',
  '99430000-0000-4000-8000-000000000070','99430000-0000-4000-8000-000000000083',
  '{"revert":true}'::jsonb,
  encode(sha256(convert_to('{"revert": true}'::jsonb::text,'UTF8')),'hex'),
  'manual','succeeded',gen_random_uuid(),clock_timestamp());
insert into public.verification_results(id,tenant_id,action_id,batch_id,checks,outcome,
 correlation_id) values
 ('99430000-0000-4000-8000-000000000085','99430000-0000-4000-8000-000000000010',
  '99430000-0000-4000-8000-000000000070','99430000-0000-4000-8000-000000000083',
  '[]'::jsonb,'passed',gen_random_uuid());
insert into public.plan_reconciliations(id,tenant_id,plan_id,batch_id,approved_scope,
 executed_reality,statement,statement_signature) values
 ('99430000-0000-4000-8000-000000000086','99430000-0000-4000-8000-000000000010',
  '99430000-0000-4000-8000-000000000060','99430000-0000-4000-8000-000000000083',
  '{}'::jsonb,'{}'::jsonb,'Fixture statement',repeat('s',32));
update public.remediation_actions set
 latest_dry_run_id='99430000-0000-4000-8000-000000000081',
 approval_token_id='99430000-0000-4000-8000-000000000082',
 approved_by='99430000-0000-4000-8000-000000000001',approval_status='approved',
 execution_batch_id='99430000-0000-4000-8000-000000000083',
 execution_status='succeeded',final_outcome='succeeded',executed_at=clock_timestamp(),
 executed_by_agent='karya',
 latest_rollback_execution_id='99430000-0000-4000-8000-000000000084',
 latest_verification_result_id='99430000-0000-4000-8000-000000000085'
 where id='99430000-0000-4000-8000-000000000070';
set local role postgres;
do $$
declare x jsonb;source jsonb;facts jsonb;
begin
 x:=public.request_technical_report('99430000-0000-4000-8000-000000000010',
  '99430000-0000-4000-8000-000000000001',gen_random_uuid(),
  '99430000-0000-4000-8000-000000000060','Linked details',gen_random_uuid());
 perform pg_temp.ok(x->>'status'='requested','linked detail source accepted');
 select source_text::jsonb into source from public.technical_request_sources
  where request_id=(x->>'requestId')::uuid;
 facts:=source#>'{actions,0}';
 perform pg_temp.ok(facts#>>'{dry_run,status}'='succeeded','dry-run detail frozen');
 perform pg_temp.ok(facts#>>'{approval,status}'='issued','approval record frozen');
 perform pg_temp.ok(facts#>>'{execution,final_outcome}'='succeeded','execution record frozen');
 perform pg_temp.ok(facts#>>'{rollback_execution,status}'='succeeded','actual rollback distinguished');
 perform pg_temp.ok(facts#>>'{verification,outcome}'='passed','verification outcome frozen');
 perform pg_temp.ok((facts#>>'{reconciliation,unexecuted_count}')::integer=0,'reconciliation recorded');
 perform pg_temp.ok(source::text !~ 'do-not-render','raw action parameters never leave source boundary');
end $$;
reset role;
select pg_temp.ok(not has_function_privilege('service_role',
 'public.request_technical_report(uuid,uuid,uuid,uuid,text,uuid)','EXECUTE')
 and not has_function_privilege('service_role',
 'public.begin_technical_pramaan(uuid,uuid,uuid,uuid,text,jsonb,uuid)','EXECUTE')
 and has_function_privilege('statutory_proof_writer',
 'public.request_technical_report(uuid,uuid,uuid,uuid,text,uuid)','EXECUTE'),
 'statutory writer owns technical mutation entry points');
set local role service_role;
do $$ begin
  begin
    perform public.request_technical_report(
      '99430000-0000-4000-8000-000000000010',
      '99430000-0000-4000-8000-000000000001',gen_random_uuid(),
      '99430000-0000-4000-8000-000000000060','Forged',gen_random_uuid());
    raise exception 'service_role unexpectedly invoked request_technical_report';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role statutory_proof_writer;
select pg_temp.ok(public.request_technical_report(
 '99430000-0000-4000-8000-000000000010',
 '99430000-0000-4000-8000-000000000001',gen_random_uuid(),
 gen_random_uuid(),'Invalid plan',gen_random_uuid())->>'error'='plan_not_found',
 'statutory writer invokes checked technical source RPC');
reset role;
rollback;
