-- W6 / migration 0066: the scheduler's write paths.
--
-- `record_drift_event` is the only way anything reaches drift_events;
-- `record_schedule_run` is the only way a schedule's bookkeeping moves.
-- What the assertions protect: detections are bounded, identifier-shaped
-- facts against a real estate; a schedule only advances while active and
-- only to a future fire; and no browser session can write either.

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
  ('00000000-0000-0000-0000-0000000000a9', 'manager@test.invalid');
insert into public.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a9', 'manager@test.invalid');
insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-0000000000c1', 'sch-a', 'Schedules A');
insert into public.tenant_users(tenant_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a9', 'owner');
insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-sch', now(), 'test', 'test', 0);
insert into public.engagements(id, tenant_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c1', 'test-sch', 'E');
insert into public.estates(id, tenant_id, slug, name)
  values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1',
          'india-production', 'India production');
insert into public.monitoring_schedules(id, tenant_id, estate_id, name, kind, cadence, created_by, next_run_at)
values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000c1',
        '00000000-0000-0000-0000-0000000000e1', 'Fortnightly drift check', 'drift_check',
        '*/15 * * * *', '00000000-0000-0000-0000-0000000000a9', now() + interval '1 hour');

-- ─── A detection lands, bounded, and is ledgered ─────────────────────
select pg_temp.assert_eq(
  (select public.record_drift_event(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1',
     'system_added', 'medium', 'system added: New CRM', 'system-1', gen_random_uuid())
   -> 'driftEvent' ->> 'kind'),
  'system_added', 'a detection is recorded');

select pg_temp.assert_true((select count(*) >= 1 from public.audit_ledger
  where action_type = 'monitoring.drift.detected'
    and target_ref = '00000000-0000-0000-0000-0000000000e1'),
  'the detection is in the ledger');

select pg_temp.assert_eq(
  (select public.record_drift_event(
     '00000000-0000-0000-0000-0000000000c1', gen_random_uuid(),
     'system_added', 'medium', 'x', null, gen_random_uuid())
   ->> 'error'),
  'estate_not_found', 'a detection names a real estate');

select pg_temp.assert_eq(
  (select public.record_drift_event(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1',
     'invented', 'medium', 'x', null, gen_random_uuid())
   ->> 'error'),
  'invalid_event', 'an invented kind is refused');

select pg_temp.assert_eq(
  (select public.record_drift_event(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1',
     'system_added', 'medium', repeat('x', 301), null, gen_random_uuid())
   ->> 'error'),
  'invalid_event', 'an unbounded summary is refused');

-- ─── The schedule advances only while active, to a future fire ───────
select pg_temp.assert_eq(
  (select public.record_schedule_run(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1',
     now() + interval '15 minutes', 'no_drift', gen_random_uuid())
   ->> 'ok'),
  'true', 'an active schedule advances');

select pg_temp.assert_true(
  (select last_run_at is not null and next_run_at > now()
     from public.monitoring_schedules where id = '00000000-0000-0000-0000-0000000000f1'),
  'the bookkeeping moved forward');

select pg_temp.assert_true((select count(*) >= 1 from public.audit_ledger
  where action_type = 'monitoring.schedule.fired'
    and target_ref = '00000000-0000-0000-0000-0000000000f1'),
  'the fired schedule is in the ledger');

select pg_temp.assert_eq(
  (select public.record_schedule_run(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1',
     now() - interval '1 minute', 'no_drift', gen_random_uuid())
   ->> 'error'),
  'invalid_run', 'a next fire in the past is refused');

update public.monitoring_schedules set status = 'paused' where id = '00000000-0000-0000-0000-0000000000f1';
select pg_temp.assert_eq(
  (select public.record_schedule_run(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1',
     now() + interval '15 minutes', 'no_drift', gen_random_uuid())
   ->> 'error'),
  'schedule_not_active', 'a paused schedule does not fire');

-- ─── Nobody writes these except the SECURITY DEFINER paths ───────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}';
select pg_temp.denied($q$select public.record_drift_event(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1',
  'system_added', 'low', 'x', null, gen_random_uuid())$q$);
select pg_temp.denied($q$select public.record_schedule_run(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1',
  now() + interval '1 hour', 'no_drift', gen_random_uuid())$q$);
select pg_temp.denied($q$insert into public.drift_events(tenant_id, estate_id, kind, severity, summary)
  values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1',
          'system_added', 'low', 'x')$q$);
select pg_temp.denied($q$update public.monitoring_schedules set next_run_at = now()$q$);
reset role;

set local role service_role;
select pg_temp.assert_true(
  (select count(*) >= 1 from public.monitoring_schedules), 'the scheduler service reads schedules');
select pg_temp.denied($q$update public.monitoring_schedules set next_run_at = now()$q$);
select pg_temp.denied($q$delete from public.drift_events$q$);
select pg_temp.denied($q$update public.drift_events set severity = 'critical'$q$);
reset role;

rollback;
