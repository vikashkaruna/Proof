-- ─────────────────────────────────────────────────────────────────────
-- samadhan-pramaan-closure.test.sql
--
-- Test suite for Migration 0080:
-- 1. Samadhan agent attribution on plan_reconciliations and ledger
-- 2. Historical dossier metadata visibility and unavailable seal RPC
-- 3. Unavailable external email-dispatch write path
-- ─────────────────────────────────────────────────────────────────────

begin;

create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
create function pg_temp.assert_eq(actual text, expected text, message text) returns void language plpgsql as $$
begin if actual is distinct from expected then
  raise exception 'ASSERTION FAILED: % (expected %, got %)', message, expected, actual; end if; end $$;
create function pg_temp.denied(statement text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when insufficient_privilege then return; end;
  raise exception 'Statement was not denied: %', statement;
end $$;

-- ─── Fixtures ────────────────────────────────────────────────────────
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000f1', 'founder@test.invalid'),
  ('00000000-0000-0000-0000-0000000000c1', 'client@test.invalid');

insert into public.users(id, email, is_axiom_internal) values
  ('00000000-0000-0000-0000-0000000000f1', 'founder@test.invalid', true),
  ('00000000-0000-0000-0000-0000000000c1', 'client@test.invalid', false);

insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-000000000011', 'tenant-closure', 'Closure Tenant');

insert into public.tenant_users(tenant_id, user_id, role) values
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-0000000000f1', 'founder'),
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-0000000000c1', 'viewer');

insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-closure', now(), 'test', 'test', 0);

insert into public.engagements(id, tenant_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000011', 'test-closure', 'Closure Engagement');

insert into public.remediation_plans(id, tenant_id, engagement_id, library_version, title)
  values ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000011',
          '00000000-0000-0000-0000-0000000000e1', 'test-closure', 'Closure Plan');

insert into public.remediation_actions(id, tenant_id, plan_id, sequence, action_type, description, risk_score, parameters, rollback_definition)
values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021', 1,
   'data.mask', 'Mask phone', 10, '{"system": "crm"}'::jsonb, '{}'::jsonb);

insert into public.approval_tokens(id, tenant_id, plan_id, action_ids, approver_id, mode, signature, signed_payload, nonce, expires_at, status)
values ('00000000-0000-0000-0000-000000000031', '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021',
        array['00000000-0000-0000-0000-0000000000a1']::uuid[],
        '00000000-0000-0000-0000-0000000000c1', 'batch', 'sig-closure', '{}'::jsonb, 'nonce-c1',
        now() + interval '1 hour', 'consumed');

insert into public.execution_batches(id, tenant_id, plan_id, request_key, correlation_id, approval_token_id,
  content_digest, mode, concurrency, stop_on_failure, status, finished_at)
values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000011',
        '00000000-0000-0000-0000-000000000021', 'req-closure-1', gen_random_uuid(),
        '00000000-0000-0000-0000-000000000031',
        public.action_set_content_digest('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021',
          array['00000000-0000-0000-0000-0000000000a1']::uuid[]),
        'batch', 1, true, 'completed', now());

update public.remediation_actions
   set execution_batch_id = '00000000-0000-0000-0000-0000000000b1',
       execution_status = 'succeeded', final_outcome = 'succeeded'
 where id = '00000000-0000-0000-0000-0000000000a1';

-- ─── Test 1: Samadhan Reconciliation Attribution ─────────────────────
select public.record_plan_reconciliation(
  '00000000-0000-0000-0000-000000000011',
  '00000000-0000-0000-0000-000000000021',
  '00000000-0000-0000-0000-0000000000b1',
  gen_random_uuid(),
  'Batch req-closure-1 finished completed. Approved 1 action(s): succeeded=1.',
  repeat('1', 64)
);

select pg_temp.assert_true(
  (select reconciled_by_agent = 'samadhan'
     from public.plan_reconciliations
    where batch_id = '00000000-0000-0000-0000-0000000000b1'),
  'plan_reconciliations explicitly records reconciled_by_agent = samadhan'
);

select pg_temp.assert_true(
  (select count(*) = 1
     from public.audit_ledger
    where action_type = 'execution.reconciliation.recorded'
      and actor_type = 'agent'
      and actor_id = 'samadhan'),
  'ledger records actor_id = samadhan for reconciliation'
);

-- ─── Test 2: Pramaan Dossiers & Sealing ──────────────────────────────
insert into public.pramaan_dossiers (
  id, tenant_id, engagement_id, dossier_type, title, status,
  merkle_root, manifest_hash, archive_hash, archive_bytes, proof_seal_hash
) values (
  '00000000-0000-0000-0000-0000000000d1',
  '00000000-0000-0000-0000-000000000011',
  '00000000-0000-0000-0000-0000000000e1',
  'full_closure',
  'Final Statutory DPDPA Closure Dossier',
  'draft',
  repeat('a', 64),
  repeat('b', 64),
  repeat('c', 64),
  1048576,
  repeat('e', 64)
);

select pg_temp.assert_true(
  not has_function_privilege('service_role',
    'public.seal_pramaan_dossier(uuid,uuid,uuid,text,uuid)', 'EXECUTE')
  and not has_table_privilege('service_role', 'public.pramaan_dossiers', 'INSERT')
  and not has_table_privilege('service_role', 'public.pramaan_dossiers', 'UPDATE'),
  'service role cannot seal or create source-free dossiers'
);

-- ─── Test 3: Report Email Dispatch & Direct Read Privacy ────────────
insert into public.report_email_dispatches(
  tenant_id, dossier_id, recipient_email, subject, delivery_status, dispatched_by
) values (
  '00000000-0000-0000-0000-000000000011',
  '00000000-0000-0000-0000-0000000000d1',
  'historical@example.invalid', 'Historical dispatch', 'sent',
  '00000000-0000-0000-0000-0000000000f1'
);

select pg_temp.assert_true(
  not has_function_privilege('service_role',
    'public.record_report_email_dispatch(uuid,uuid,uuid,text,text,text,uuid,uuid)', 'EXECUTE')
  and not has_table_privilege('service_role', 'public.report_email_dispatches', 'INSERT')
  and not has_table_privilege('service_role', 'public.report_email_dispatches', 'UPDATE'),
  'service role cannot fabricate or record external dispatch'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
select pg_temp.assert_true((select count(*)=0 from public.pramaan_dossiers),
  'viewer cannot read unverified dossier metadata');
select pg_temp.assert_true((select count(*)=0 from public.report_email_dispatches),
  'viewer cannot read historical dispatch recipient');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated"}', true);
select pg_temp.assert_true((select count(*)=1 from public.pramaan_dossiers),
  'internal founder can inspect historical dossier metadata');
select pg_temp.assert_true((select count(*)=1 from public.report_email_dispatches),
  'internal founder can inspect historical dispatch metadata');
reset role;

rollback;
