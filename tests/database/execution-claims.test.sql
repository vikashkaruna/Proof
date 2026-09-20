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
select pg_temp.assert_true(
  public.record_execution_dispatch(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    'req-batch-001', 'failed', null, 'runtime returned 422') = 2,
  'a failed dispatch is recorded against every action in the batch');

-- R-05: work the runtime never accepted must not read as running, and must
-- stay retryable rather than stranded in 'executing' with nothing behind it.
select pg_temp.assert_true(
  (select count(*) = 2 from public.remediation_actions
    where plan_id = '00000000-0000-0000-0000-0000000000c3'
      and dispatch_status = 'failed' and execution_status = 'approved'
      and execution_request_key is null),
  'a failed dispatch returns the actions to approved and clears the claim');

-- Retryable means retryable: a fresh key can claim them again.
update public.approval_tokens set status = 'issued' where id = '00000000-0000-0000-0000-0000000000e1';
select pg_temp.assert_eq(
  (select public.claim_plan_execution(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
     '00000000-0000-0000-0000-0000000000e1',
     array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
     'req-batch-retry')->>'decision'),
  'claimed', 'actions released by a failed dispatch can be claimed again');

select pg_temp.assert_true(
  public.record_execution_dispatch(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    'req-batch-retry', 'accepted', 'workflow-abc', null) = 2,
  'an accepted dispatch records the runtime reference');
select pg_temp.assert_true(
  (select count(*) = 2 from public.remediation_actions
    where dispatch_reference = 'workflow-abc' and execution_status = 'executing'),
  'accepted work stays executing with a durable reference');

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

-- ─── Browser clients cannot claim executions ─────────────────────────
set local role authenticated;
select pg_temp.denied($q$select public.claim_plan_execution('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-0000000000e1',array['00000000-0000-0000-0000-0000000000d1']::uuid[],'x')$q$);
select pg_temp.denied($q$select public.record_execution_dispatch('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c3','x','accepted',null,null)$q$);
reset role;

rollback;
