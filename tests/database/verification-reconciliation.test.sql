-- W5 · M3.7 + W5.6 / migration 0063: verification and the maker-checker
-- statement.
--
-- `record_verification_result` records whether the gap closed, per
-- settled action. `record_plan_reconciliation` computes the comparison
-- itself — approved scope from the token row, out-of-scope execution
-- from the batch, unexecuted actions, and a content digest recomputed at
-- reconcile time — and refuses to store a statement that would claim
-- anything else. What the assertions protect: the reconciler's facts are
-- the database's facts, out-of-scope execution screams, drift is stated,
-- and no browser session can write any of it.

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
create function pg_temp.raises(expected_sqlstate text, statement text, message text) returns void language plpgsql as $$
begin
  execute statement;
  raise exception 'ASSERTION FAILED: % (no raise, expected sqlstate %)', message, expected_sqlstate;
exception when others then
  if sqlstate <> expected_sqlstate then
    raise exception 'ASSERTION FAILED: % (sqlstate %, wanted %)', message, sqlstate, expected_sqlstate;
  end if;
end $$;

-- ─── Fixture ─────────────────────────────────────────────────────────
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a9', 'approver@test.invalid');
insert into public.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a9', 'approver@test.invalid');
insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-0000000000c1', 'vr-a', 'Verify A');
insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-vr', now(), 'test', 'test', 0);
insert into public.engagements(id, tenant_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c1', 'test-vr', 'E');
insert into public.remediation_plans(id, tenant_id, engagement_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-0000000000c2', 'test-vr', 'Verify plan');

insert into public.remediation_actions(id, tenant_id, plan_id, sequence, action_type, description, risk_score, parameters, rollback_definition)
values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 1,
   'data.mask', 'Executed', 10, '{"system": "crm", "fields": ["phone"]}'::jsonb, '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 2,
   'data.mask', 'Swept', 10, '{"system": "crm", "fields": ["email"]}'::jsonb, '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 3,
   'data.mask', 'Out of scope probe', 10, '{"system": "hr", "fields": ["salary"]}'::jsonb, '{}'::jsonb);

insert into public.approval_tokens(id, tenant_id, plan_id, action_ids, approver_id, mode, signature, signed_payload, nonce, expires_at, status)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
        array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
        '00000000-0000-0000-0000-0000000000a9', 'batch', 'sig-1', '{}'::jsonb, 'nonce-vr-1',
        now() + interval '1 hour', 'consumed');

insert into public.execution_batches(id, tenant_id, plan_id, request_key, correlation_id, approval_token_id,
  content_digest, mode, concurrency, stop_on_failure, status, finished_at)
values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000c1',
        '00000000-0000-0000-0000-0000000000c3', 'req-vr-1', gen_random_uuid(),
        '00000000-0000-0000-0000-0000000000e1',
        public.action_set_content_digest('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
          array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[]),
        'batch', 2, true, 'partial_failure', now());

-- d1 executed and settled; d2 was claimed, then swept back to `approved`.
update public.remediation_actions
   set execution_batch_id = '00000000-0000-0000-0000-0000000000f1',
       execution_status = 'succeeded', final_outcome = 'succeeded'
 where id = '00000000-0000-0000-0000-0000000000d1';
update public.remediation_actions
   set execution_batch_id = '00000000-0000-0000-0000-0000000000f1',
       execution_status = 'approved'
 where id = '00000000-0000-0000-0000-0000000000d2';

-- ─── Verification records whether the gap closed ─────────────────────
select pg_temp.assert_eq(
  (select public.record_verification_result(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
     '00000000-0000-0000-0000-0000000000f1',
     '[{"check_id": "state_matches", "outcome": "passed"}]'::jsonb,
     'passed', 'evidence/vr-1', gen_random_uuid())
   -> 'verification' ->> 'outcome'),
  'passed', 'verification is recorded for a settled action');

select pg_temp.assert_true(
  (select verification_status = 'succeeded' and verification_result -> 0 ->> 'check_id' = 'state_matches'
     and latest_verification_result_id is not null
     from public.remediation_actions where id = '00000000-0000-0000-0000-0000000000d1'),
  'the action carries its verification outcome');

select pg_temp.assert_true((select count(*) >= 1 from public.audit_ledger
  where action_type = 'verification.passed' and target_ref = '00000000-0000-0000-0000-0000000000d1'),
  'the verification is in the ledger');

-- An unsettled action has nothing to verify.
select pg_temp.assert_eq(
  (select public.record_verification_result(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2',
     '00000000-0000-0000-0000-0000000000f1',
     '[{"check_id": "state_matches", "outcome": "passed"}]'::jsonb,
     'passed', null, gen_random_uuid())
   ->> 'error'),
  'action_not_settled', 'a swept action is not verifiable');

-- An action outside the batch cannot be verified through it.
select pg_temp.assert_eq(
  (select public.record_verification_result(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d4',
     '00000000-0000-0000-0000-0000000000f1',
     '[{"check_id": "state_matches", "outcome": "passed"}]'::jsonb,
     'passed', null, gen_random_uuid())
   ->> 'error'),
  'action_not_in_batch', 'verification must go through the batch that executed the action');

-- ─── The maker-checker statement: computed, not claimed ──────────────
select pg_temp.assert_eq(
  (select public.record_plan_reconciliation(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
     '00000000-0000-0000-0000-0000000000f1', gen_random_uuid(),
     'Batch req-vr-1 finished partial_failure. Approved 2 action(s): failed=0, rolled_back=0, skipped=0, succeeded=1.',
     repeat('a', 64))
   -> 'reconciliation' ->> 'unexecuted'),
  '1', 'the swept action is stated as unexecuted');

select pg_temp.assert_true(
  (select approved_scope ->> 'nonce' = 'nonce-vr-1'
     and jsonb_array_length(approved_scope -> 'action_ids') = 2
     and executed_reality ->> 'batch_status' = 'partial_failure'
     and parameter_diffs = '[]'::jsonb
     and unexecuted -> 0 ->> 'reason' = 'swept_unexecuted'
   from public.plan_reconciliations where batch_id = '00000000-0000-0000-0000-0000000000f1'),
  'the statement''s facts come from the token row and the settled actions');

select pg_temp.assert_true((select count(*) >= 1 from public.audit_ledger
  where action_type = 'execution.reconciliation.recorded'
    and target_ref = '00000000-0000-0000-0000-0000000000c3'),
  'the reconciliation is in the ledger');

-- One statement per batch.
select pg_temp.raises('23505',
  $q$select public.record_plan_reconciliation(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
     '00000000-0000-0000-0000-0000000000f1', gen_random_uuid(), 'again', repeat('b', 64))$q$,
  'a batch is reconciled once');

-- ─── Out-of-scope execution is computed and screams ──────────────────
insert into public.execution_batches(id, tenant_id, plan_id, request_key, correlation_id, approval_token_id,
  content_digest, mode, concurrency, stop_on_failure, status, finished_at)
values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000c1',
        '00000000-0000-0000-0000-0000000000c3', 'req-vr-2', gen_random_uuid(),
        '00000000-0000-0000-0000-0000000000e1', repeat('c', 64), 'batch', 1, true, 'completed', now());

-- The defect: d4 was touched by the batch but the token never covered it.
update public.remediation_actions
   set execution_batch_id = '00000000-0000-0000-0000-0000000000f2',
       execution_status = 'succeeded', final_outcome = 'succeeded'
 where id = '00000000-0000-0000-0000-0000000000d4';

select pg_temp.assert_eq(
  (select public.record_plan_reconciliation(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
     '00000000-0000-0000-0000-0000000000f2', gen_random_uuid(),
     'A statement that would hide the defect.', repeat('a', 64))
   ->> 'error'),
  'out_of_scope_executed', 'the record is refused and names the defect');

-- The content drift is stated, not hidden: change d1's parameters after
-- the finished batch and reconcile a second batch over it.
update public.remediation_actions set parameters = '{"system": "crm", "fields": ["phone", "mobile"]}'::jsonb
  where id = '00000000-0000-0000-0000-0000000000d1';
delete from public.plan_reconciliations where batch_id = '00000000-0000-0000-0000-0000000000f1';

select pg_temp.assert_eq(
  (select public.record_plan_reconciliation(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
     '00000000-0000-0000-0000-0000000000f1', gen_random_uuid(),
     'Batch req-vr-1 finished partial_failure. Content changed under a finished batch.',
     repeat('a', 64)) -> 'reconciliation' ->> 'content_digest_drift'),
  'true', 'content changed under a finished batch is stated as drift');

-- ─── Gate refusals ────────────────────────────────────────────────────
select pg_temp.assert_eq(
  (select public.record_plan_reconciliation(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
     gen_random_uuid(), gen_random_uuid(), 'no batch', repeat('a', 64))
   ->> 'error'),
  'batch_not_found', 'a statement names a real batch');

select pg_temp.assert_eq(
  (select public.record_plan_reconciliation(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
     '00000000-0000-0000-0000-0000000000f1', gen_random_uuid(), 's', 'not-a-signature')
   ->> 'error'),
  'invalid_record', 'an unsigned statement is refused');

-- ─── Nobody writes these except the SECURITY DEFINER paths ───────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}';
select pg_temp.denied($q$select public.record_verification_result(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
  '00000000-0000-0000-0000-0000000000f1', '[]'::jsonb, 'passed', null, gen_random_uuid())$q$);
select pg_temp.denied($q$select public.record_plan_reconciliation(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
  '00000000-0000-0000-0000-0000000000f1', gen_random_uuid(), 'forged', repeat('a', 64))$q$);
select pg_temp.denied($q$update public.verification_results set outcome = 'passed'$q$);
select pg_temp.denied($q$update public.plan_reconciliations set statement = 'forged'$q$);
reset role;

set local role service_role;
select pg_temp.assert_true((select count(*) >= 1 from public.verification_results), 'the BFF service reads verifications');
select pg_temp.denied($q$insert into public.verification_results(tenant_id, action_id, batch_id, checks, outcome, correlation_id)
  values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
          '00000000-0000-0000-0000-0000000000f1', '[]'::jsonb, 'passed', gen_random_uuid())$q$);
select pg_temp.denied($q$update public.plan_reconciliations set statement_signature = repeat('f', 64)$q$);
select pg_temp.denied($q$delete from public.verification_results$q$);
reset role;

rollback;
