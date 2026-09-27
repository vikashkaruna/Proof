-- Real DB authority, exact-byte review, immutable manifest/archive and publication.
begin;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'ASSERTION FAILED: %',m; end if;end $$;
create function pg_temp.denied(statement text) returns void language plpgsql as $$
begin begin execute statement;exception when insufficient_privilege then return;end;raise exception 'not denied: %',statement;end $$;
insert into auth.users(id,email) select ('99740000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'pack-'||n||'@example.invalid' from generate_series(1,7) n;
insert into public.users(id,email,full_name,is_axiom_internal)
 select id,email,case when email='pack-2@example.invalid' then 'Reviewed Human' else 'Pack fixture' end,email in ('pack-2@example.invalid','pack-4@example.invalid')
 from auth.users where id::text like '99740000-%';
insert into public.tenants(id,slug,name) values
 ('99740000-0000-4000-8000-000000000010','pack-a','Pack A'),('99740000-0000-4000-8000-000000000020','pack-b','Pack B');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('99740000-0000-4000-8000-000000000010','99740000-0000-4000-8000-000000000001','owner'),
 ('99740000-0000-4000-8000-000000000010','99740000-0000-4000-8000-000000000002','founder'),
 ('99740000-0000-4000-8000-000000000010','99740000-0000-4000-8000-000000000003','viewer'),
 ('99740000-0000-4000-8000-000000000010','99740000-0000-4000-8000-000000000005','owner'),
 ('99740000-0000-4000-8000-000000000010','99740000-0000-4000-8000-000000000006','founder'),
 ('99740000-0000-4000-8000-000000000020','99740000-0000-4000-8000-000000000007','owner');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values('test-pack',now(),'fixture','synthetic',0);
insert into public.engagements(id,tenant_id,library_version,title) values
 ('99740000-0000-4000-8000-000000000030','99740000-0000-4000-8000-000000000010','test-pack','Pack fixture');
create function pg_temp.member_receipt(source text,h text,patch jsonb default '{}'::jsonb,t uuid default '99740000-0000-4000-8000-000000000010',a uuid default '99740000-0000-4000-8000-000000000001') returns uuid language plpgsql as $$
declare k uuid:=gen_random_uuid();x jsonb;r public.evidence_ingestions;receipt jsonb;
begin
 x:=public.begin_evidence_ingest(t,a,k,jsonb_build_object('content_hash',h,'byte_size',3,'mime_type','text/plain','filename','साक्ष्य.txt',
  'description','Human assertion only','evidence_type','document','control_ids','[]'::jsonb,'engagement_id',null,'collected_by_agent',source,
  'provider','s3-compatible','bucket','pack-test','object_key','tenants/'||t||'/evidence-ingestions/'||k||'/'||h,'retention_policy','seven_years','legal_hold',false)||patch,gen_random_uuid());
 select * into r from public.evidence_ingestions where id=(x->>'operation_id')::uuid;
 receipt:=(r.request-array['mime_type','filename','description','evidence_type','control_ids','retention_policy'])||
  jsonb_build_object('tenant_id',t,'operation_id',r.id,'correlation_id',r.correlation_id,'version_id','fixture-'||k,
  'retain_until',r.retain_until,'readback_at',clock_timestamp(),'lock_mode','COMPLIANCE','verified',true,'encryption','AES256');
 x:=public.settle_evidence_ingest(t,a,r.id,receipt,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='settled','synthetic provider receipt fixture uses sanctioned settlement');
 return (x->>'object_version_id')::uuid;
end $$;
-- Isolated boundary fixtures leave the lifecycle/RLS count assertions unchanged.
savepoint boundary_cases;
update public.control_libraries set is_current=false where is_current;
update public.control_libraries set is_current=true where version='test-pack';
insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values('test-pack-other',now(),'fixture','synthetic',1);
insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version)
 values('PACK-OTHER-001','test-pack-other','Synthetic control','Fixture only','GOV','low','[]','[]','[]','{}','{}','test-pack-other');

insert into public.engagements(id,tenant_id,library_version,title) values
 ('99740000-0000-4000-8000-000000000031','99740000-0000-4000-8000-000000000010','test-pack','Other scope');
set local role service_role;
do $$
declare t uuid:='99740000-0000-4000-8000-000000000010';a uuid:='99740000-0000-4000-8000-000000000001';
 eng uuid:='99740000-0000-4000-8000-000000000030';e uuid;scoped uuid;foreign_e uuid;other_e uuid;bad uuid;k uuid:=gen_random_uuid();x jsonb;payload text:='{ "synthetic": true, "sections": [] }';
begin
 e:=pg_temp.member_receipt('human',repeat('1',64));
 scoped:=pg_temp.member_receipt('human',repeat('2',64),jsonb_build_object('engagement_id',eng));
 other_e:=pg_temp.member_receipt('human',repeat('3',64),jsonb_build_object('engagement_id','99740000-0000-4000-8000-000000000031'));
 foreign_e:=pg_temp.member_receipt('human',repeat('4',64),'{}','99740000-0000-4000-8000-000000000020','99740000-0000-4000-8000-000000000007');
 perform pg_temp.ok(public.prepare_evidence_pack(t,a,gen_random_uuid(),'foreign',eng,null,array[foreign_e],gen_random_uuid())->>'error'='evidence_version_unavailable','existing foreign tenant receipt refused');
 perform pg_temp.ok(public.prepare_evidence_pack(t,a,gen_random_uuid(),repeat('界',200),eng,null,array[e,scoped],gen_random_uuid()) ? 'pack_id','200 Unicode characters and matching plus unscoped evidence accepted');
 perform pg_temp.ok(public.prepare_evidence_pack(t,a,gen_random_uuid(),repeat('界',201),eng,null,array[e],gen_random_uuid())->>'error'='invalid_request','201 Unicode characters refused');
 perform pg_temp.ok(public.prepare_evidence_pack(t,a,gen_random_uuid(),'other scope',eng,null,array[other_e],gen_random_uuid())->>'error'='engagement_mismatch','existing different engagement receipt refused');
 perform pg_temp.ok(public.prepare_evidence_pack(t,a,gen_random_uuid(),'no scope',null,null,array[scoped],gen_random_uuid())->>'error'='engagement_mismatch','engaged evidence excluded from unscoped pack');
 bad:=pg_temp.member_receipt('human',repeat('5',64),'{"filename":""}');
 perform pg_temp.ok(public.prepare_evidence_pack(t,a,gen_random_uuid(),'empty filename',eng,null,array[bad],gen_random_uuid())->>'error'='invalid_request','empty optional metadata cannot freeze an unbuildable manifest');
 bad:=pg_temp.member_receipt('human',repeat('6',64),jsonb_build_object('description','bad'||chr(1)||'text'));
 perform pg_temp.ok(public.prepare_evidence_pack(t,a,gen_random_uuid(),'control character',eng,null,array[bad],gen_random_uuid())->>'error'='invalid_request','unsupported control character refused');
 bad:=pg_temp.member_receipt('human',repeat('7',64),jsonb_build_object('control_ids',jsonb_build_array('PACK-OTHER-001')));
 perform pg_temp.ok(public.prepare_evidence_pack(t,a,gen_random_uuid(),'wrong library',eng,null,array[bad],gen_random_uuid())->>'error'='control_not_found','existing control outside resolved library refused');
 x:=public.record_report_draft(t,a,k,'board','Synthetic draft',eng,null,payload,'fixture',gen_random_uuid());
 perform pg_temp.ok(x->>'status'='draft' and x->>'contentHash'=encode(sha256(convert_to(payload,'UTF8')),'hex'),'generic draft stores exact source bytes');
 perform pg_temp.ok((select storage_uri is null from public.reports where id=(x->>'reportId')::uuid),'generic draft makes no provider storage claim');
 perform pg_temp.ok((public.record_report_draft(t,a,k,'board','Synthetic draft',eng,null,payload,'fixture',gen_random_uuid())->>'replayed')::boolean,'generic draft retry is idempotent');
 perform pg_temp.ok(public.record_report_draft(t,a,k,'board','Synthetic draft',eng,null,'{}','fixture',gen_random_uuid())->>'error'='idempotency_conflict','changed generic content cannot reuse operation');
 perform pg_temp.ok(public.record_report_draft(t,a,gen_random_uuid(),'evidence_pack','Forged pack',eng,null,payload,'fixture',gen_random_uuid())->>'error'='invalid_request','generic draft cannot bypass pack preparation');
end $$;
reset role;
rollback to boundary_cases;
create temp table pack_test_state(k text primary key,v text);grant all on pack_test_state to service_role,authenticated;
set local role service_role;
do $$
declare t uuid:='99740000-0000-4000-8000-000000000010';a uuid:='99740000-0000-4000-8000-000000000001';
 f uuid:='99740000-0000-4000-8000-000000000002';eng uuid:='99740000-0000-4000-8000-000000000030';
 e uuid:=pg_temp.member_receipt('human',repeat('a',64));agent_e uuid:=pg_temp.member_receipt('saakshi',repeat('b',64));
 k uuid:=gen_random_uuid();x jsonb;y jsonb;p public.evidence_packs;r public.reports;b public.evidence_pack_builds;
 q jsonb;receipt jsonb;build_key uuid:=gen_random_uuid();review_hash text;bad jsonb;
begin
 perform pg_temp.ok(public.prepare_evidence_pack(t,'99740000-0000-4000-8000-000000000003',k,'Pack',eng,null,array[e],gen_random_uuid())->>'error'='forbidden','viewer cannot prepare');
 perform pg_temp.ok(public.prepare_evidence_pack(t,a,k,'Pack',eng,null,array[gen_random_uuid()],gen_random_uuid())->>'error'='evidence_version_unavailable','foreign or missing receipt refused');
 perform pg_temp.ok(public.prepare_evidence_pack(t,a,k,'Pack',eng,null,array[e,e],gen_random_uuid())->>'error'='invalid_request','duplicate member refused');
 perform pg_temp.ok(public.prepare_evidence_pack(t,a,k,'Pack',eng,null,array[agent_e],gen_random_uuid())->>'error'='provenance_unavailable','unknown agent provenance excluded');
 x:=public.prepare_evidence_pack(t,a,k,'Reviewed साक्ष्य pack',eng,null,array[e],gen_random_uuid());
 select * into p from public.evidence_packs where id=(x->>'pack_id')::uuid;
 select * into r from public.reports where id=p.report_id;
 perform pg_temp.ok(p.id is not null and r.status='draft','durable pack and sole draft authority created');
 perform pg_temp.ok(p.manifest_text=r.content_text and p.manifest_sha256=encode(sha256(convert_to(p.manifest_text,'UTF8')),'hex'),'hash binds exact UTF8 text');
 perform pg_temp.ok(p.manifest_text::jsonb->>'serialization'='postgres-jsonb-text-v1','serialization is explicit');
 perform pg_temp.ok(p.manifest_text::jsonb#>>'{members,0,provenance}'='human_submitted','storage receipt never implies production provenance');
 perform pg_temp.ok(not(p.manifest_text::jsonb#>'{members,0}' ? 'bucket'),'public manifest does not disclose storage configuration');
 perform pg_temp.ok((public.prepare_evidence_pack(t,a,k,'Reviewed साक्ष्य pack',eng,null,array[e],gen_random_uuid())->>'replayed')::boolean,'same preparation replays exact manifest');
 perform pg_temp.ok(public.prepare_evidence_pack(t,a,k,'changed',eng,null,array[e],gen_random_uuid())->>'error'='idempotency_conflict','changed title cannot rewrite manifest');
 perform pg_temp.ok(public.review_report(t,r.id,'approved',null,a,p.manifest_sha256,gen_random_uuid())->>'error'='founder_authority_required','owner cannot review');
 perform pg_temp.ok(public.review_report(t,r.id,'approved',null,'99740000-0000-4000-8000-000000000004',p.manifest_sha256,gen_random_uuid())->>'error'='founder_authority_required','internal nonmember cannot review');
 perform pg_temp.ok(public.review_report(t,r.id,'approved',null,'99740000-0000-4000-8000-000000000006',p.manifest_sha256,gen_random_uuid())->>'error'='founder_authority_required','noninternal founder cannot review');
 perform pg_temp.ok(public.review_report(t,r.id,'approved',null,f,repeat('0',64),gen_random_uuid())->>'error'='manifest_changed','stale digest refuses review');
 perform pg_temp.ok(public.review_report(t,r.id,'rejected','   ',f,p.manifest_sha256,gen_random_uuid())->>'error'='reason_required','whitespace rejection is not a reason');
 x:=public.review_report(t,r.id,'approved',null,f,p.manifest_sha256,gen_random_uuid());review_hash:=x->>'reviewHash';
 perform pg_temp.ok(x->>'status'='approved' and x->>'reviewText' is not null,'review records exact text and digest');
 perform pg_temp.ok((x->>'reviewText')::jsonb#>>'{reviewer,display_name}'='Reviewed Human','review binds actual named human');
 perform pg_temp.ok((public.review_report(t,r.id,'approved',null,f,p.manifest_sha256,gen_random_uuid())->>'replayed')::boolean,'same review idempotent');
 perform pg_temp.ok(public.release_report(t,r.id,f,p.manifest_sha256,repeat('d',64),gen_random_uuid())->>'error'='build_not_settled','approval alone cannot release pack');
 q:=jsonb_build_object('provider','s3-compatible','bucket','pack-test','object_key','tenants/'||t||'/evidence-packs/'||p.id||'/'||build_key||'/'||repeat('d',64),
  'content_hash',repeat('d',64),'byte_size',1024,'manifest_sha256',p.manifest_sha256,'review_sha256',review_hash,'retention_policy','seven_years','legal_hold',false);
 perform pg_temp.ok(public.begin_evidence_pack_build(t,'99740000-0000-4000-8000-000000000005',p.id,build_key,q,gen_random_uuid())->>'error'='forbidden','other manager cannot build creator draft');
 perform pg_temp.ok(public.begin_evidence_pack_build(t,a,p.id,build_key,q||'{"byte_size":null}',gen_random_uuid())->>'error'='invalid_request','null archive size refused');
 x:=public.begin_evidence_pack_build(t,a,p.id,build_key,q,gen_random_uuid());
 select * into b from public.evidence_pack_builds where id=(x->>'build_id')::uuid;
 perform pg_temp.ok(b.id is not null and b.status='pending','durable build intent before provider upload');
 perform pg_temp.ok((public.begin_evidence_pack_build(t,a,p.id,build_key,q,gen_random_uuid())->>'replayed')::boolean,'same build replays fixed deadline');
 perform pg_temp.ok(public.begin_evidence_pack_build(t,a,p.id,build_key,q||'{"byte_size":1025}',gen_random_uuid())->>'error'='idempotency_conflict','changed archive bytes cannot replace pending intent');
 perform pg_temp.ok(public.note_evidence_pack_build_failure(t,a,b.id,'object_version_not_found',gen_random_uuid())->>'status'='pending','no object remains pending');
 receipt:=jsonb_build_object('provider','s3-compatible','bucket','pack-test','object_key',q->>'object_key','version_id','archive-fixture-v1',
  'content_hash',q->>'content_hash','byte_size',1024,'tenant_id',t,'engagement_id',eng,'collected_by_agent','evidence-pack-builder',
  'retain_until',b.retain_until,'readback_at',clock_timestamp(),'lock_mode','COMPLIANCE','verified',true,'legal_hold',false,'encryption','AES256',
  'operation_id',b.id,'correlation_id',b.correlation_id);
 foreach bad in array array['{"version_id":null}'::jsonb,'{"version_id":23}'::jsonb,'{"verified":false}'::jsonb,'{"lock_mode":"GOVERNANCE"}'::jsonb,
  jsonb_build_object('operation_id',gen_random_uuid()),jsonb_build_object('retain_until',b.retain_until-interval '1 second'),jsonb_build_object('readback_at',now()-interval '1 hour')] loop
  perform pg_temp.ok(public.settle_evidence_pack_build(t,a,b.id,receipt||bad,gen_random_uuid()) ? 'error','invalid or unbound receipt refused');
 end loop;
 x:=public.settle_evidence_pack_build(t,a,b.id,receipt,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='settled' and x->>'archive_sha256'=repeat('d',64),'archive settled without publishing report');
 perform pg_temp.ok((select status='approved' from public.reports where id=r.id),'settlement is not release');
 perform pg_temp.ok((public.settle_evidence_pack_build(t,a,b.id,receipt,gen_random_uuid())->>'replayed')::boolean,'settlement receipt idempotent');
 perform pg_temp.ok(public.settle_evidence_pack_build(t,a,b.id,receipt||'{"version_id":"changed"}',gen_random_uuid())->>'error'='receipt_conflict','archive exact version immutable');
 perform pg_temp.ok(public.release_report(t,r.id,f,p.manifest_sha256,repeat('c',64),gen_random_uuid())->>'error'='archive_hash_mismatch','wrong downloaded archive digest refused');
 -- Save IDs before publication for RLS assertions below.
 insert into pack_test_state values('pack',p.id::text),('report',r.id::text),('manifest',p.manifest_sha256),('build',b.id::text);
 perform pg_temp.denied('insert into public.reports(tenant_id,kind,title,storage_uri,content,library_version,generated_by_agent,status) values('''||t||''',''board'',''forged'',null,''{}'',''test-pack'',''fixture'',''published'')');
end $$;
reset role;
-- No direct client can read unreleased other-owner content or provider locations.
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"99740000-0000-4000-8000-000000000003"}',true);
select pg_temp.ok((select count(*)=0 from public.evidence_packs),'viewer cannot read unapproved pack');
select set_config('request.jwt.claims','{"sub":"99740000-0000-4000-8000-000000000005"}',true);
select pg_temp.ok((select count(*)=0 from public.evidence_packs),'other manager cannot read private draft');
select set_config('request.jwt.claims','{"sub":"99740000-0000-4000-8000-000000000001"}',true);
select pg_temp.ok((select count(*)=1 from public.evidence_packs),'creator can read own draft');
select pg_temp.denied('select bucket from public.evidence_pack_archives');
select pg_temp.denied('select request from public.evidence_pack_builds');
select pg_temp.denied('select public.review_report(gen_random_uuid(),gen_random_uuid(),''approved'',null,gen_random_uuid(),repeat(''a'',64),gen_random_uuid())');
reset role;
select pg_temp.denied('update public.evidence_packs set title=''tampered''');
select pg_temp.denied('update public.report_reviews set reviewer_name=''invented''');
select pg_temp.denied('delete from public.evidence_pack_archives');
select pg_temp.denied('update public.reports set content=''{}'' where content_text is not null');
-- These owner-issued writes bypass the sanctioned functions deliberately:
-- composite constraints must reject valid same-tenant IDs paired incorrectly.
do $$
declare t uuid:='99740000-0000-4000-8000-000000000010';a uuid:='99740000-0000-4000-8000-000000000001';
 e uuid;v uuid;p2 uuid;p3 uuid;b2 uuid;rejected boolean:=false;x jsonb;
begin
 begin
  insert into public.evidence(tenant_id,content_hash,storage_uri,evidence_type,collected_by_agent)
   values(t,repeat('c',64),'fixture://unverified-pairing','document','fixture') returning id into e;
  select v0.id into v from public.evidence_object_versions v0 join public.evidence e0 on e0.id=v0.evidence_id where e0.tenant_id=t and e0.collected_by_agent='saakshi';
  insert into public.evidence_pack_items(tenant_id,pack_id,evidence_id,evidence_version_id,ordinal,archive_path)
   values(t,(select pack_test_state.v::uuid from pack_test_state where k='pack'),e,v,2,'evidence/'||e||'.bin');
 exception when foreign_key_violation then rejected:=true; end;
 perform pg_temp.ok(rejected,'same-tenant receipt cannot be paired with another evidence row');
 rejected:=false;
 begin
  select v0.id into v from public.evidence_object_versions v0 join public.evidence e0 on e0.id=v0.evidence_id where e0.tenant_id=t and e0.collected_by_agent='human';
  x:=public.prepare_evidence_pack(t,a,gen_random_uuid(),'Pairing second pack','99740000-0000-4000-8000-000000000030',null,array[v],gen_random_uuid());p2:=(x->>'pack_id')::uuid;
  x:=public.prepare_evidence_pack(t,a,gen_random_uuid(),'Pairing third pack','99740000-0000-4000-8000-000000000030',null,array[v],gen_random_uuid());p3:=(x->>'pack_id')::uuid;
  insert into public.evidence_pack_builds(tenant_id,pack_id,operation_key,actor_id,request,retain_until,correlation_id)
   values(t,p2,gen_random_uuid(),a,'{}',now()+interval '7 years',gen_random_uuid()) returning id into b2;
  insert into public.evidence_pack_archives(tenant_id,pack_id,build_id,provider,bucket,object_key,version_id,content_hash,byte_size,lock_mode,
   retain_until,readback_at,legal_hold,encryption,receipt,verified_by)
   values(t,p3,b2,'s3-compatible','pair-test','wrong-pack','pair-v1',repeat('e',64),1,'COMPLIANCE',now()+interval '7 years',now(),false,'AES256','{}',a);
 exception when foreign_key_violation then rejected:=true; end;
 perform pg_temp.ok(rejected,'same-tenant build cannot settle an archive for another pack');
end $$;
-- Renaming the reviewer cannot rewrite the approval's immutable attribution.
update public.users set full_name='Changed Profile' where id='99740000-0000-4000-8000-000000000002';
select pg_temp.ok((select reviewer_name='Reviewed Human' from public.report_reviews where report_id=(select v::uuid from pack_test_state where k='report')),'named attribution survives profile edit');
set local role service_role;
select pg_temp.ok(public.release_report('99740000-0000-4000-8000-000000000010',(select v::uuid from pack_test_state where k='report'),
 '99740000-0000-4000-8000-000000000002',(select v from pack_test_state where k='manifest'),repeat('d',64),gen_random_uuid())->>'status'='published','founder releases exact reviewed archive');
select pg_temp.ok((public.release_report('99740000-0000-4000-8000-000000000010',(select v::uuid from pack_test_state where k='report'),
 '99740000-0000-4000-8000-000000000002',(select v from pack_test_state where k='manifest'),repeat('d',64),gen_random_uuid())->>'replayed')::boolean,'release idempotent');
reset role;
select pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id='99740000-0000-4000-8000-000000000010' and action_type='report.released'),'one release audit');
select pg_temp.ok(to_regprocedure('public.review_report(uuid,uuid,text,text,uuid,uuid)') is null,'old unbound review signature removed');
select pg_temp.ok(to_regprocedure('public.release_report(uuid,uuid,uuid,uuid)') is null,'old unbound release signature removed');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"99740000-0000-4000-8000-000000000003"}',true);
select pg_temp.ok((select count(*)=1 from public.evidence_packs),'viewer can read released pack metadata');
select set_config('request.jwt.claims','{"sub":"99740000-0000-4000-8000-000000000004"}',true);
select pg_temp.ok((select count(*)=0 from public.evidence_packs),'internal nonmember still cannot read released pack');
reset role;
update public.users set is_axiom_internal=false where id='99740000-0000-4000-8000-000000000002';
set local role service_role;
select pg_temp.ok(public.release_report('99740000-0000-4000-8000-000000000010',(select v::uuid from pack_test_state where k='report'),
 '99740000-0000-4000-8000-000000000002',(select v from pack_test_state where k='manifest'),repeat('d',64),gen_random_uuid())->>'error'='founder_authority_required','internal flag revoked blocks even release replay');
reset role;
rollback;
