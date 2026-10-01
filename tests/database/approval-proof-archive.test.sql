-- 0090: database facts, fixed archive source, immutable receipt and founder release.
begin;
insert into axiom_secrets.reconciliation_keys(scope,key_bytes)
values('global',convert_to('test-reconciliation-signing-key-0123456789','UTF8'));
create function pg_temp.assert_true(ok boolean,msg text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERTION FAILED: %',msg; end if; end $$;
create function pg_temp.assert_eq(actual text,expected text,msg text) returns void language plpgsql as $$
begin if actual is distinct from expected then raise exception 'ASSERTION FAILED: % (got %, expected %)',msg,actual,expected; end if; end $$;
select pg_temp.assert_true(not has_schema_privilege('service_role','axiom_secrets','USAGE')
 and not has_table_privilege('service_role','axiom_secrets.reconciliation_keys','SELECT')
 and not has_table_privilege('service_role','axiom_secrets.reconciliation_keys','INSERT')
 and not has_function_privilege('service_role',
   'public.record_plan_reconciliation_unchecked(uuid,uuid,uuid,uuid,text,text)','EXECUTE'),
 'generic service credential cannot read or replace HMAC key or bypass verifier');
select pg_temp.assert_true(
 not has_function_privilege('service_role','public.begin_approval_proof_archive(uuid,uuid,uuid,uuid,text,text,text,text,integer,uuid)','EXECUTE')
 and not has_function_privilege('service_role','public.settle_approval_proof_archive(uuid,uuid,uuid,jsonb,uuid)','EXECUTE')
 and not has_function_privilege('service_role','public.review_approval_proof_archive(uuid,uuid,uuid,text,text,uuid)','EXECUTE')
 and not has_function_privilege('service_role','public.release_approval_proof_archive(uuid,uuid,uuid,text,text,uuid)','EXECUTE')
 and has_function_privilege('approval_archive_writer','public.begin_approval_proof_archive(uuid,uuid,uuid,uuid,text,text,text,text,integer,uuid)','EXECUTE')
 and has_function_privilege('approval_archive_writer','public.settle_approval_proof_archive(uuid,uuid,uuid,jsonb,uuid)','EXECUTE')
 and has_function_privilege('approval_archive_writer','public.review_approval_proof_archive(uuid,uuid,uuid,text,text,uuid)','EXECUTE')
 and has_function_privilege('approval_archive_writer','public.release_approval_proof_archive(uuid,uuid,uuid,text,text,uuid)','EXECUTE')
 and not pg_has_role('service_role','approval_archive_writer','MEMBER')
 and exists (select 1 from pg_roles where rolname='approval_archive_writer'
   and not rolcanlogin and not rolinherit and not rolbypassrls),
 'archive mutation RPCs belong only to independent BFF writer role');

insert into auth.users(id,email) values
 ('10000000-0000-4000-8000-000000000001','archive-founder@example.invalid'),
 ('10000000-0000-4000-8000-000000000002','archive-approver@example.invalid');
insert into public.users(id,email,is_axiom_internal) values
 ('10000000-0000-4000-8000-000000000001','archive-founder@example.invalid',true),
 ('10000000-0000-4000-8000-000000000002','archive-approver@example.invalid',false);
insert into public.tenants(id,slug,name) values
 ('10000000-0000-4000-8000-000000000010','approval-archive-test','Approval Archive Test');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000001','founder');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('archive-test',now(),'test','test',0);
insert into public.engagements(id,tenant_id,library_version,title)
 values('10000000-0000-4000-8000-000000000020','10000000-0000-4000-8000-000000000010','archive-test','Archive');
insert into public.remediation_plans(id,tenant_id,engagement_id,library_version,title)
 values('10000000-0000-4000-8000-000000000030','10000000-0000-4000-8000-000000000010',
  '10000000-0000-4000-8000-000000000020','archive-test','Synthetic source');
insert into public.remediation_actions(id,tenant_id,plan_id,sequence,action_type,description,risk_score,
 parameters,rollback_definition,dry_run_status,dry_run_result,rollback_validated)
 values('10000000-0000-4000-8000-000000000040','10000000-0000-4000-8000-000000000010',
  '10000000-0000-4000-8000-000000000030',1,'data.mask','Mask synthetic field',10,
  '{"system":"crm"}'::jsonb,'{"restore":"snapshot"}'::jsonb,
  'dry_run_complete','{"changes":[]}'::jsonb,true);
insert into public.dry_runs(id,tenant_id,action_id,plan_id,status,diff,renderable,
 parameters_hash,rollback_definition_hash,correlation_id,created_at,expires_at)
select '10000000-0000-4000-8000-000000000050',tenant_id,id,plan_id,'succeeded',
 '{"changes":[]}'::jsonb,true,
 encode(sha256(convert_to(parameters::text,'UTF8')),'hex'),
 encode(sha256(convert_to(rollback_definition::text,'UTF8')),'hex'),
 gen_random_uuid(),now()-interval '1 minute',now()+interval '1 hour'
from public.remediation_actions where id='10000000-0000-4000-8000-000000000040';
update public.remediation_actions set latest_dry_run_id='10000000-0000-4000-8000-000000000050'
 where id='10000000-0000-4000-8000-000000000040';
insert into public.approval_tokens(id,tenant_id,plan_id,action_ids,approver_id,mode,
 signature,signed_payload,nonce,expires_at,status,consumed_at)
with expiry as (select now()+interval '1 hour' as at)
select '10000000-0000-4000-8000-000000000060',
 '10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000030',
 array['10000000-0000-4000-8000-000000000040']::uuid[],
 '10000000-0000-4000-8000-000000000002','individual',repeat('a',64),
 jsonb_build_object('planId','10000000-0000-4000-8000-000000000030',
  'actionIds',jsonb_build_array('10000000-0000-4000-8000-000000000040'),
  'approverId','10000000-0000-4000-8000-000000000002','mode','individual',
  'concurrency',1,'stopOnFailure',true,'nonce','archive-test-nonce',
  'expiresAt',to_jsonb(expiry.at),
  'contentDigest',public.action_set_content_digest(
    '10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000030',
    array['10000000-0000-4000-8000-000000000040']::uuid[])),
 'archive-test-nonce',expiry.at,'consumed',now() from expiry;
select public.append_ledger('10000000-0000-4000-8000-000000000010',gen_random_uuid(),
 'human','10000000-0000-4000-8000-000000000002',null,null,null,'approval.token.issued',
 '10000000-0000-4000-8000-000000000030',null,null,'10000000-0000-4000-8000-000000000060',
 '10000000-0000-4000-8000-000000000002',null,null,'success',
 jsonb_build_object('contentDigest',(select signed_payload->>'contentDigest' from public.approval_tokens
  where id='10000000-0000-4000-8000-000000000060')));
insert into public.execution_batches(id,tenant_id,plan_id,request_key,correlation_id,approval_token_id,
 content_digest,mode,concurrency,stop_on_failure,status,finished_at)
select '10000000-0000-4000-8000-000000000070',tenant_id,plan_id,'archive-batch',gen_random_uuid(),id,
 signed_payload->>'contentDigest',mode,concurrency,stop_on_failure,'completed',now()
from public.approval_tokens where id='10000000-0000-4000-8000-000000000060';
update public.remediation_actions set execution_batch_id='10000000-0000-4000-8000-000000000070',
 execution_status='succeeded',final_outcome='succeeded'
 where id='10000000-0000-4000-8000-000000000040';
select public.record_verification_result('10000000-0000-4000-8000-000000000010',
 '10000000-0000-4000-8000-000000000040','10000000-0000-4000-8000-000000000070',
 '[{"check_id":"synthetic","outcome":"passed"}]'::jsonb,'passed',null,gen_random_uuid());

select pg_temp.assert_eq((select public.record_plan_reconciliation(
 '10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000030',
 '10000000-0000-4000-8000-000000000070',gen_random_uuid(),'invented success',repeat('b',64))->>'error'),
 'statement_mismatch','caller prose cannot replace database facts');
select pg_temp.assert_eq((select public.record_plan_reconciliation(
 '10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000030',
 '10000000-0000-4000-8000-000000000070',gen_random_uuid(),
 (public.prepare_plan_reconciliation('10000000-0000-4000-8000-000000000010',
  '10000000-0000-4000-8000-000000000030',
  '10000000-0000-4000-8000-000000000070')->>'statement'),repeat('b',64))->>'error'),
 'reconciliation_signature_unverified','a forged signature cannot consume the batch slot');
select pg_temp.assert_true(not exists(select 1 from public.plan_reconciliations
 where batch_id='10000000-0000-4000-8000-000000000070') and not exists(
 select 1 from public.audit_ledger where action_type='execution.reconciliation.recorded'
 and detail->>'batch_id'='10000000-0000-4000-8000-000000000070'),
 'forgery writes neither reconciliation nor success ledger');
delete from axiom_secrets.reconciliation_keys where scope='global';
select pg_temp.assert_eq((select public.record_plan_reconciliation(
 '10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000030',
 '10000000-0000-4000-8000-000000000070',gen_random_uuid(),
 (public.prepare_plan_reconciliation('10000000-0000-4000-8000-000000000010',
  '10000000-0000-4000-8000-000000000030',
  '10000000-0000-4000-8000-000000000070')->>'statement'),repeat('b',64))->>'error'),
 'reconciliation_signature_unverified','missing protected key fails closed');
insert into axiom_secrets.reconciliation_keys(scope,key_bytes)
values('global',convert_to('test-reconciliation-signing-key-0123456789','UTF8'));
insert into axiom_secrets.reconciliation_keys(scope,key_bytes)
values('tenant:10000000-0000-4000-8000-000000000010',
 convert_to('different-tenant-signing-key-0123456789','UTF8'));
select pg_temp.assert_eq((select public.record_plan_reconciliation(
 '10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000030',
 '10000000-0000-4000-8000-000000000070',gen_random_uuid(),
 (public.prepare_plan_reconciliation('10000000-0000-4000-8000-000000000010',
  '10000000-0000-4000-8000-000000000030',
  '10000000-0000-4000-8000-000000000070')->>'statement'),
 encode(hmac(convert_to((public.prepare_plan_reconciliation(
  '10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000030',
  '10000000-0000-4000-8000-000000000070')->>'statement'),'UTF8'),
  convert_to('test-reconciliation-signing-key-0123456789','UTF8'),'sha256'),'hex'))->>'error'),
 'reconciliation_signature_unverified','tenant override cannot fall back to a global key');
delete from axiom_secrets.reconciliation_keys
 where scope='tenant:10000000-0000-4000-8000-000000000010';
-- Simulate a pre-repair row written through the old 0090 entrypoint. The old
-- ledger event remains append-only, but no archive may treat it as proof.
select public.record_plan_reconciliation_unchecked(
 '10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000030',
 '10000000-0000-4000-8000-000000000070',gen_random_uuid(),
 (public.prepare_plan_reconciliation('10000000-0000-4000-8000-000000000010',
  '10000000-0000-4000-8000-000000000030',
  '10000000-0000-4000-8000-000000000070')->>'statement'),repeat('b',64));
select pg_temp.assert_eq((select public.prepare_approval_proof_source(
 '10000000-0000-4000-8000-000000000010',
 '10000000-0000-4000-8000-000000000060')->>'error'),
 'reconciliation_signature_unverified','historical forged row cannot become archive proof');
delete from public.plan_reconciliations
 where batch_id='10000000-0000-4000-8000-000000000070';
select public.record_plan_reconciliation('10000000-0000-4000-8000-000000000010',
 '10000000-0000-4000-8000-000000000030','10000000-0000-4000-8000-000000000070',
 gen_random_uuid(),(public.prepare_plan_reconciliation(
  '10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000030',
  '10000000-0000-4000-8000-000000000070')->>'statement'),
 encode(hmac(convert_to((public.prepare_plan_reconciliation(
  '10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000030',
  '10000000-0000-4000-8000-000000000070')->>'statement'),'UTF8'),
  convert_to('test-reconciliation-signing-key-0123456789','UTF8'),'sha256'),'hex'));
select pg_temp.assert_true((public.prepare_approval_proof_source(
 '10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000060')->>'sourceSha256')
 ~ '^[0-9a-f]{64}$','complete source is DB-derived and hashable');

select pg_temp.assert_eq((select public.begin_approval_proof_archive(
 '10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000002',
 '10000000-0000-4000-8000-000000000060',gen_random_uuid(),'s3-compatible','archive-fixture',
 'unauthorized',repeat('a',64),10,gen_random_uuid())->>'error'),
 'founder_authority_required','external approver cannot initiate archive');
select public.begin_approval_proof_archive('10000000-0000-4000-8000-000000000010',
 '10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000060',
 '10000000-0000-4000-8000-000000000080','s3-compatible','archive-fixture',
 'tenants/10000000-0000-4000-8000-000000000010/approvals/10000000-0000-4000-8000-000000000060/10000000-0000-4000-8000-000000000080/'||
 (public.prepare_approval_proof_source('10000000-0000-4000-8000-000000000010',
  '10000000-0000-4000-8000-000000000060')->>'sourceSha256'),
 (public.prepare_approval_proof_source('10000000-0000-4000-8000-000000000010',
  '10000000-0000-4000-8000-000000000060')->>'sourceSha256'),
 (public.prepare_approval_proof_source('10000000-0000-4000-8000-000000000010',
  '10000000-0000-4000-8000-000000000060')->>'sourceBytes')::integer,gen_random_uuid());
select pg_temp.assert_true((select status='pending' and source_bytes=octet_length(source_text)
 and source_sha256=encode(sha256(convert_to(source_text,'UTF8')),'hex')
 from public.approval_proof_archives where token_id='10000000-0000-4000-8000-000000000060'),
 'archive intent freezes exact source before provider PUT');
set local role service_role;
do $$ begin
  begin
    perform public.settle_approval_proof_archive(
      '10000000-0000-4000-8000-000000000010',
      '10000000-0000-4000-8000-000000000001',
      (select id from public.approval_proof_archives where token_id='10000000-0000-4000-8000-000000000060'),
      (select jsonb_build_object('provider',provider,'bucket',bucket,'object_key',object_key,
        'version_id','v-forged','content_hash',source_sha256,'byte_size',source_bytes,
        'tenant_id',tenant_id,'collected_by_agent','approval-proof-archive','operation_id',id,
        'retain_until',retain_until+interval '1 day','readback_at',clock_timestamp(),
        'lock_mode','COMPLIANCE','verified',true,'legal_hold',false,'encryption','AES256')
       from public.approval_proof_archives where token_id='10000000-0000-4000-8000-000000000060'),
      gen_random_uuid());
    raise exception 'ASSERTION FAILED: generic service key settled forged receipt';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.assert_true((select count(*)=0 from public.approval_proof_versions),
 'generic service credential could not forge a retained version');
set local role approval_archive_writer;
do $$ begin
  if (public.settle_approval_proof_archive(
    '10000000-0000-4000-8000-000000000010',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000099','{}'::jsonb,gen_random_uuid()
  )->>'error') is distinct from 'archive_not_found' then
    raise exception 'ASSERTION FAILED: dedicated writer RPC unavailable';
  end if;
end $$;
reset role;
select pg_temp.assert_eq((select public.release_approval_proof_archive(
 '10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000001',
 (select id from public.approval_proof_archives where token_id='10000000-0000-4000-8000-000000000060'),
 repeat('a',64),'invented',gen_random_uuid())->>'error'),
 'archive_not_settled','no release before exact provider receipt');
select pg_temp.assert_eq((select public.settle_approval_proof_archive(
 '10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000001',
 (select id from public.approval_proof_archives where token_id='10000000-0000-4000-8000-000000000060'),
 (select jsonb_build_object('provider',provider,'bucket',bucket,'object_key',object_key,
  'version_id','v-invented','content_hash',repeat('f',64),'byte_size',source_bytes,
  'tenant_id',tenant_id,'collected_by_agent','approval-proof-archive','operation_id',id,
  'retain_until',retain_until+interval '1 day','readback_at',clock_timestamp(),
  'lock_mode','COMPLIANCE','verified',true,'legal_hold',false,'encryption','AES256')
  from public.approval_proof_archives where token_id='10000000-0000-4000-8000-000000000060'),
 gen_random_uuid())->>'error'),'receipt_mismatch','wrong provider hash cannot settle');
select public.settle_approval_proof_archive('10000000-0000-4000-8000-000000000010',
 '10000000-0000-4000-8000-000000000001',
 (select id from public.approval_proof_archives where token_id='10000000-0000-4000-8000-000000000060'),
 (select jsonb_build_object('provider',provider,'bucket',bucket,'object_key',object_key,
  'version_id','v-exact-1','content_hash',source_sha256,'byte_size',source_bytes,
  'tenant_id',tenant_id,'collected_by_agent','approval-proof-archive','operation_id',id,
  'retain_until',retain_until+interval '1 day','readback_at',clock_timestamp(),
  'lock_mode','COMPLIANCE','verified',true,'legal_hold',false,'encryption','AES256')
 from public.approval_proof_archives where token_id='10000000-0000-4000-8000-000000000060'),
 gen_random_uuid());
select pg_temp.assert_eq((select public.release_approval_proof_archive(
 '10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000001',
 (select id from public.approval_proof_archives where token_id='10000000-0000-4000-8000-000000000060'),
 (select source_sha256 from public.approval_proof_archives where token_id='10000000-0000-4000-8000-000000000060'),
 'v-invented',gen_random_uuid())->>'error'),'archive_version_mismatch','only settled version can release');
select pg_temp.assert_eq((select public.release_approval_proof_archive(
 '10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000001',
 (select id from public.approval_proof_archives where token_id='10000000-0000-4000-8000-000000000060'),
 (select source_sha256 from public.approval_proof_archives where token_id='10000000-0000-4000-8000-000000000060'),
 'v-exact-1',gen_random_uuid())->>'error'),'founder_review_required',
 'exact settled provider version is not releasable before founder review');
select pg_temp.assert_eq((select public.review_approval_proof_archive(
 '10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000002',
 (select id from public.approval_proof_archives where token_id='10000000-0000-4000-8000-000000000060'),
 (select source_sha256 from public.approval_proof_archives where token_id='10000000-0000-4000-8000-000000000060'),
 'v-exact-1',gen_random_uuid())->>'error'),'founder_authority_required',
 'external approver cannot review client-facing proof');
select pg_temp.assert_eq((select public.review_approval_proof_archive(
 '10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000001',
 (select id from public.approval_proof_archives where token_id='10000000-0000-4000-8000-000000000060'),
 repeat('f',64),'v-exact-1',gen_random_uuid())->>'error'),'archive_version_mismatch',
 'review cannot bind a different source hash');
select pg_temp.assert_eq((select public.review_approval_proof_archive(
 '10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000001',
 (select id from public.approval_proof_archives where token_id='10000000-0000-4000-8000-000000000060'),
 (select source_sha256 from public.approval_proof_archives where token_id='10000000-0000-4000-8000-000000000060'),
 'v-exact-1',gen_random_uuid())->>'replayed'),'false','founder review records exact bytes and version');
select pg_temp.assert_eq((select public.release_approval_proof_archive(
 '10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000001',
 (select id from public.approval_proof_archives where token_id='10000000-0000-4000-8000-000000000060'),
 (select source_sha256 from public.approval_proof_archives where token_id='10000000-0000-4000-8000-000000000060'),
 'v-exact-1',gen_random_uuid())->>'status'),'released','only the exact settled version can release');
select pg_temp.assert_true((select count(*)=4 from public.audit_ledger where action_type in
 ('approval.archive.started','approval.archive.settled','approval.archive.reviewed','approval.archive.released')),
 'every archive transition is audited once');
do $$ begin
 begin
   update public.approval_proof_archives set source_text='rewritten'
   where token_id='10000000-0000-4000-8000-000000000060';
   raise exception 'ASSERTION FAILED: released source was mutable';
 exception when insufficient_privilege then null; end;
 begin
   delete from public.approval_proof_versions where archive_id=(select id
     from public.approval_proof_archives where token_id='10000000-0000-4000-8000-000000000060');
   raise exception 'ASSERTION FAILED: provider receipt was deletable';
 exception when insufficient_privilege then null; end;
end $$;
select pg_temp.assert_true(not has_table_privilege('service_role','public.approval_proof_archives','INSERT')
 and not has_table_privilege('service_role','public.approval_proof_archives','UPDATE')
 and not has_table_privilege('service_role','public.approval_proof_versions','INSERT'),
 'service credential has no direct archive mutation path');
select pg_temp.assert_true(not has_table_privilege('service_role','public.approval_proof_reviews','INSERT')
 and not has_table_privilege('service_role','public.approval_proof_reviews','UPDATE'),
 'founder review is append-only through its authorized RPC');
rollback;
