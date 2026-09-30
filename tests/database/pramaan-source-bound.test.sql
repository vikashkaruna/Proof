-- A source-bound board dossier cannot be synthesized, archived or sealed from
-- caller metadata alone. These are SQL authority checks; provider verification
-- is tested at the BFF boundary and cannot be simulated by forged SQL rows.
begin;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'ASSERTION FAILED: %',m; end if; end $$;

insert into auth.users(id,email) values
 ('99890000-0000-4000-8000-000000000001','pramaan-manager@example.invalid'),
 ('99890000-0000-4000-8000-000000000002','pramaan-founder@example.invalid'),
 ('99890000-0000-4000-8000-000000000003','pramaan-viewer@example.invalid');
insert into public.users(id,email,full_name,is_axiom_internal) values
 ('99890000-0000-4000-8000-000000000001','pramaan-manager@example.invalid','Manager',false),
 ('99890000-0000-4000-8000-000000000002','pramaan-founder@example.invalid','Founder',true),
 ('99890000-0000-4000-8000-000000000003','pramaan-viewer@example.invalid','Viewer',false);
insert into public.tenants(id,slug,name) values
 ('99890000-0000-4000-8000-000000000010','pramaan-source-test','Pramaan Source Test');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('99890000-0000-4000-8000-000000000010','99890000-0000-4000-8000-000000000001','admin'),
 ('99890000-0000-4000-8000-000000000010','99890000-0000-4000-8000-000000000002','founder'),
 ('99890000-0000-4000-8000-000000000010','99890000-0000-4000-8000-000000000003','viewer');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('pramaan-test-lib',now(),'fixture','synthetic',0);
insert into public.engagements(id,tenant_id,library_version,title) values
 ('99890000-0000-4000-8000-000000000020','99890000-0000-4000-8000-000000000010','pramaan-test-lib','Pramaan test');
insert into public.reports(id,tenant_id,engagement_id,kind,title,content,library_version,
 generated_by_agent,status,content_text,content_sha256,reviewed_content_hash,
 released_archive_hash,published_at,released_by) values
 ('99890000-0000-4000-8000-000000000030','99890000-0000-4000-8000-000000000010',
  '99890000-0000-4000-8000-000000000020','board','Published board source','{}',
  'pramaan-test-lib','board-report-builder','published','{}',
  encode(sha256(convert_to('{}','UTF8')),'hex'),encode(sha256(convert_to('{}','UTF8')),'hex'),
  repeat('b',64),clock_timestamp(),'99890000-0000-4000-8000-000000000002');
insert into public.report_reviews(id,tenant_id,report_id,decision,content_sha256,reviewed_by,
 reviewer_name,reviewed_at,review_text,review_sha256) values
 ('99890000-0000-4000-8000-000000000031','99890000-0000-4000-8000-000000000010',
  '99890000-0000-4000-8000-000000000030','approved',
  encode(sha256(convert_to('{}','UTF8')),'hex'),'99890000-0000-4000-8000-000000000002',
  'Founder',clock_timestamp(),'review',encode(sha256(convert_to('review','UTF8')),'hex'));
insert into public.board_artifact_builds(id,tenant_id,report_id,operation_key,actor_id,review_id,
 source_sha256,content_sha256,review_sha256,request,retain_until,correlation_id,status,settled_at) values
 ('99890000-0000-4000-8000-000000000040','99890000-0000-4000-8000-000000000010',
  '99890000-0000-4000-8000-000000000030','99890000-0000-4000-8000-000000000041',
  '99890000-0000-4000-8000-000000000002','99890000-0000-4000-8000-000000000031',
  repeat('a',64),encode(sha256(convert_to('{}','UTF8')),'hex'),
  encode(sha256(convert_to('review','UTF8')),'hex'),'{}',clock_timestamp()+interval '7 years',
  gen_random_uuid(),'settled',clock_timestamp());
insert into public.board_artifact_versions(id,tenant_id,report_id,build_id,artifact_kind,provider,
 bucket,object_key,version_id,content_hash,byte_size,mime_type,retain_until,readback_at,
 lock_mode,legal_hold,encryption,receipt,verified_by) values
 ('99890000-0000-4000-8000-000000000050','99890000-0000-4000-8000-000000000010',
  '99890000-0000-4000-8000-000000000030','99890000-0000-4000-8000-000000000040',
  'source_json','s3-compatible','pramaan-test-bucket','source','source-version',repeat('a',64),
  100,'application/json',clock_timestamp()+interval '7 years',clock_timestamp(),'COMPLIANCE',false,
  'AES256','{}','99890000-0000-4000-8000-000000000002'),
 ('99890000-0000-4000-8000-000000000051','99890000-0000-4000-8000-000000000010',
  '99890000-0000-4000-8000-000000000030','99890000-0000-4000-8000-000000000040',
  'board_pdf','s3-compatible','pramaan-test-bucket','pdf','pdf-version',repeat('b',64),
  1000,'application/pdf',clock_timestamp()+interval '7 years',clock_timestamp(),'COMPLIANCE',false,
  'AES256','{}','99890000-0000-4000-8000-000000000002');

set local role service_role;
do $$
declare t uuid:='99890000-0000-4000-8000-000000000010';
 m uuid:='99890000-0000-4000-8000-000000000001';
 f uuid:='99890000-0000-4000-8000-000000000002';
 v uuid:='99890000-0000-4000-8000-000000000003';
 report uuid:='99890000-0000-4000-8000-000000000030';
 op uuid:='99890000-0000-4000-8000-000000000060';
 request jsonb; result jsonb; dossier uuid; build uuid; proof text; receipt jsonb; until_time text;
begin
 request:=jsonb_build_object('provider','s3-compatible','bucket','pramaan-test-bucket',
  'source_sha256',repeat('a',64),'pdf_sha256',repeat('b',64),
  'source_version_id','99890000-0000-4000-8000-000000000050',
  'pdf_version_id','99890000-0000-4000-8000-000000000051',
  'manifest_sha256',repeat('c',64),'archive_sha256',repeat('d',64),'archive_bytes',2000,
  'object_key','tenants/'||t::text||'/pramaan/'||report::text||'/'||op::text||'/'||repeat('d',64));
 result:=public.begin_source_bound_pramaan(t,v,report,op,'Board dossier',request,gen_random_uuid());
 perform pg_temp.ok(result->>'error'='manager_authority_required','viewer cannot start dossier');
 result:=public.begin_source_bound_pramaan(t,m,report,op,'Board dossier',
   jsonb_set(request,'{source_sha256}',to_jsonb(repeat('e',64))),gen_random_uuid());
 perform pg_temp.ok(result->>'error'='source_version_conflict','source digest mismatch refused');
 result:=public.begin_source_bound_pramaan(t,m,report,op,'Board dossier',request,gen_random_uuid());
 perform pg_temp.ok(result->>'status'='pending','verified source creates pending build');
 dossier:=(result->>'dossierId')::uuid;build:=(result->>'buildId')::uuid;
 perform pg_temp.ok((select status='draft' from public.pramaan_dossiers where id=dossier),
   'dossier is draft before archive readback');
 result:=public.begin_source_bound_pramaan(t,m,report,op,'Board dossier',request,gen_random_uuid());
 perform pg_temp.ok(result->>'replayed'='true','same operation replays');
 proof:=(select proof_seal_hash from public.pramaan_dossiers where id=dossier);
 result:=public.seal_source_bound_pramaan(t,f,dossier,proof,gen_random_uuid());
 perform pg_temp.ok(result->>'error'='archive_unverified','cannot seal before archive');
 until_time:=(select retain_until::text from public.pramaan_dossier_builds where id=build);
 receipt:=jsonb_build_object('provider','s3-compatible','bucket','pramaan-test-bucket',
  'object_key',request->>'object_key','version_id','archive-version-1','content_hash',repeat('d',64),
  'byte_size',2000,'tenant_id',t::text,'engagement_id','99890000-0000-4000-8000-000000000020',
  'collected_by_agent','pramaan','retain_until',to_char((until_time)::timestamptz+interval '1 second','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'readback_at',to_char(clock_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'lock_mode','COMPLIANCE','verified',true,'legal_hold',false,'encryption','AES256',
  'operation_id',build::text,'correlation_id',(select correlation_id::text from public.pramaan_dossier_builds where id=build));
 result:=public.settle_source_bound_pramaan(t,m,build,jsonb_set(receipt,'{content_hash}',to_jsonb(repeat('e',64))),gen_random_uuid());
 perform pg_temp.ok(result->>'error'='receipt_mismatch','mismatched archive digest refused');
 result:=public.settle_source_bound_pramaan(t,m,build,receipt,gen_random_uuid());
 perform pg_temp.ok(result->>'status'='settled','exact readback receipt settles');
 result:=public.seal_source_bound_pramaan(t,m,dossier,proof,gen_random_uuid());
 perform pg_temp.ok(result->>'error'='founder_authority_required','manager cannot seal');
 result:=public.seal_source_bound_pramaan(t,f,dossier,repeat('0',64),gen_random_uuid());
 perform pg_temp.ok(result->>'error'='proof_seal_mismatch','wrong reviewed proof hash refused');
 result:=public.seal_source_bound_pramaan(t,f,dossier,proof,gen_random_uuid());
 perform pg_temp.ok(result->>'status'='sealed','internal founder seals retained dossier');
 perform pg_temp.ok((select sealed_by=f from public.pramaan_dossiers where id=dossier),'founder recorded');
end $$;
rollback;
