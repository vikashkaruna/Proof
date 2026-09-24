-- W5 / 0023: what a human may do about a dispatch that never confirmed.
--
-- 0021 made `unknown` retain the claim, which is right — from the database an
-- unreachable runtime is indistinguishable from work running on a client's
-- estate. It is also a dead end, because nothing could then ever clear it.
--
-- The founder's decision is that redelivery always needs a FRESH approval, so
-- these assertions are mostly about what reconciliation must NOT do: it must
-- not give the spent token back, and it must not release work that the runtime
-- actually accepted.
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

-- Fixture (mirrors tests/database/execution-fixture.sql).
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

-- Every token carries the snapshot of what it approves (0026/0027). Issued by
-- `issue_plan_approval` in production; set here from the same SQL function, so
-- the fixture cannot drift from what the claim recomputes. A token without one
-- is refused — that is asserted separately.
update public.approval_tokens t
   set signed_payload = coalesce(t.signed_payload, '{}'::jsonb)
     || jsonb_build_object('contentDigest',
          public.action_set_content_digest(t.tenant_id, t.plan_id, t.action_ids));

update public.remediation_actions set approval_status = 'approved', dry_run_status = 'dry_run_complete', rollback_validated = true, dry_run_expires_at = now() + interval '1 hour';

-- A third token, for proving that a released batch needs a NEW approval.
insert into public.approval_tokens(id, tenant_id, plan_id, action_ids, approver_id, mode, signature, signed_payload, nonce, expires_at, status)
values ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
        array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
        '00000000-0000-0000-0000-0000000000a9', 'batch', 'sig-3', '{}'::jsonb, 'nonce-3', now() + interval '1 hour', 'issued');

-- This one is created after the blanket update above, so it needs its own
-- snapshot; a token without one cannot claim.
update public.approval_tokens t
   set signed_payload = coalesce(t.signed_payload, '{}'::jsonb)
     || jsonb_build_object('contentDigest',
          public.action_set_content_digest(t.tenant_id, t.plan_id, t.action_ids))
 where t.id = '00000000-0000-0000-0000-0000000000e3';

-- ─── An acknowledgement that never arrived ───────────────────────────
select pg_temp.assert_eq(
  public.claim_plan_execution(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    '00000000-0000-0000-0000-0000000000e1',
    array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
    'req-recon-1')->>'decision',
  'claimed', 'the batch is claimed');

select pg_temp.assert_true(
  public.finish_execution_dispatch(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    'req-recon-1', 'unknown', null, 'acknowledgement lost'),
  'the uncertain outcome is recorded');
select pg_temp.assert_true(
  (select count(*) = 2 from public.remediation_actions
    where execution_request_key = 'req-recon-1' and execution_status = 'executing'),
  'an uncertain dispatch keeps its claim — the state reconciliation exists for');

-- ─── Refusals ────────────────────────────────────────────────────────
select pg_temp.assert_eq(
  public.reconcile_execution_dispatch(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    'req-recon-1', 'redeliver', 'go on then', '00000000-0000-0000-0000-0000000000a9')->>'decision',
  'invalid_decision', 'there is no redeliver decision; that was the founder call');
select pg_temp.assert_eq(
  public.reconcile_execution_dispatch(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    'req-recon-1', 'released', '   ', '00000000-0000-0000-0000-0000000000a9')->>'decision',
  'reason_required', 'a reconciliation with no stated reason records no judgement');
select pg_temp.assert_eq(
  public.reconcile_execution_dispatch(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    'no-such-key', 'released', 'nothing ran', '00000000-0000-0000-0000-0000000000a9')->>'decision',
  'intent_not_found', 'an intent that does not exist cannot be reconciled');

-- A refusal must not have touched anything.
select pg_temp.assert_true(
  (select count(*) = 2 from public.remediation_actions
    where execution_request_key = 'req-recon-1' and execution_status = 'executing'),
  'refused reconciliations leave the claim alone');

-- Inject a ledger failure and prove the entire judgement rolls back.
create function pg_temp.reject_reconcile_ledger() returns trigger language plpgsql as $$
begin
 if new.action_type = 'execution.dispatch.reconciled' then raise exception 'test ledger unavailable'; end if;
 return new;
end $$;
create trigger fail_reconciliation_ledger before insert on public.audit_ledger
 for each row execute function pg_temp.reject_reconcile_ledger();
do $$ begin
 perform public.reconcile_execution_dispatch(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
  'req-recon-1', 'released', 'test release', '00000000-0000-0000-0000-0000000000a9');
 raise exception 'ASSERTION FAILED: release succeeded without ledger';
exception when others then
 if sqlerrm <> 'test ledger unavailable' then raise; end if;
end $$;
drop trigger fail_reconciliation_ledger on public.audit_ledger;
select pg_temp.assert_true((select status = 'unknown' from public.execution_dispatch_outbox
 where request_key = 'req-recon-1'), 'ledger failure preserves unresolved intent');
select pg_temp.assert_true((select count(*) = 2 from public.remediation_actions
 where execution_request_key = 'req-recon-1' and execution_status = 'executing'), 'ledger failure preserves claims');
select pg_temp.assert_eq((select status::text from public.approval_tokens
 where id = '00000000-0000-0000-0000-0000000000e3'), 'issued', 'ledger failure rolls back token revocation');

-- ─── Released: the operator asserts nothing ran ──────────────────────
select pg_temp.assert_eq(
  public.reconcile_execution_dispatch(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    'req-recon-1', 'released', 'runtime never received it; verified in connector logs',
    '00000000-0000-0000-0000-0000000000a9')->>'released_action_count',
  '2', 'both actions are released');

select pg_temp.assert_true(
  (select count(*) = 2 from public.remediation_actions
    where plan_id = '00000000-0000-0000-0000-0000000000c3'
      and id in ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2')
      and execution_status = 'approved' and execution_request_key is null
      and dispatch_status is null),
  'released actions return to approved with no claim');

-- THE assertion. The spent token stays spent, which is what makes a
-- redelivery need a fresh approval rather than a replay of the old one.
select pg_temp.assert_eq(
  (select status::text from public.approval_tokens where id = '00000000-0000-0000-0000-0000000000e1'),
  'consumed', 'releasing must NOT give the approval token back');
select pg_temp.assert_eq(
  public.claim_plan_execution(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    '00000000-0000-0000-0000-0000000000e1',
    array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
    'req-recon-replay')->>'decision',
  'token_already_used', 'the old approval cannot re-dispatch released work');

-- The judgement is attributed and the row leaves the queue.
select pg_temp.assert_true(
  (select reconciled_decision = 'released' and reconciled_by = '00000000-0000-0000-0000-0000000000a9'
          and reconciled_at is not null and status = 'abandoned'
          and abandoned_reason like 'runtime never received it%'
     from public.execution_dispatch_outbox where request_key = 'req-recon-1'),
  'the decision, its reason and who made it are all recorded');
select pg_temp.assert_true(
  (select count(*) = 0 from public.pending_execution_dispatches where request_key = 'req-recon-1'),
  'a reconciled intent leaves the operator queue');
select pg_temp.assert_eq(
  public.reconcile_execution_dispatch(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    'req-recon-1', 'released', 'again', '00000000-0000-0000-0000-0000000000a9')->>'decision',
  'not_reconcilable', 'a judgement already recorded is not revisited');

-- A token issued BEFORE reconciliation is not a fresh approval, even when
-- it was never consumed. The old suite incorrectly called this token fresh.
select pg_temp.assert_eq((select status::text from public.approval_tokens
 where id = '00000000-0000-0000-0000-0000000000e3'), 'revoked', 'outstanding old authority is revoked');
select pg_temp.assert_true((select count(*) = 1 from public.audit_ledger
 where action_type = 'execution.dispatch.reconciled' and target_ref = '00000000-0000-0000-0000-0000000000c3'),
 'release and ledger judgment commit together');

-- Simulate a genuinely new approval, issued after reconciliation.
insert into public.approval_tokens(id, tenant_id, plan_id, action_ids, approver_id, mode,
 signature, signed_payload, nonce, expires_at, status)
select '00000000-0000-0000-0000-0000000000e4', tenant_id, plan_id, action_ids, approver_id,
 mode, 'new-sig', signed_payload, 'new-approval-after-reconcile', expires_at, 'issued'
 from public.approval_tokens where id = '00000000-0000-0000-0000-0000000000e3';
-- A FRESH approval can claim the released work.
select pg_temp.assert_eq(
  public.claim_plan_execution(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    '00000000-0000-0000-0000-0000000000e4',
    array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
    'req-recon-2')->>'decision',
  'claimed', 'released work is claimable again under a new approval');

-- ─── Delivered work is not reconcilable ──────────────────────────────
select pg_temp.assert_true(
  public.finish_execution_dispatch(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    'req-recon-2', 'accepted', 'workflow-xyz', null),
  'the runtime accepts the second batch');
select pg_temp.assert_eq(
  public.reconcile_execution_dispatch(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    'req-recon-2', 'released', 'let me have those back',
    '00000000-0000-0000-0000-0000000000a9')->>'decision',
  'not_reconcilable', 'work the runtime accepted must not be released into a second execution');
select pg_temp.assert_true(
  (select count(*) = 2 from public.remediation_actions
    where execution_request_key = 'req-recon-2' and execution_status = 'executing'),
  'the accepted batch is untouched by the attempt');

-- ─── Abandoned: closed without asserting anything ────────────────────
-- A separate batch, because 0021 refuses to downgrade a delivered intent and
-- is right to: `req-recon-2` was accepted by the runtime and stays that way.
select pg_temp.assert_eq(
  public.claim_plan_execution(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    '00000000-0000-0000-0000-0000000000e2',
    array['00000000-0000-0000-0000-0000000000d3']::uuid[],
    'req-recon-3')->>'decision',
  'claimed', 'a third batch is claimed');
select pg_temp.assert_true(
  public.finish_execution_dispatch(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    'req-recon-3', 'unknown', null, 'no acknowledgement'),
  'its outcome is uncertain');

select pg_temp.assert_eq(
  public.reconcile_execution_dispatch(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    'req-recon-3', 'abandoned', 'cannot establish whether it ran',
    '00000000-0000-0000-0000-0000000000a9')->>'released_action_count',
  '0', 'abandoning releases nothing');
select pg_temp.assert_true(
  (select count(*) = 1 from public.remediation_actions
    where execution_request_key = 'req-recon-3' and execution_status = 'executing'),
  'abandoning leaves the action exactly where it was — the honest outcome when nobody can account for it');
select pg_temp.assert_true(
  (select reconciled_decision = 'abandoned' and status = 'abandoned'
     from public.execution_dispatch_outbox where request_key = 'req-recon-3'),
  'the abandonment is recorded as such, not as a release');
select pg_temp.assert_true(
  (select count(*) = 0 from public.pending_execution_dispatches where request_key = 'req-recon-3'),
  'an abandoned intent also leaves the queue');

-- ─── Browser clients cannot reconcile ────────────────────────────────
set local role authenticated;
select pg_temp.denied($q$select public.reconcile_execution_dispatch('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c3','x','released','y','00000000-0000-0000-0000-0000000000a9')$q$);
reset role;

rollback;
