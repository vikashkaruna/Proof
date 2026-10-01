-- Isolated concurrency fixture: a completed batch with no reconciliation yet.
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


commit;
