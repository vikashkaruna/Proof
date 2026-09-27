-- W6 / migration 0078: continuous monitoring alerts and dispatch.
--
-- Tests the monitoring alerts table, automatic dispatch over high/critical
-- drift, overdue schedules and burning deadlines, and human dismissal.

begin;

create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
create function pg_temp.assert_eq(actual text, expected text, message text) returns void language plpgsql as $$
begin if actual is distinct from expected then
  raise exception 'ASSERTION FAILED: % (expected %, got %)', message, expected, actual; end if; end $$;

-- ─── Fixtures ────────────────────────────────────────────────────────
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000c8', 'dpo@test.invalid');
insert into public.users(id, email) values
  ('00000000-0000-0000-0000-0000000000c8', 'dpo@test.invalid');
insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-0000000000b1', 'alert-test-tenant', 'Alert Test Tenant');
insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-alert-lib', now(), 'test', 'test', 0);
insert into public.engagements(id, tenant_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b1', 'test-alert-lib', 'Engagement Alerts');
insert into public.estates(id, tenant_id, slug, name)
  values ('00000000-0000-0000-0000-0000000000e8', '00000000-0000-0000-0000-0000000000b1',
          'estate-alerts', 'Estate Alerts');

-- 1. Unacknowledged high severity drift event
insert into public.drift_events(id, tenant_id, estate_id, kind, severity, summary)
values ('00000000-0000-0000-0000-0000000000d8', '00000000-0000-0000-0000-0000000000b1',
        '00000000-0000-0000-0000-0000000000e8', 'connection_lost', 'high', 'Database primary replication connection lost');

-- 2. Overdue active schedule
insert into public.monitoring_schedules(id, tenant_id, estate_id, name, kind, cadence, status, created_by, next_run_at)
values ('00000000-0000-0000-0000-000000000058', '00000000-0000-0000-0000-0000000000b1',
        '00000000-0000-0000-0000-0000000000e8', 'Daily Core Rediscovery', 'rediscovery', '0 2 * * *',
        'active', '00000000-0000-0000-0000-0000000000c8', now() - interval '2 hours');

-- 3. Burning compliance event (due in 6 hours)
insert into public.compliance_events(id, tenant_id, title, description, due_at, status)
values ('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000b1',
        'DSAR Identity Response Window', 'Statutory 30-day response clock expiring', now() + interval '6 hours', 'open');

-- ─── 1. Dispatch Monitoring Alerts ───────────────────────────────────
select pg_temp.assert_true(
  ((select public.dispatch_monitoring_alerts(
      '00000000-0000-0000-0000-0000000000b1', gen_random_uuid()
    )->>'dispatchedCount')::integer = 3),
  'dispatch generates 3 alerts from high drift, overdue schedule, and burning deadline');

-- Check rows in monitoring_alerts
select pg_temp.assert_true(
  (select count(*) = 3 from public.monitoring_alerts where tenant_id = '00000000-0000-0000-0000-0000000000b1'),
  'three alerts exist in monitoring_alerts table');

select pg_temp.assert_true(
  (select count(*) = 1 from public.monitoring_alerts where alert_type = 'drift_high'),
  'drift_high alert recorded');

select pg_temp.assert_true(
  (select count(*) = 1 from public.monitoring_alerts where alert_type = 'schedule_overdue'),
  'schedule_overdue alert recorded');

select pg_temp.assert_true(
  (select count(*) = 1 from public.monitoring_alerts where alert_type = 'compliance_deadline_burning'),
  'compliance_deadline_burning alert recorded');

-- Verify ledger entry
select pg_temp.assert_true(
  (select count(*) >= 1 from public.audit_ledger
    where tenant_id = '00000000-0000-0000-0000-0000000000b1'
      and action_type = 'monitoring.alert.dispatched'),
  'monitoring.alert.dispatched recorded in audit ledger');

-- ─── 2. Idempotent re-dispatch does not duplicate alerts ─────────────
select pg_temp.assert_true(
  ((select public.dispatch_monitoring_alerts(
      '00000000-0000-0000-0000-0000000000b1', gen_random_uuid()
    )->>'totalUnread')::integer = 3),
  're-dispatch maintains totalUnread at 3 without duplication');

select pg_temp.assert_true(
  (select count(*) = 3 from public.monitoring_alerts where tenant_id = '00000000-0000-0000-0000-0000000000b1'),
  'no duplicate rows created');

-- ─── 3. Dismiss an Alert ─────────────────────────────────────────────
select pg_temp.assert_eq(
  (select public.dismiss_monitoring_alert(
      '00000000-0000-0000-0000-0000000000b1',
      (select id from public.monitoring_alerts where alert_type = 'drift_high' limit 1),
      '00000000-0000-0000-0000-0000000000c8',
      gen_random_uuid()
    )->>'dismissed'),
  'true',
  'alert is dismissed');

select pg_temp.assert_true(
  (select status = 'dismissed' and acknowledged_at is not null and acknowledged_by = '00000000-0000-0000-0000-0000000000c8'
     from public.monitoring_alerts where alert_type = 'drift_high' limit 1),
  'alert status transitioned to dismissed with user tracking');

-- Verify dismissal ledger entry
select pg_temp.assert_true(
  (select count(*) >= 1 from public.audit_ledger
    where tenant_id = '00000000-0000-0000-0000-0000000000b1'
      and action_type = 'monitoring.alert.dismissed'),
  'monitoring.alert.dismissed recorded in audit ledger');

-- Dismissing again returns already_dismissed
select pg_temp.assert_eq(
  (select public.dismiss_monitoring_alert(
      '00000000-0000-0000-0000-0000000000b1',
      (select id from public.monitoring_alerts where alert_type = 'drift_high' limit 1),
      '00000000-0000-0000-0000-0000000000c8',
      gen_random_uuid()
    )->>'error'),
  'already_dismissed',
  'double dismissal refused');

rollback;
