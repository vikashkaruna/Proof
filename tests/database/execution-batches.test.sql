-- W5 · M3.4 / migration 0061: the executor's write paths.
--
-- These functions are the ONLY way a dispatch intent becomes recorded
-- execution. What the assertions protect: the executed actions are a
-- subset of the approved token's action_ids; the content digest is
-- recomputed over the stored rows and matched against the token's signed
-- snapshot; a redelivery under the same request key replays instead of
-- re-executing; unsettled actions sweep back to `approved` (retryable
-- only under a fresh approval); and no browser session can call any of
-- it.

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

-- ─── Fixture (mirrors tests/database/execution-fixture.sql) ──────────
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a9', 'approver@test.invalid');
insert into public.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a9', 'approver@test.invalid');
insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-0000000000c1', 'exec-a', 'Exec A'),
  ('00000000-0000-0000-0000-0000000000c9', 'exec-b', 'Exec B');
insert into public.tenant_users(tenant_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a9', 'owner');
insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-exec', now(), 'test', 'test', 0);
insert into public.engagements(id, tenant_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c1', 'test-exec', 'E');
insert into public.remediation_plans(id, tenant_id, engagement_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-0000000000c2', 'test-exec', 'Batch plan');

insert into public.remediation_actions(id, tenant_id, plan_id, sequence, action_type, description, risk_score, parameters, rollback_definition)
values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 1, 'data.mask', 'A', 10, '{"system": "crm", "fields": ["phone"]}'::jsonb, '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 2, 'data.mask', 'B', 10, '{"system": "crm", "fields": ["email"]}'::jsonb, '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 3, 'data.mask', 'C', 10, '{"system": "hr", "fields": ["salary"]}'::jsonb, '{}'::jsonb);

insert into public.approval_tokens(id, tenant_id, plan_id, action_ids, approver_id, mode, signature, signed_payload, nonce, expires_at, status)
values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
   array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
   '00000000-0000-0000-0000-0000000000a9', 'batch', 'sig-1', '{}'::jsonb, 'nonce-exec-1',
   now() + interval '1 hour', 'consumed'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
   array['00000000-0000-0000-0000-0000000000d3']::uuid[],
   '00000000-0000-0000-0000-0000000000a9', 'batch', 'sig-2', '{}'::jsonb, 'nonce-exec-2',
   now() + interval '1 hour', 'issued');

-- Every token carries the snapshot of what it approves (0026/0027); the
-- executor's start call recomputes and matches against exactly this.
update public.approval_tokens t
   set signed_payload = coalesce(t.signed_payload, '{}'::jsonb)
     || jsonb_build_object('contentDigest',
          public.action_set_content_digest(t.tenant_id, t.plan_id, t.action_ids));

-- The claim (0021) put the approved actions in `executing` under a
-- request key; mirror that state here.
update public.remediation_actions
   set approval_status = 'approved', dry_run_status = 'dry_run_complete', rollback_validated = true,
       dry_run_expires_at = now() + interval '1 hour',
       execution_status = 'executing', execution_request_key = 'req-exec-1',
       dispatch_status = 'pending'
 where id in ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2');

-- ─── Starting the batch: scope, digest, idempotency ──────────────────
select pg_temp.assert_eq(
  (select public.start_execution_batch(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 'req-exec-1',
     gen_random_uuid(), 'nonce-exec-1',
     (select signed_payload->>'contentDigest' from public.approval_tokens where id = '00000000-0000-0000-0000-0000000000e1'),
     'batch', 2, true, 'req-exec-1',
     array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[])
   ->>'replay'),
  'false', 'a fresh dispatch starts a batch');

select pg_temp.assert_true(
  (select execution_batch_id is not null from public.remediation_actions
    where id = '00000000-0000-0000-0000-0000000000d1'),
  'claimed actions link to the batch');

select pg_temp.assert_eq(
  (select status::text from public.remediation_plans where id = '00000000-0000-0000-0000-0000000000c3'),
  'executing', 'the plan shows execution in progress');

select pg_temp.assert_true((select count(*) >= 1 from public.audit_ledger
  where action_type = 'execution.started' and target_ref = '00000000-0000-0000-0000-0000000000c3'),
  'the batch start is in the ledger');

-- Idempotent redelivery: same key, same digest replays.
select pg_temp.assert_eq(
  (select public.start_execution_batch(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 'req-exec-1',
     gen_random_uuid(), 'nonce-exec-1',
     (select signed_payload->>'contentDigest' from public.approval_tokens where id = '00000000-0000-0000-0000-0000000000e1'),
     'batch', 2, true, 'req-exec-1',
     array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[])
   ->>'replay'),
  'true', 'a redelivery under the same key replays');

-- Scope: an action outside the token's action_ids is refused.
select pg_temp.assert_eq(
  (select public.start_execution_batch(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 'req-exec-9',
     gen_random_uuid(), 'nonce-exec-1',
     (select signed_payload->>'contentDigest' from public.approval_tokens where id = '00000000-0000-0000-0000-0000000000e1'),
     'batch', 1, true, 'req-exec-9',
     array['00000000-0000-0000-0000-0000000000d3']::uuid[])
   ->>'error'),
  'scope_exceeded', 'the executor cannot execute beyond the approved scope');

-- Content: a digest that is not the recomputed one is refused.
select pg_temp.assert_eq(
  (select public.start_execution_batch(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 'req-exec-8',
     gen_random_uuid(), 'nonce-exec-1', repeat('0', 64), 'batch', 1, true, 'req-exec-8',
     array['00000000-0000-0000-0000-0000000000d1']::uuid[])
   ->>'error'),
  'digest_mismatch', 'a stale digest cannot start a batch');

-- Unknown nonce resolves to nothing.
select pg_temp.assert_eq(
  (select public.start_execution_batch(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 'req-exec-7',
     gen_random_uuid(), 'nonce-unknown',
     (select signed_payload->>'contentDigest' from public.approval_tokens where id = '00000000-0000-0000-0000-0000000000e1'),
     'batch', 1, true, 'req-exec-7',
     array['00000000-0000-0000-0000-0000000000d1']::uuid[])
   ->>'error'),
  'token_not_found', 'a token that does not exist starts nothing');

-- ─── Per-action settle: only the batch's own running actions ─────────
select * into pg_temp.b from public.execution_batches where request_key = 'req-exec-1';

select pg_temp.assert_eq(
  (select public.mark_execution_action_started(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
     (select id from public.execution_batches where request_key = 'req-exec-1'), gen_random_uuid())
   ->>'ok'),
  'true', 'a running action of the batch can be marked started');

select pg_temp.assert_eq(
  (select public.settle_execution_action(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
     (select id from public.execution_batches where request_key = 'req-exec-1'),
     'succeeded', null, 'sha256:aaa', 'sha256:bbb', '{"rows_affected": 5}'::jsonb, gen_random_uuid())
   ->>'ok'),
  'true', 'a succeeded action settles');

select pg_temp.assert_true(
  (select final_outcome = 'succeeded' and pre_state_uri = 'sha256:aaa' and post_state_uri = 'sha256:bbb'
     from public.remediation_actions where id = '00000000-0000-0000-0000-0000000000d1'),
  'the outcome and the state references are recorded on the action');

select pg_temp.assert_true((select count(*) >= 1 from public.audit_ledger
  where action_type = 'execution.action.started' and target_ref = '00000000-0000-0000-0000-0000000000d1'),
  'the action start is in the ledger');
select pg_temp.assert_true((select count(*) >= 1 from public.audit_ledger
  where action_type = 'execution.action.succeeded' and target_ref = '00000000-0000-0000-0000-0000000000d1'),
  'the action outcome is in the ledger');

-- A settled action cannot settle again.
select pg_temp.assert_eq(
  (select public.settle_execution_action(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
     (select id from public.execution_batches where request_key = 'req-exec-1'),
     'failed', 'late_error', null, null, null, gen_random_uuid())
   ->>'error'),
  'action_not_running', 'a settled action is closed to further writes');

-- An action that belongs to a different batch (or none) is refused.
select pg_temp.assert_eq(
  (select public.settle_execution_action(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d3',
     (select id from public.execution_batches where request_key = 'req-exec-1'),
     'succeeded', null, null, null, null, gen_random_uuid())
   ->>'error'),
  'action_not_running', 'an action the batch does not hold cannot be settled');

-- Invalid references are refused at the gate.
select pg_temp.assert_eq(
  (select public.settle_execution_action(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2',
     (select id from public.execution_batches where request_key = 'req-exec-1'),
     'succeeded', null, 'not a valid ref; drop table', null, null, gen_random_uuid())
   ->>'error'),
  'invalid_record', 'an unbounded state reference is refused');

-- ─── Finishing: terminal status, plan status, the sweep ──────────────
select pg_temp.assert_eq(
  (select public.finish_execution_batch(
     '00000000-0000-0000-0000-0000000000c1', (select id from public.execution_batches where request_key = 'req-exec-1'),
     'partial_failure', gen_random_uuid())
   ->>'replay'),
  'false', 'the batch finishes once');

select pg_temp.assert_true(
  (select execution_status = 'approved' and final_outcome is null
     from public.remediation_actions where id = '00000000-0000-0000-0000-0000000000d2'),
  'the unsettled action swept back to approved');

select pg_temp.assert_eq(
  (select status::text from public.remediation_plans where id = '00000000-0000-0000-0000-0000000000c3'),
  'partial_failure', 'the plan records the partial failure');

select pg_temp.assert_true((select count(*) >= 1 from public.audit_ledger
  where action_type = 'execution.batch.completed' and target_ref = '00000000-0000-0000-0000-0000000000c3'),
  'the batch completion is in the ledger');

-- A second finish replays; the first terminal status stands.
select pg_temp.assert_eq(
  (select public.finish_execution_batch(
     '00000000-0000-0000-0000-0000000000c1', (select id from public.execution_batches where request_key = 'req-exec-1'),
     'completed', gen_random_uuid())
   ->'batch'->>'status'),
  'partial_failure', 'the first terminal status is immutable');

select pg_temp.assert_eq(
  (select public.finish_execution_batch(
     '00000000-0000-0000-0000-0000000000c1', (select id from public.execution_batches where request_key = 'req-exec-1'),
     'exploded', gen_random_uuid())
   ->>'error'),
  'invalid_status', 'an invented terminal status is refused');

-- ─── Nobody writes execution except the SECURITY DEFINER paths ───────
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}';
select pg_temp.denied($q$select public.start_execution_batch(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 'req-x',
  gen_random_uuid(), 'nonce-exec-1', repeat('0', 64), 'batch', 1, true, 'req-x',
  array['00000000-0000-0000-0000-0000000000d1']::uuid[])$q$);
select pg_temp.denied($q$select public.settle_execution_action(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
  gen_random_uuid(), 'succeeded', null, null, null, null, gen_random_uuid())$q$);
select pg_temp.denied($q$select public.finish_execution_batch(
  '00000000-0000-0000-0000-0000000000c1', gen_random_uuid(), 'completed', gen_random_uuid())$q$);
select pg_temp.denied($q$update public.execution_batches set status = 'completed'$q$);
reset role;

set local role service_role;
select pg_temp.assert_true((select count(*) >= 1 from public.execution_batches), 'the BFF service reads batches');
select pg_temp.denied($q$insert into public.execution_batches(tenant_id, plan_id, request_key, correlation_id,
  approval_token_id, content_digest, mode, concurrency, stop_on_failure)
  values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 'req-y',
          gen_random_uuid(), '00000000-0000-0000-0000-0000000000e1', repeat('0', 64), 'batch', 1, true)$q$);
select pg_temp.denied($q$update public.execution_batches set status = 'completed'$q$);
select pg_temp.denied($q$delete from public.execution_batches$q$);
reset role;

rollback;
