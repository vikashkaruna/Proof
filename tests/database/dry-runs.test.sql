-- W5 · M3.2 / migration 0060: the dry-run engine's write path.
--
-- `record_dry_run` is the only way anything reaches `dry_runs` and the only
-- thing that moves `remediation_actions`' inline dry-run state. What these
-- assertions protect: a dry-run is bound to exactly the stored content it
-- simulated; a success makes the action eligible and nothing else does; a
-- refusal invalidates an earlier success instead of leaving the action
-- approvable on a stale diff; and no browser session can write any of it.

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
  ('00000000-0000-0000-0000-0000000000a1', 'member@test.invalid');
insert into public.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'member@test.invalid');
insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-0000000000c1', 'dry-a', 'Dry A'),
  ('00000000-0000-0000-0000-0000000000c9', 'dry-b', 'Dry B');
insert into public.tenant_users(tenant_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'owner');
insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-dry', now(), 'test', 'test', 0);
insert into public.engagements(id, tenant_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c1', 'test-dry', 'E'),
         ('00000000-0000-0000-0000-0000000000ca', '00000000-0000-0000-0000-0000000000c9', 'test-dry', 'E2');
insert into public.remediation_plans(id, tenant_id, engagement_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-0000000000c2', 'test-dry', 'Dry plan'),
         ('00000000-0000-0000-0000-0000000000cb', '00000000-0000-0000-0000-0000000000c9',
          '00000000-0000-0000-0000-0000000000ca', 'test-dry', 'Other tenant plan');

insert into public.remediation_actions(id, tenant_id, plan_id, sequence, action_type, description, risk_score, parameters, rollback_definition)
values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 1,
   'data.mask', 'Mask contact fields', 10,
   '{"system": "crm", "fields": ["phone", "email"]}'::jsonb,
   '{"steps": [{"op": "restore_from_backup"}]}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 2,
   'data.mask', 'Refusal target', 10,
   '{"system": "hr", "fields": ["salary"]}'::jsonb,
   '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000cb', 1,
   'data.mask', 'Other tenant', 10,
   '{"system": "crm", "fields": ["phone"]}'::jsonb, '{}'::jsonb);

insert into public.approval_tokens(id, tenant_id, plan_id, action_ids, approver_id, mode, signature, signed_payload, nonce, expires_at, status)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
        array['00000000-0000-0000-0000-0000000000d1']::uuid[],
        '00000000-0000-0000-0000-0000000000a1', 'batch', 'sig-1', '{}'::jsonb, 'nonce-dry-1',
        now() + interval '1 hour', 'issued');

-- ─── A success makes the action eligible, bound to stored content ────
select pg_temp.assert_eq(
  (select public.record_dry_run(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
     'succeeded',
     '{"renderable": true, "changes": [{"field": "phone", "before": "value_as_stored", "after": "masked"}]}'::jsonb,
     null, 'sudhaar',
     '{"system": "crm", "fields": ["phone", "email"]}'::jsonb,
     '{"steps": [{"op": "restore_from_backup"}]}'::jsonb,
     gen_random_uuid()
   ) -> 'dryRun' ->> 'status'),
  'succeeded', 'a successful record returns the recorded outcome');

select pg_temp.assert_true(
  (select dry_run_status = 'dry_run_complete'
     from public.remediation_actions where id = '00000000-0000-0000-0000-0000000000d1'),
  'a recorded success marks the action dry_run_complete');

select pg_temp.assert_true(
  (select dry_run_result -> 'changes' is not null
     from public.remediation_actions where id = '00000000-0000-0000-0000-0000000000d1'),
  'the inline diff is what the console renders');

select pg_temp.assert_true(
  (select dry_run_expires_at > now() + interval '23 hours'
      and dry_run_expires_at <= now() + interval '25 hours'
     from public.remediation_actions where id = '00000000-0000-0000-0000-0000000000d1'),
  'the freshness gate is the 24-hour TTL');

select pg_temp.assert_true(
  (select latest_dry_run_id is not null
     from public.remediation_actions where id = '00000000-0000-0000-0000-0000000000d1'),
  'the action links to its dry-run record');

select pg_temp.assert_eq(
  (select d.parameters_hash
     from public.dry_runs d
    where d.id = (select latest_dry_run_id from public.remediation_actions
                   where id = '00000000-0000-0000-0000-0000000000d1')),
  (select encode(digest(convert_to(parameters::text, 'UTF8'), 'sha256'), 'hex')
     from public.remediation_actions where id = '00000000-0000-0000-0000-0000000000d1'),
  'the parameters hash is sha256 over the stored parameters');

select pg_temp.assert_eq(
  (select d.rollback_definition_hash
     from public.dry_runs d
    where d.id = (select latest_dry_run_id from public.remediation_actions
                   where id = '00000000-0000-0000-0000-0000000000d1')),
  (select encode(digest(convert_to(rollback_definition::text, 'UTF8'), 'sha256'), 'hex')
     from public.remediation_actions where id = '00000000-0000-0000-0000-0000000000d1'),
  'the rollback hash is sha256 over the stored rollback definition');

select pg_temp.assert_true(
  (select d.renderable and d.refusal_reason is null and d.expires_at > now() + interval '23 hours'
     from public.dry_runs d
    where d.id = (select latest_dry_run_id from public.remediation_actions
                   where id = '00000000-0000-0000-0000-0000000000d1')),
  'a success is renderable, unrefused, and carries the TTL itself');

select pg_temp.assert_true(
  (select count(*) >= 1 from public.audit_ledger
    where action_type = 'plan.dry_run.completed'
      and target_ref = '00000000-0000-0000-0000-0000000000d1'),
  'the recorded run is in the ledger');

-- ─── A refusal invalidates an earlier success ─────────────────────────
select pg_temp.assert_eq(
  (select public.record_dry_run(
     '00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000d1',
     'refused', null, 'action_type_not_simulable', 'sudhaar',
     '{"system": "crm", "fields": ["phone", "email"]}'::jsonb,
     '{"steps": [{"op": "restore_from_backup"}]}'::jsonb,
     gen_random_uuid()
   ) ->> 'error'),
  'action_not_found', 'an action from another tenant is action_not_found');

select pg_temp.assert_eq(
  (select public.record_dry_run(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2',
     'refused', null, 'action_type_not_simulable', 'sudhaar',
     '{"system": "hr", "fields": ["salary"]}'::jsonb,
     '{}'::jsonb,
     gen_random_uuid()
   ) -> 'dryRun' ->> 'status'),
  'refused', 'the refusal is recorded as an outcome');

select pg_temp.assert_true(
  (select dry_run_status = 'awaiting_dry_run'
      and dry_run_result is null and dry_run_expires_at is null
     from public.remediation_actions where id = '00000000-0000-0000-0000-0000000000d2'),
  'a refusal leaves the action awaiting, with nothing for the approval gate to stand on');

-- A refusal after a success invalidates the earlier success.
select public.record_dry_run(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
  'refused', null, 'parameters_invalid', 'sudhaar',
  '{"system": "crm", "fields": ["phone", "email"]}'::jsonb,
  '{"steps": [{"op": "restore_from_backup"}]}'::jsonb,
  gen_random_uuid()
);
select pg_temp.assert_true(
  (select dry_run_status = 'awaiting_dry_run'
      and dry_run_result is null and dry_run_expires_at is null
     from public.remediation_actions where id = '00000000-0000-0000-0000-0000000000d1'),
  'content that can no longer be simulated is not approvable on a stale diff');

-- ─── The gate refusals ────────────────────────────────────────────────
select pg_temp.assert_eq(
  (select public.record_dry_run(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
     'succeeded', '{"changes": []}'::jsonb, null, 'sudhaar',
     '{"system": "crm", "WRONG": true}'::jsonb,
     '{"steps": []}'::jsonb, gen_random_uuid()
   ) ->> 'error'),
  'content_mismatch', 'a dry-run over content that is not the stored action is refused');

update public.remediation_actions set approval_status = 'approved'
  where id = '00000000-0000-0000-0000-0000000000d2';
select pg_temp.assert_eq(
  (select public.record_dry_run(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2',
     'succeeded', '{"changes": []}'::jsonb, null, 'sudhaar',
     '{"system": "hr", "fields": ["salary"]}'::jsonb, '{}'::jsonb, gen_random_uuid()
   ) ->> 'error'),
  'action_not_eligible', 'approved content is frozen: no dry-run can rewrite what the approver read');

select pg_temp.assert_eq(
  (select public.record_dry_run(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
     'succeeded', '{"no_changes_key": true}'::jsonb, null, 'sudhaar',
     '{"system": "crm", "fields": ["phone", "email"]}'::jsonb,
     '{"steps": [{"op": "restore_from_backup"}]}'::jsonb, gen_random_uuid()
   ) ->> 'error'),
  'invalid_diff', 'a success without a changes array is not a structured diff');

select pg_temp.assert_eq(
  (select public.record_dry_run(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
     'refused', '{"changes": []}'::jsonb, 'parameters_invalid', 'sudhaar',
     '{"system": "crm", "fields": ["phone", "email"]}'::jsonb,
     '{"steps": [{"op": "restore_from_backup"}]}'::jsonb, gen_random_uuid()
   ) ->> 'error'),
  'invalid_refusal', 'a refusal never carries a diff');

-- ─── Table guards ─────────────────────────────────────────────────────
select pg_temp.raises('23514',
  $q$insert into public.dry_runs(tenant_id, action_id, plan_id, status, diff, renderable, parameters_hash, rollback_definition_hash, correlation_id)
   values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c3',
           'succeeded', null, true, repeat('a', 64), repeat('b', 64), gen_random_uuid())$q$,
  'a success row without a diff violates the outcome shape');

select pg_temp.raises('23503',
  $q$insert into public.dry_runs(tenant_id, action_id, plan_id, status, diff, renderable, parameters_hash, rollback_definition_hash, correlation_id)
   values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000c3',
           'succeeded', '{"changes": []}'::jsonb, true, repeat('a', 64), repeat('b', 64), gen_random_uuid())$q$,
  'a dry-run record cannot cross tenants through its action link');

-- One reconciliation statement per batch, and out-of-scope execution is a
-- defect to fail on, not a finding to store.
insert into public.execution_batches(id, tenant_id, plan_id, request_key, correlation_id, approval_token_id,
  content_digest, mode, concurrency, stop_on_failure, status)
values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000c1',
        '00000000-0000-0000-0000-0000000000c3', 'req-dry-1', gen_random_uuid(),
        '00000000-0000-0000-0000-0000000000e1', repeat('c', 64), 'batch', 1, true, 'dispatched');

select pg_temp.raises('23514',
  $q$insert into public.plan_reconciliations(tenant_id, plan_id, batch_id, approved_scope, executed_reality, out_of_scope, statement, statement_signature)
   values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000f1',
           '{}'::jsonb, '{}'::jsonb, '[{"action_id": "x"}]'::jsonb, 's', repeat('g', 64))$q$,
  'a reconciliation row claiming out-of-scope execution cannot be stored');

insert into public.plan_reconciliations(tenant_id, plan_id, batch_id, approved_scope, executed_reality, unexecuted,
  parameter_diffs, verification_outcomes, statement, statement_signature)
values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000f1',
        '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
        'approved scope matched executed reality', repeat('g', 64));
select pg_temp.raises('23505',
  $q$insert into public.plan_reconciliations(tenant_id, plan_id, batch_id, approved_scope, executed_reality, statement, statement_signature)
   values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000f1',
           '{}'::jsonb, '{}'::jsonb, 's2', repeat('g', 64))$q$,
  'one reconciliation statement per batch');

select pg_temp.raises('23514',
  $q$insert into public.execution_batches(id, tenant_id, plan_id, request_key, correlation_id, approval_token_id,
    content_digest, mode, concurrency, stop_on_failure, status, finished_at)
   values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000c1',
           '00000000-0000-0000-0000-0000000000c3', 'req-dry-2', gen_random_uuid(),
           '00000000-0000-0000-0000-0000000000e1', repeat('c', 64), 'batch', 1, true, 'dispatched', now())$q$,
  'a dispatched batch cannot already be finished');

-- ─── Nobody writes these tables except the SECURITY DEFINER paths ────
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

-- A tenant member reads their own dry-runs...
select pg_temp.assert_true(
  (select count(*) >= 1 from public.dry_runs
    where tenant_id = '00000000-0000-0000-0000-0000000000c1'),
  'a tenant member reads their own dry-run records');
-- ...only their own.
select pg_temp.assert_true(
  (select count(*) = 0 from public.dry_runs
    where tenant_id = '00000000-0000-0000-0000-0000000000c9'),
  'another tenant''s dry-run records are invisible');

select pg_temp.denied($q$insert into public.dry_runs(tenant_id, action_id, plan_id, status, renderable, parameters_hash, rollback_definition_hash, correlation_id)
  values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c3',
          'succeeded', true, repeat('a', 64), repeat('b', 64), gen_random_uuid())$q$);
select pg_temp.denied($q$update public.dry_runs set status = 'succeeded'$q$);
select pg_temp.denied($q$delete from public.dry_runs$q$);
select pg_temp.denied($q$select public.record_dry_run(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
  'succeeded', '{"changes": []}'::jsonb, null, 'sudhaar',
  '{"system": "crm", "fields": ["phone", "email"]}'::jsonb,
  '{"steps": []}'::jsonb, gen_random_uuid())$q$);
reset role;

-- The managed service role (nobypassrls, set by the test runner) reads for
-- the BFF but has no direct write path either.
set local role service_role;
select pg_temp.assert_true((select count(*) >= 1 from public.dry_runs), 'the BFF service reads dry-runs');
select pg_temp.denied($q$insert into public.dry_runs(tenant_id, action_id, plan_id, status, renderable, parameters_hash, rollback_definition_hash, correlation_id)
  values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c3',
          'succeeded', true, repeat('a', 64), repeat('b', 64), gen_random_uuid())$q$);
select pg_temp.denied($q$update public.dry_runs set status = 'succeeded'$q$);
select pg_temp.denied($q$delete from public.dry_runs$q$);
select pg_temp.denied($q$update public.plan_reconciliations set statement = 'forged'$q$);
select pg_temp.denied($q$delete from public.execution_batches$q$);
reset role;

rollback;
