-- W5.7 / migration 0064: Karya's per-task pre- and post-records in
-- `agent_runs`.
--
-- `record_karya_run_start` and `record_karya_run_finish` are the only
-- way the executor touches `agent_runs`: a run opens `running` bound to
-- a real plan/action pair, closes once, and carries hashes and bounded
-- error codes — never payloads. What the assertions protect.

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
  ('00000000-0000-0000-0000-0000000000c1', 'kr-a', 'Karya runs A');
insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-kr', now(), 'test', 'test', 0);
insert into public.engagements(id, tenant_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c1', 'test-kr', 'E');
insert into public.remediation_plans(id, tenant_id, engagement_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-0000000000c2', 'test-kr', 'Runs plan');
insert into public.remediation_actions(id, tenant_id, plan_id, sequence, action_type, description, risk_score, rollback_definition)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 1,
        'data.mask', 'A', 10, '{}'::jsonb);

-- ─── A run opens running and closes once, with its outcome ───────────
select public.record_karya_run_start(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
  '00000000-0000-0000-0000-0000000000d1', gen_random_uuid(), repeat('a', 64));

select pg_temp.assert_true(
  (select status = 'running' and agent = 'karya'
      and input_redacted_hash = repeat('a', 64)
      and pii_redacted
      and metadata ->> 'action_id' = '00000000-0000-0000-0000-0000000000d1'
     from public.agent_runs where tenant_id = '00000000-0000-0000-0000-0000000000c1'),
  'the pre-task record opens running, hashed, bound to the action');

select public.record_karya_run_finish(
  '00000000-0000-0000-0000-0000000000c1',
  (select id from public.agent_runs where tenant_id = '00000000-0000-0000-0000-0000000000c1'),
  'succeeded', null, 42, repeat('b', 64));

select pg_temp.assert_true(
  (select status = 'succeeded' and latency_ms = 42 and error is null
      and output_redacted_hash = repeat('b', 64) and completed_at is not null
     from public.agent_runs where tenant_id = '00000000-0000-0000-0000-0000000000c1'),
  'the post-task record carries the outcome, latency and output hash');

-- A closed run cannot close again.
select pg_temp.assert_eq(
  (select public.record_karya_run_finish(
     '00000000-0000-0000-0000-0000000000c1',
     (select id from public.agent_runs where tenant_id = '00000000-0000-0000-0000-0000000000c1'),
     'failed', 'late', 1, null)
   ->> 'error'),
  'run_not_running', 'a closed run is closed');

-- ─── The gate refusals ───────────────────────────────────────────────
select pg_temp.assert_eq(
  (select public.record_karya_run_start(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
     gen_random_uuid(), gen_random_uuid(), repeat('a', 64))
   ->> 'error'),
  'action_not_found', 'a run cannot open for an action that does not exist');

select pg_temp.assert_eq(
  (select public.record_karya_run_start(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
     '00000000-0000-0000-0000-0000000000d1', gen_random_uuid(), 'not-a-hash')
   ->> 'error'),
  'invalid_record', 'an unhashed input is refused');

select pg_temp.assert_eq(
  (select public.record_karya_run_finish(
     '00000000-0000-0000-0000-0000000000c1', gen_random_uuid(),
     'invented', null, 1, null)
   ->> 'error'),
  'invalid_record', 'an invented status is refused');

select pg_temp.assert_eq(
  (select public.record_karya_run_finish(
     '00000000-0000-0000-0000-0000000000c1', gen_random_uuid(),
     'failed', 'NOT A CODE; drop table', 1, null)
   ->> 'error'),
  'invalid_record', 'an unbounded error code is refused');

-- ─── Nobody writes runs except the SECURITY DEFINER paths ────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}';
select pg_temp.denied($q$select public.record_karya_run_start(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
  '00000000-0000-0000-0000-0000000000d1', gen_random_uuid(), repeat('a', 64))$q$);
select pg_temp.denied($q$update public.agent_runs set status = 'succeeded'$q$);
select pg_temp.denied($q$delete from public.agent_runs$q$);
reset role;

set local role service_role;
select pg_temp.assert_true(
  (select count(*) >= 1 from public.agent_runs where tenant_id = '00000000-0000-0000-0000-0000000000c1'),
  'the BFF service reads run records');
select pg_temp.denied($q$update public.agent_runs set status = 'succeeded'$q$);
select pg_temp.denied($q$delete from public.agent_runs$q$);
reset role;

rollback;
