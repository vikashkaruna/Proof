-- W5 · M3.5 / migration 0062: the rollback engine's write path.
--
-- `record_rollback_execution` is the only way anything reaches
-- `rollback_executions`. What the assertions protect: a rollback executes
-- Sudhaar's stored definition exactly (re-read and compared here), only
-- against an action the batch actually completed, only once; the action
-- lands `rolled_back` and both ledger phases commit with the record; and
-- no browser session can reach any of it.

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

-- ─── Fixture ─────────────────────────────────────────────────────────
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a9', 'approver@test.invalid');
insert into public.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a9', 'approver@test.invalid');
insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-0000000000c1', 'rb-a', 'Rollback A');
insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-rb', now(), 'test', 'test', 0);
insert into public.engagements(id, tenant_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c1', 'test-rb', 'E');
insert into public.remediation_plans(id, tenant_id, engagement_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-0000000000c2', 'test-rb', 'Rollback plan');

insert into public.remediation_actions(id, tenant_id, plan_id, sequence, action_type, description, risk_score, rollback_definition)
values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 1,
   'data.mask', 'Rollback target', 10, '{"steps": [{"op": "restore_from_backup"}]}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 2,
   'data.mask', 'Definition probe', 10, '{"steps": [{"op": "restore_from_backup"}]}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 3,
   'data.mask', 'Never completed', 10, '{"steps": [{"op": "restore_from_backup"}]}'::jsonb);

insert into public.approval_tokens(id, tenant_id, plan_id, action_ids, approver_id, mode, signature, signed_payload, nonce, expires_at, status)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
        array['00000000-0000-0000-0000-0000000000d1']::uuid[], '00000000-0000-0000-0000-0000000000a9',
        'batch', 'sig-1', '{}'::jsonb, 'nonce-rb-1', now() + interval '1 hour', 'consumed');

insert into public.execution_batches(id, tenant_id, plan_id, request_key, correlation_id, approval_token_id,
  content_digest, mode, concurrency, stop_on_failure, status)
values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000c1',
        '00000000-0000-0000-0000-0000000000c3', 'req-rb-1', gen_random_uuid(),
        '00000000-0000-0000-0000-0000000000e1', repeat('c', 64), 'batch', 1, true, 'running');

-- The executor's state after a-1 and a-2 completed: linked to the batch,
-- settled succeeded, with state references.
update public.remediation_actions
   set execution_batch_id = '00000000-0000-0000-0000-0000000000f1',
       execution_status = 'succeeded', final_outcome = 'succeeded',
       pre_state_uri = 'sha256:aaa', post_state_uri = 'sha256:bbb'
 where id in ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2');

-- d3 is claimed by the batch but never completed: still `executing`.
update public.remediation_actions
   set execution_batch_id = '00000000-0000-0000-0000-0000000000f1',
       execution_status = 'executing'
 where id = '00000000-0000-0000-0000-0000000000d3';

-- A reconstructed definition is not Sudhaar's definition: the record is
-- refused before anything is written.
select pg_temp.assert_eq(
  (select public.record_rollback_execution(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2',
     '00000000-0000-0000-0000-0000000000f1',
     '{"steps": [{"op": "make_it_up"}]}'::jsonb,
     'manual', 'succeeded', null, gen_random_uuid())
   ->> 'error'),
  'definition_mismatch', 'the engine cannot reverse a definition other than the stored one');

-- ─── A completed action is reversed against its stored definition ────
select pg_temp.assert_eq(
  (select public.record_rollback_execution(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
     '00000000-0000-0000-0000-0000000000f1',
     '{"steps": [{"op": "restore_from_backup"}]}'::jsonb,
     'failure_threshold', 'succeeded', '{"rows_affected": 5}'::jsonb, gen_random_uuid())
   -> 'rollback' ->> 'status'),
  'succeeded', 'the rollback is recorded');

select pg_temp.assert_true(
  (select execution_status = 'rolled_back' and final_outcome = 'rolled_back'
     and latest_rollback_execution_id is not null
     from public.remediation_actions where id = '00000000-0000-0000-0000-0000000000d1'),
  'the action lands rolled_back and links its rollback record');

select pg_temp.assert_eq(
  (select d.definition_hash
     from public.rollback_executions d
    where d.id = (select latest_rollback_execution_id from public.remediation_actions
                   where id = '00000000-0000-0000-0000-0000000000d1')),
  (select encode(digest(convert_to(rollback_definition::text, 'UTF8'), 'sha256'), 'hex')
     from public.remediation_actions where id = '00000000-0000-0000-0000-0000000000d1'),
  'the recorded definition hash is sha256 over the stored definition');

select pg_temp.assert_true((select count(*) >= 1 from public.audit_ledger
  where action_type = 'execution.rollback.started' and target_ref = '00000000-0000-0000-0000-0000000000d1'),
  'the rollback start is in the ledger');
select pg_temp.assert_true((select count(*) >= 1 from public.audit_ledger
  where action_type = 'execution.rollback.completed' and target_ref = '00000000-0000-0000-0000-0000000000d1'),
  'the rollback outcome is in the ledger');

-- ─── The gate refusals ────────────────────────────────────────────────
-- Only a completed action can be reversed.
select pg_temp.assert_eq(
  (select public.record_rollback_execution(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d3',
     '00000000-0000-0000-0000-0000000000f1',
     '{"steps": [{"op": "restore_from_backup"}]}'::jsonb,
     'failure_threshold', 'succeeded', null, gen_random_uuid())
   ->> 'error'),
  'action_not_reversible', 'an action the batch never completed cannot be rolled back');

-- The rolled-back action cannot be reversed twice.
select pg_temp.assert_eq(
  (select public.record_rollback_execution(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
     '00000000-0000-0000-0000-0000000000f1',
     '{"steps": [{"op": "restore_from_backup"}]}'::jsonb,
     'manual', 'succeeded', null, gen_random_uuid())
   ->> 'error'),
  'action_not_reversible', 'a rolled-back action cannot be reversed again');

-- A rolled-back action cannot be reversed twice, whatever the definition.
select pg_temp.assert_eq(
  (select public.record_rollback_execution(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
     '00000000-0000-0000-0000-0000000000f1',
     '{"steps": [{"op": "make_it_up"}]}'::jsonb,
     'manual', 'succeeded', null, gen_random_uuid())
   ->> 'error'),
  'action_not_reversible', 'a second rollback is refused before the definition is even compared');

-- A different batch cannot record the rollback.
select pg_temp.assert_eq(
  (select public.record_rollback_execution(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2',
     gen_random_uuid(),
     '{"steps": [{"op": "restore_from_backup"}]}'::jsonb,
     'manual', 'succeeded', null, gen_random_uuid())
   ->> 'error'),
  'batch_mismatch', 'a rollback must name the batch that completed the action');

-- Invalid trigger and invented statuses are refused at the gate.
select pg_temp.assert_eq(
  (select public.record_rollback_execution(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2',
     '00000000-0000-0000-0000-0000000000f1',
     '{"steps": [{"op": "restore_from_backup"}]}'::jsonb,
     'because_i_said_so', 'succeeded', null, gen_random_uuid())
   ->> 'error'),
  'invalid_record', 'an invented trigger is refused');

select pg_temp.assert_eq(
  (select public.record_rollback_execution(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2',
     '00000000-0000-0000-0000-0000000000f1',
     '[]'::jsonb, 'manual', 'succeeded', null, gen_random_uuid())
   ->> 'error'),
  'invalid_record', 'a non-object definition is refused');

-- ─── Nobody writes rollbacks except the SECURITY DEFINER path ────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}';
select pg_temp.denied($q$select public.record_rollback_execution(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2',
  '00000000-0000-0000-0000-0000000000f1', '{}'::jsonb, 'manual', 'succeeded', null, gen_random_uuid())$q$);
select pg_temp.denied($q$update public.rollback_executions set status = 'succeeded'$q$);
select pg_temp.denied($q$delete from public.rollback_executions$q$);
reset role;

set local role service_role;
select pg_temp.assert_true((select count(*) >= 1 from public.rollback_executions), 'the BFF service reads rollback records');
select pg_temp.denied($q$insert into public.rollback_executions(tenant_id, action_id, batch_id, definition,
  definition_hash, triggered_by, status, correlation_id)
  values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2',
          '00000000-0000-0000-0000-0000000000f1', '{}'::jsonb, repeat('a', 64), 'manual', 'succeeded', gen_random_uuid())$q$);
select pg_temp.denied($q$update public.rollback_executions set status = 'failed'$q$);
select pg_temp.denied($q$delete from public.rollback_executions$q$);
reset role;

rollback;
