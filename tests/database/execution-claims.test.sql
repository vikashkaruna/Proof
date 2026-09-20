-- W5 / R-04: claiming a multi-action batch, atomically, exactly once.
--
-- Before migration 0019 the first assertion here was impossible: the execute
-- route wrote one request key onto every accepted action, and the column
-- carried a GLOBAL unique constraint, so the second action of any batch raised
-- a duplicate key error. The approval token had already been consumed by then,
-- so the plan was left approved, un-executable, and needing a fresh approval.
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

insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a9', 'approver@test.invalid');
insert into public.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a9', 'approver@test.invalid');
insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-0000000000c1', 'exec-a', 'Exec A'),
  ('00000000-0000-0000-0000-0000000000c9', 'exec-b', 'Exec B');
insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-exec', now(), 'test', 'test', 0);
insert into public.engagements(id, tenant_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c1', 'test-exec', 'E');
insert into public.remediation_plans(id, tenant_id, engagement_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-0000000000c2', 'test-exec', 'Batch plan');

insert into public.remediation_actions(id, tenant_id, plan_id, sequence, action_type, description, risk_score, rollback_definition)
values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 1, 'data.mask', 'A', 10, '{}'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 2, 'data.mask', 'B', 10, '{}'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 3, 'data.mask', 'C', 10, '{}');

insert into public.approval_tokens(id, tenant_id, plan_id, action_ids, approver_id, mode, signature, signed_payload, nonce, expires_at, status)
values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
   array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
   '00000000-0000-0000-0000-0000000000a9', 'batch', 'sig-1', '{}'::jsonb, 'nonce-1', now() + interval '1 hour', 'issued'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
   array['00000000-0000-0000-0000-0000000000d3']::uuid[],
   '00000000-0000-0000-0000-0000000000a9', 'batch', 'sig-2', '{}'::jsonb, 'nonce-2', now() + interval '1 hour', 'issued');

update public.remediation_actions set approval_status = 'approved', dry_run_status = 'dry_run_complete', rollback_validated = true, dry_run_expires_at = now() + interval '1 hour';


-- ─── The case that could not happen before ───────────────────────────
select pg_temp.assert_eq(
  (select public.claim_plan_execution(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
     '00000000-0000-0000-0000-0000000000e1',
     array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
     'req-batch-001')->>'decision'),
  'claimed', 'a two-action batch can be claimed');

select pg_temp.assert_true(
  (select count(*) = 2 from public.remediation_actions
    where execution_request_key = 'req-batch-001' and execution_status = 'executing'
      and dispatch_status = 'pending'), 'both actions claimed and pending dispatch');

-- Per-action execution identity is distinct even though the request is shared.
select pg_temp.assert_true(
  (select count(distinct idempotency_key) = 2 from public.remediation_actions
    where execution_request_key = 'req-batch-001'), 'per-action keys are distinct');

select pg_temp.assert_eq(
  (select status::text from public.approval_tokens where id = '00000000-0000-0000-0000-0000000000e1'),
  'consumed', 'the token was consumed in the same transaction');

-- ─── Replay ──────────────────────────────────────────────────────────
-- The same key retried must succeed against the now-consumed token, because
-- consuming it is precisely what the first attempt did.
select pg_temp.assert_eq(
  (select public.claim_plan_execution(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
     '00000000-0000-0000-0000-0000000000e1',
     array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
     'req-batch-001')->>'decision'),
  'already_claimed', 'a retry under the same key replays rather than re-executing');

-- ─── A second request must not steal in-flight work ──────────────────
select pg_temp.assert_eq(
  (select public.claim_plan_execution(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
     '00000000-0000-0000-0000-0000000000e2',
     array['00000000-0000-0000-0000-0000000000d1']::uuid[],
     'req-batch-002')->>'decision'),
  'already_executing', 'a different request cannot claim an executing action');

select pg_temp.assert_eq(
  (select status::text from public.approval_tokens where id = '00000000-0000-0000-0000-0000000000e2'),
  'issued', 'a refused claim does not spend the second token');

-- ─── A consumed token claims nothing ─────────────────────────────────
update public.approval_tokens set status = 'consumed' where id = '00000000-0000-0000-0000-0000000000e2';
select pg_temp.assert_eq(
  (select public.claim_plan_execution(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
     '00000000-0000-0000-0000-0000000000e2',
     array['00000000-0000-0000-0000-0000000000d3']::uuid[],
     'req-batch-003')->>'decision'),
  'token_already_used', 'an already-consumed token claims nothing');
select pg_temp.assert_true(
  (select execution_request_key is null from public.remediation_actions
    where id = '00000000-0000-0000-0000-0000000000d3'),
  'the refused action was left unclaimed');

-- ─── Cross-tenant and cross-plan action ids ──────────────────────────
select pg_temp.assert_eq(
  (select public.claim_plan_execution(
     '00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000c3',
     '00000000-0000-0000-0000-0000000000e2',
     array['00000000-0000-0000-0000-0000000000d3']::uuid[],
     'req-batch-004')->>'decision'),
  'actions_not_found', 'another tenant cannot claim these actions');

select pg_temp.assert_eq(
  (select public.claim_plan_execution(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
     '00000000-0000-0000-0000-0000000000e1',
     array['00000000-0000-0000-0000-0000000000d1']::uuid[],
     '')->>'decision'),
  'missing_request_key', 'an empty request key claims nothing');

-- ─── Dispatch outcome is durable ─────────────────────────────────────
-- `finish_execution_dispatch` settles the actions AND the outbox intent in one
-- transaction, under the plan lock. 0019's `record_execution_dispatch` and
-- 0020's `settle_execution_dispatch` settled them separately; 0022 drops both,
-- because the assertions that used to stand here pinned the semantics 0021
-- corrected — that any 'failed' status may release a claim.

-- An EXPLICIT refusal is a definite negative, so it releases the claim. It is
-- the only outcome that may; `unknown` is tested below and must not.
select pg_temp.assert_true(
  public.finish_execution_dispatch(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    'req-batch-001', 'failed', null, 'runtime returned 422'),
  'a refused dispatch settles');

-- R-05: work the runtime refused must not read as running, and must stay
-- retryable rather than stranded in 'executing' with nothing behind it.
select pg_temp.assert_true(
  (select count(*) = 2 from public.remediation_actions
    where plan_id = '00000000-0000-0000-0000-0000000000c3'
      and dispatch_status = 'failed' and execution_status = 'approved'
      and execution_request_key is null),
  'a refused dispatch returns the actions to approved and clears the claim');

-- The intent is retained with its reason by the SAME call. It is the evidence
-- that a token was spent on work that did not run, and deleting it would erase
-- exactly what reconciliation needs.
select pg_temp.assert_true(
  (select status = 'failed' and last_error = 'runtime returned 422'
     from public.execution_dispatch_outbox where request_key = 'req-batch-001'),
  'the refused intent is retained with its reason');
select pg_temp.assert_true(
  (select count(*) = 1 from public.pending_execution_dispatches
    where request_key = 'req-batch-001' and status = 'failed'),
  'a refused intent stays visible until an operator reconciles it');

-- Retryable means retryable: a fresh key can claim them again.
update public.approval_tokens set status = 'issued' where id = '00000000-0000-0000-0000-0000000000e1';
select pg_temp.assert_eq(
  (select public.claim_plan_execution(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
     '00000000-0000-0000-0000-0000000000e1',
     array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
     'req-batch-retry',
     '55555555-5555-4555-8555-555555555555'::uuid,
     jsonb_build_object(
       'contract_version', 1,
       'plan_id', '00000000-0000-0000-0000-0000000000c3',
       'action_ids', jsonb_build_array('00000000-0000-0000-0000-0000000000d1')))->>'decision'),
  'claimed', 'actions released by a refused dispatch can be claimed again');

-- ─── W5 · the durable outbox ─────────────────────────────────────────
-- The intent is written in the SAME transaction as the token consumption, so
-- a process that dies between claiming and dispatching leaves a record of what
-- it owed rather than actions in `executing` with nothing behind them.
select pg_temp.assert_true(
  (select count(*) = 1 from public.execution_dispatch_outbox
    where request_key = 'req-batch-retry' and status = 'pending'),
  'claiming writes a pending outbox intent');

select pg_temp.assert_true(
  (select payload->>'plan_id' = '00000000-0000-0000-0000-0000000000c3'
     from public.execution_dispatch_outbox where request_key = 'req-batch-retry'),
  'the outbox carries what the runtime was promised');

-- The operator's reconciliation query.
select pg_temp.assert_true(
  (select count(*) >= 1 from public.pending_execution_dispatches),
  'a promised-but-unconfirmed dispatch is visible to an operator');

select pg_temp.assert_true(
  public.finish_execution_dispatch(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    'req-batch-retry', 'accepted', 'workflow-abc', null),
  'an accepted dispatch settles the intent and records the runtime reference');
select pg_temp.assert_true(
  (select count(*) = 2 from public.remediation_actions
    where dispatch_reference = 'workflow-abc' and execution_status = 'executing'),
  'accepted work stays executing with a durable reference');
select pg_temp.assert_true(
  (select count(*) = 0 from public.pending_execution_dispatches
    where request_key = 'req-batch-retry'),
  'a delivered intent leaves the reconciliation queue');

-- 0022: the superseded RPCs are gone, not merely unused. A dead grant on a
-- security-definer function that can release a running claim is still a way in.
select pg_temp.assert_true(
  (select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('record_execution_dispatch', 'settle_execution_dispatch')),
  'the superseded dispatch RPCs are dropped, so the corrected path is the only path');

-- Redelivery is idempotent: one intent per request, whatever happens.
select pg_temp.assert_eq(
  (select public.claim_plan_execution(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
     '00000000-0000-0000-0000-0000000000e1',
     array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
     'req-batch-retry')->>'decision'),
  'already_claimed', 'a replay does not write a second intent');
select pg_temp.assert_true(
  (select count(*) = 1 from public.execution_dispatch_outbox
    where request_key = 'req-batch-retry'),
  'exactly one outbox row per request');

-- ─── The schema now catches the original regression ──────────────────
-- Writing a bare request key across a batch is exactly what broke before.
-- The retained unique constraint makes it fail at the database rather than
-- shipping a plan that cannot be executed.
do $$
begin
  update public.remediation_actions set idempotency_key = 'bare-shared-key'
   where plan_id = '00000000-0000-0000-0000-0000000000c3'
     and id in ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2');
  raise exception 'ASSERTION FAILED: a bare shared key was accepted across a batch';
exception when unique_violation then null;
end $$;

-- An uncertain delivery never releases an action for another token.
update public.execution_dispatch_outbox set status = 'pending' where request_key = 'req-batch-retry';
select pg_temp.assert_true(public.finish_execution_dispatch(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
  'req-batch-retry', 'unknown', null, 'acknowledgement lost'), 'record unknown outcome');
select pg_temp.assert_true((select count(*) = 2 from public.remediation_actions
  where execution_request_key = 'req-batch-retry' and execution_status = 'executing'
  and dispatch_status = 'unknown'), 'unknown delivery remains claimed');
select pg_temp.assert_true((select count(*) = 1 from public.pending_execution_dispatches
  where request_key = 'req-batch-retry' and status = 'unknown'), 'unknown outcome visible for reconciliation');
select pg_temp.assert_true(public.finish_execution_dispatch(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
  'req-batch-retry', 'accepted', 'durable-confirmation', null), 'late acceptance settles unknown');
select pg_temp.assert_true(not public.finish_execution_dispatch(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
  'req-batch-retry', 'failed', null, 'late timeout'), 'late failure cannot downgrade acceptance');
select pg_temp.assert_true((select count(*) = 2 from public.remediation_actions
  where execution_request_key = 'req-batch-retry' and dispatch_status = 'accepted'),
  'late failure does not release accepted work');

-- Invalid shapes and expired authority cannot spend a token.
select pg_temp.assert_eq(public.claim_plan_execution(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
  '00000000-0000-0000-0000-0000000000e2', '{}'::uuid[], 'empty')->>'decision',
  'invalid_actions', 'empty batches refused');
update public.approval_tokens set status = 'issued', expires_at = now() - interval '1 hour'
  where id = '00000000-0000-0000-0000-0000000000e2';
select pg_temp.assert_eq(public.claim_plan_execution(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
  '00000000-0000-0000-0000-0000000000e2',
  array['00000000-0000-0000-0000-0000000000d3']::uuid[], 'expired')->>'decision',
  'token_already_used', 'token expiry rechecked in transaction');
select pg_temp.assert_eq((select status::text from public.approval_tokens
  where id = '00000000-0000-0000-0000-0000000000e2'), 'issued', 'refusal leaves token untouched');

-- ─── Browser clients cannot claim executions ─────────────────────────
set local role authenticated;
select pg_temp.denied($q$select public.claim_plan_execution('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-0000000000e1',array['00000000-0000-0000-0000-0000000000d1']::uuid[],'x')$q$);
select pg_temp.denied($q$select * from public.execution_dispatch_outbox$q$);
select pg_temp.denied($q$select public.finish_execution_dispatch('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c3','x','accepted',null,null)$q$);
reset role;

rollback;
