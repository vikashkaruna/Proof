-- Disposable synthetic lifecycle transport fixture. No provider acceptance is
-- asserted. First exercise the real source gate, then replace only its private
-- source supplier inside this rolled-back transaction to isolate SQL lifecycle
-- authority/receipt/state/immutability tests. BFF tests own provider readback;
-- report-kit tests own complete source/ledger/member/ZIP integrity.
begin;
create function pg_temp.full_ok(value boolean,message text) returns void language plpgsql as $$begin if value is distinct from true then raise exception 'ASSERTION FAILED: %',message;end if;end $$;
insert into auth.users(id,email) values
 ('16400000-0000-4000-8000-000000000001','full-manager@example.invalid'),
 ('16400000-0000-4000-8000-000000000002','full-founder@example.invalid'),
 ('16400000-0000-4000-8000-000000000003','full-viewer@example.invalid');
insert into public.users(id,email,is_axiom_internal) values
 ('16400000-0000-4000-8000-000000000001','full-manager@example.invalid',false),
 ('16400000-0000-4000-8000-000000000002','full-founder@example.invalid',true),
 ('16400000-0000-4000-8000-000000000003','full-viewer@example.invalid',false);
insert into public.tenants(id,slug,name) values('16400000-0000-4000-8000-000000000010','full-closure-fixture','Synthetic closure');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('16400000-0000-4000-8000-000000000010','16400000-0000-4000-8000-000000000001','admin'),
 ('16400000-0000-4000-8000-000000000010','16400000-0000-4000-8000-000000000002','founder'),
 ('16400000-0000-4000-8000-000000000010','16400000-0000-4000-8000-000000000003','viewer');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values('full-closure-fixture',now(),'synthetic','Synthetic',0);
insert into public.engagements(id,tenant_id,library_version,title) values('16400000-0000-4000-8000-000000000020','16400000-0000-4000-8000-000000000010','full-closure-fixture','Synthetic');
insert into public.reports(id,tenant_id,engagement_id,kind,title,content,library_version,generated_by_agent) values('16400000-0000-4000-8000-000000000030','16400000-0000-4000-8000-000000000010','16400000-0000-4000-8000-000000000020','board','Synthetic anchor','{}','full-closure-fixture','fixture');
do $$begin
 begin
 perform public.read_full_closure_source('16400000-0000-4000-8000-000000000010','16400000-0000-4000-8000-000000000003','16400000-0000-4000-8000-000000000030');
 raise exception 'ASSERTION FAILED: viewer read source';exception when insufficient_privilege then null;end;
 begin
 perform public.read_full_closure_source('16400000-0000-4000-8000-000000000010','16400000-0000-4000-8000-000000000001','16400000-0000-4000-8000-000000000030');
 raise exception 'ASSERTION FAILED: invented published metadata accepted';exception when check_violation then perform pg_temp.full_ok(sqlerrm='released_board_source_required','real source gate refuses missing released board');end;
end $$;
select pg_temp.full_ok(not has_function_privilege('service_role','public.begin_full_pramaan(uuid,uuid,uuid,uuid,text,text,jsonb,uuid)','EXECUTE') and has_function_privilege('statutory_proof_writer','public.begin_full_pramaan(uuid,uuid,uuid,uuid,text,text,jsonb,uuid)','EXECUTE'),'generic service credential cannot mutate lifecycle');
select pg_temp.full_ok(not has_function_privilege('service_role','controller_security.full164_source(uuid,uuid)','EXECUTE'),'private source not exposed to service role');
select pg_temp.full_ok(not has_table_privilege('service_role','public.pramaan_full_builds','INSERT') and not has_table_privilege('statutory_proof_writer','public.pramaan_full_archives','INSERT') and not has_table_privilege('service_role','public.pramaan_full_reviews','UPDATE'),'direct mutations are unavailable');
-- Deliberate test double scoped to this transaction only. Preserve the real
-- public source authorizer and every persistence/receipt/state gate unchanged.
create temporary table full164_fixture(source_text text not null);
insert into full164_fixture values('{"engagement_id":"16400000-0000-4000-8000-000000000020","components":[]}');
create or replace function controller_security.full164_source(t uuid,board_report uuid) returns jsonb language sql security definer set search_path='' as $$select jsonb_build_object('sourceText',source_text,'sourceSha256',encode(sha256(convert_to(source_text,'UTF8')),'hex')) from pg_temp.full164_fixture$$;
do $$declare
 t uuid:='16400000-0000-4000-8000-000000000010';m uuid:='16400000-0000-4000-8000-000000000001';f uuid:='16400000-0000-4000-8000-000000000002';v uuid:='16400000-0000-4000-8000-000000000003';r uuid:='16400000-0000-4000-8000-000000000030';op uuid:=gen_random_uuid();src jsonb;q jsonb;x jsonb;d uuid;b uuid;proof text;receipt jsonb;
begin
 src:=public.read_full_closure_source(t,m,r);
 q:=jsonb_build_object('provider','s3-compatible','bucket','axiom-proof-local-evidence','source_sha256',src->>'sourceSha256','manifest_sha256',repeat('a',64),'archive_sha256',repeat('b',64),'archive_bytes',1234,'merkle_root',controller_security.full164_merkle(src->>'sourceSha256','[]'),'object_key','tenants/'||t||'/pramaan/full/'||r||'/'||op||'/'||repeat('b',64));
 x:=public.begin_full_pramaan(t,m,r,op,'Full synthetic',src->>'sourceText',q,gen_random_uuid());
 perform pg_temp.full_ok(x->>'status'='pending','begin creates pending only');d:=(x->>'dossierId')::uuid;b:=(x->>'buildId')::uuid;
 perform pg_temp.full_ok(public.begin_full_pramaan(t,m,r,op,'Full synthetic',src->>'sourceText',q,gen_random_uuid())->>'replayed'='true','exact replay creates no second dossier');
 perform pg_temp.full_ok(public.begin_full_pramaan(t,m,r,op,'Full synthetic',src->>'sourceText',jsonb_set(q,'{archive_sha256}',to_jsonb(repeat('c',64))),gen_random_uuid())->>'error'='invalid_request','changed archive cannot reuse deterministic key');
 proof:=(select proof_seal_hash from public.pramaan_dossiers where id=d);
 perform pg_temp.full_ok(public.seal_full_pramaan(t,f,d,proof,gen_random_uuid())->>'error'='reviewed_retained_archive_required','seal requires settled retained archive and review');
 receipt:=jsonb_build_object('provider','s3-compatible','bucket',q->>'bucket','object_key',q->>'object_key','version_id','synthetic-exact-version','content_hash',q->>'archive_sha256','byte_size',1234,'tenant_id',t,'engagement_id','16400000-0000-4000-8000-000000000020','collected_by_agent','pramaan','operation_id',b,'correlation_id',(select correlation_id from public.pramaan_full_builds where id=b),'retain_until',(select retain_until+interval '1 day' from public.pramaan_full_builds where id=b),'readback_at',clock_timestamp(),'verified',true,'legal_hold',false,'lock_mode','COMPLIANCE','encryption','AES256');
 perform pg_temp.full_ok(public.settle_full_pramaan(t,m,b,jsonb_set(receipt,'{version_id}','"null"'),gen_random_uuid())->>'error'='receipt_mismatch','null provider version refused');
 perform pg_temp.full_ok(public.settle_full_pramaan(t,v,b,receipt,gen_random_uuid())->>'error'='manager_authority_required','viewer cannot settle');
 update public.tenant_users set role='viewer' where tenant_id=t and user_id=m;
 perform pg_temp.full_ok(public.settle_full_pramaan(t,m,b,receipt,gen_random_uuid())->>'error'='manager_authority_required','revoked preparer cannot settle');
 update public.tenant_users set role='admin' where tenant_id=t and user_id=m;
 perform pg_temp.full_ok(public.settle_full_pramaan(t,m,b,receipt,gen_random_uuid())->>'status'='settled','exact provider receipt settles');
 perform pg_temp.full_ok(public.review_full_pramaan(t,m,d,repeat('b',64),'synthetic-exact-version','Reviewed',gen_random_uuid())->>'error'='founder_authority_required','manager cannot review');
 perform pg_temp.full_ok(public.review_full_pramaan(t,f,d,repeat('c',64),'synthetic-exact-version','Reviewed',gen_random_uuid())->>'error'='archive_unverified','review exact hash bound');
 perform pg_temp.full_ok(public.release_full_pramaan(t,f,d,repeat('b',64),'synthetic-exact-version',gen_random_uuid())->>'error'='sealed_retained_archive_required','cannot release before seal');
 update public.users set is_axiom_internal=true where id=m;update public.tenant_users set role='founder' where tenant_id=t and user_id=m;
 perform pg_temp.full_ok(public.review_full_pramaan(t,m,d,repeat('b',64),'synthetic-exact-version','Self reviewed',gen_random_uuid())->>'error'='independent_founder_review_required','preparer cannot certify own full pack');
 update public.users set is_axiom_internal=false where id=m;update public.tenant_users set role='admin' where tenant_id=t and user_id=m;
 perform pg_temp.full_ok(public.review_full_pramaan(t,f,d,repeat('b',64),'synthetic-exact-version','Reviewed exact archive',gen_random_uuid())->>'status'='approved','founder review records exact archive');
 update pg_temp.full164_fixture set source_text=source_text||' ';
 perform pg_temp.full_ok(public.seal_full_pramaan(t,f,d,proof,gen_random_uuid())->>'error'='closure_source_changed','changed source refuses seal');
 update pg_temp.full164_fixture set source_text=rtrim(source_text);
 perform pg_temp.full_ok(public.seal_full_pramaan(t,f,d,proof,gen_random_uuid())->>'status'='sealed','reviewed exact archive seals');
 perform pg_temp.full_ok(public.read_sealed_dossier_summaries(t,v,25,0)->>'total'='0','full pack withheld from viewer before release');
 update public.users set is_axiom_internal=false where id=f;
 perform pg_temp.full_ok(public.release_full_pramaan(t,f,d,repeat('b',64),'synthetic-exact-version',gen_random_uuid())->>'error'='founder_authority_required','revoked founder cannot release');
 update public.users set is_axiom_internal=true where id=f;
 perform pg_temp.full_ok(public.release_full_pramaan(t,f,d,repeat('b',64),'synthetic-exact-version',gen_random_uuid())->>'status'='released','founder separately releases exact archive');
 perform pg_temp.full_ok(public.release_full_pramaan(t,f,d,repeat('b',64),'synthetic-exact-version',gen_random_uuid())->>'replayed'='true','exact release replay is idempotent');
 perform pg_temp.full_ok(public.read_sealed_dossier_summaries(t,v,25,0)->>'total'='1','only released full summary visible to viewer');
 perform pg_temp.full_ok((select count(*)=1 from public.audit_ledger where tenant_id=t and target_ref=d::text and action_type='closure.pramaan.released'),'one immutable release receipt');
 begin update public.pramaan_full_reviews set note='rewritten' where dossier_id=d;raise exception 'ASSERTION FAILED: review rewrite';exception when insufficient_privilege then null;end;
 begin delete from public.pramaan_full_releases where dossier_id=d;raise exception 'ASSERTION FAILED: release delete';exception when insufficient_privilege then null;end;
 begin truncate public.pramaan_full_archives;raise exception 'ASSERTION FAILED: archive truncate';exception when insufficient_privilege then null;end;
 begin update public.pramaan_full_builds set source_text='{}' where id=b;raise exception 'ASSERTION FAILED: source rewrite';exception when insufficient_privilege then null;end;
end $$;
rollback;
