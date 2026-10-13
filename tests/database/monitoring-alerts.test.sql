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
do $$
declare tenant constant uuid := '00000000-0000-0000-0000-0000000000b1';
 correlation uuid := gen_random_uuid(); before_count bigint; result jsonb; receipt public.audit_ledger;
begin
 select count(*) into before_count from public.audit_ledger where tenant_id = tenant;
 result := public.dispatch_monitoring_alerts(tenant, correlation);
 perform pg_temp.assert_true(result = jsonb_build_object('dispatchedCount',3,'totalUnread',3,'criticalCount',0,'highCount',3),
  'initial dispatch counts one real insert in each source loop');
 perform pg_temp.assert_true((select count(*) = before_count + 1 from public.audit_ledger where tenant_id = tenant),
  'three real inserts create exactly one dispatch receipt');
 select * into strict receipt from public.audit_ledger where tenant_id = tenant and correlation_id = correlation;
 perform pg_temp.assert_true(receipt.action_type = 'monitoring.alert.dispatched' and receipt.result = 'success'
  and receipt.detail = jsonb_build_object('dispatched_count',3,'total_unread',3,'critical_count',0,'high_count',3),
  'initial dispatch receipt contains exact inserted-row and aggregate counts');
end $$;

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

-- 0121: immutable historical receipts remain intact; new dispatch receipts
-- describe only actual inserts/refreshes across all three source loops.
select pg_temp.assert_true(
  has_function_privilege('service_role', 'public.dispatch_monitoring_alerts(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.dispatch_monitoring_alerts(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.dispatch_monitoring_alerts(uuid,uuid)', 'EXECUTE'),
  'dispatch retains the existing service-only execution boundary');
select pg_temp.assert_true(
  (select prosecdef and proconfig = array['search_path=""']
   from pg_proc where oid = 'public.dispatch_monitoring_alerts(uuid,uuid)'::regprocedure),
  'dispatch remains SECURITY DEFINER with an empty search path');
select pg_temp.assert_true(
  has_function_privilege('human_action_writer', 'public.dismiss_monitoring_alert(uuid,uuid,uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.dismiss_monitoring_alert(uuid,uuid,uuid,uuid)', 'EXECUTE'),
  '0098 human dismissal boundary is unchanged');
select pg_temp.assert_true(
  not has_table_privilege('service_role', 'public.monitoring_alerts', 'INSERT')
  and not has_table_privilege('service_role', 'public.monitoring_alerts', 'UPDATE'),
  '0098 prevents service-role alert DML outside sanctioned dispatch');

-- Foreign tenant alerts must never contribute to this tenant's aggregate or
-- refresh. Use an already-recorded row to isolate tenant filtering precisely.
insert into public.tenants(id, slug, name) values
 ('00000000-0000-0000-0000-0000000000b3', 'alert-other-tenant', 'Other Alert Tenant');
insert into public.monitoring_alerts(tenant_id, alert_type, severity, title, summary, source_id, source_type)
values ('00000000-0000-0000-0000-0000000000b3', 'drift_critical', 'critical',
 'Foreign alert', 'Must remain untouched', 'foreign-source', 'drift_event');

-- One real refresh, two suppressed conflicts: exercise no-op branches for
-- drift and schedule, then the all-no-op case also exercises compliance.
update public.monitoring_alerts set status = 'acknowledged',
 acknowledged_at = now(), acknowledged_by = '00000000-0000-0000-0000-0000000000c8'
where tenant_id = '00000000-0000-0000-0000-0000000000b1' and alert_type = 'schedule_overdue';
update public.monitoring_alerts set status = 'read', dispatched_at = now() - interval '1 day'
where tenant_id = '00000000-0000-0000-0000-0000000000b1' and alert_type = 'compliance_deadline_burning';

do $$
declare
 tenant constant uuid := '00000000-0000-0000-0000-0000000000b1';
 correlation uuid; result jsonb; before_rows jsonb; foreign_rows jsonb; after_rows jsonb;
 before_count bigint; receipt public.audit_ledger;
begin
 select jsonb_agg(to_jsonb(a) order by id) into before_rows from public.monitoring_alerts a
  where tenant_id = tenant and status in ('dismissed','acknowledged');
 select jsonb_agg(to_jsonb(a) order by id) into foreign_rows from public.monitoring_alerts a
  where tenant_id <> tenant;
 for pass in 1..2 loop
  correlation := gen_random_uuid();
  select count(*) into before_count from public.audit_ledger where tenant_id = tenant;
  result := public.dispatch_monitoring_alerts(tenant, correlation);
  perform pg_temp.assert_true(result = jsonb_build_object('dispatchedCount',1,'totalUnread',1,'criticalCount',0,'highCount',1),
   'partial scan and repeat count exactly one refreshed alert, not suppressed sources');
  perform pg_temp.assert_true((select count(*) = before_count + 1 from public.audit_ledger where tenant_id = tenant),
   'one actual dispatch creates exactly one ledger receipt');
  select * into strict receipt from public.audit_ledger where tenant_id = tenant and correlation_id = correlation;
  perform pg_temp.assert_true(receipt.action_type = 'monitoring.alert.dispatched' and receipt.actor_type = 'system'
   and receipt.actor_id = 'nazar' and receipt.result = 'success' and receipt.target_ref = tenant::text
   and receipt.detail = jsonb_build_object('dispatched_count',1,'total_unread',1,'critical_count',0,'high_count',1),
   'dispatch receipt records exact affected-row and tenant aggregate counts');
 end loop;
 perform pg_temp.assert_true((select dispatched_at = now() from public.monitoring_alerts
  where tenant_id = tenant and alert_type = 'compliance_deadline_burning'), 'actual active alert is refreshed');
 select jsonb_agg(to_jsonb(a) order by id) into after_rows from public.monitoring_alerts a
  where tenant_id = tenant and status in ('dismissed','acknowledged');
 perform pg_temp.assert_true(after_rows = before_rows, 'dismissed and acknowledged rows are entirely unchanged');
 select jsonb_agg(to_jsonb(a) order by id) into after_rows from public.monitoring_alerts a where tenant_id <> tenant;
 perform pg_temp.assert_true(after_rows = foreign_rows, 'foreign tenant alerts are entirely unchanged');
end $$;

update public.monitoring_alerts set status = 'dismissed', acknowledged_at = now(),
 acknowledged_by = '00000000-0000-0000-0000-0000000000c8'
where tenant_id = '00000000-0000-0000-0000-0000000000b1' and alert_type = 'compliance_deadline_burning';

do $$
declare tenant constant uuid := '00000000-0000-0000-0000-0000000000b1';
 before_rows jsonb; after_rows jsonb; before_count bigint; result jsonb; correlation uuid;
begin
 select jsonb_agg(to_jsonb(a) order by id) into before_rows from public.monitoring_alerts a where tenant_id = tenant;
 select count(*) into before_count from public.audit_ledger where tenant_id = tenant;
 for pass in 1..2 loop
  correlation := gen_random_uuid();
  result := public.dispatch_monitoring_alerts(tenant, correlation);
  perform pg_temp.assert_true(result = jsonb_build_object('dispatchedCount',0,'totalUnread',0,'criticalCount',0,'highCount',0),
   'all suppressed conflicts and repeats return zero actual dispatches');
  perform pg_temp.assert_true(not exists(select 1 from public.audit_ledger where tenant_id = tenant and correlation_id = correlation),
   'no-op scan earns no false-positive dispatch receipt');
 end loop;
 perform pg_temp.assert_true((select count(*) = before_count from public.audit_ledger where tenant_id = tenant),
  'all-no-op scans append no ledger entries');
 select jsonb_agg(to_jsonb(a) order by id) into after_rows from public.monitoring_alerts a where tenant_id = tenant;
 perform pg_temp.assert_true(after_rows = before_rows, 'all suppressed alert rows remain byte-for-byte structurally unchanged');
end $$;

-- Restore active test rows for each positive branch. No production/manual
-- acknowledgement is undone: this file is one rolled-back synthetic fixture.
update public.monitoring_alerts set status = 'read', dispatched_at = now() - interval '1 day'
where tenant_id = '00000000-0000-0000-0000-0000000000b1' and alert_type in ('drift_high','schedule_overdue');
do $$
declare tenant constant uuid := '00000000-0000-0000-0000-0000000000b1';
 correlation uuid := gen_random_uuid(); before_count bigint; result jsonb; receipt public.audit_ledger;
begin
 select count(*) into before_count from public.audit_ledger where tenant_id = tenant;
 result := public.dispatch_monitoring_alerts(tenant, correlation);
 perform pg_temp.assert_true(result = jsonb_build_object('dispatchedCount',2,'totalUnread',2,'criticalCount',0,'highCount',2),
  'drift and schedule active conflicts both count real refreshes');
 perform pg_temp.assert_true((select count(*) = before_count + 1 from public.audit_ledger where tenant_id = tenant),
  'two real refreshes create exactly one dispatch receipt');
 select * into strict receipt from public.audit_ledger where tenant_id = tenant and correlation_id = correlation;
 perform pg_temp.assert_true(receipt.action_type = 'monitoring.alert.dispatched' and receipt.result = 'success'
  and receipt.detail = jsonb_build_object('dispatched_count',2,'total_unread',2,'critical_count',0,'high_count',2),
  'refresh receipt counts only the changed rows');
end $$;

-- If the required ledger append fails, both refreshes and new inserts roll
-- back with it. The new source is outside the caught subtransaction.
insert into public.drift_events(id, tenant_id, estate_id, kind, severity, summary)
values ('00000000-0000-0000-0000-0000000000d9', '00000000-0000-0000-0000-0000000000b1',
 '00000000-0000-0000-0000-0000000000e8', 'system_removed', 'critical', 'Synthetic critical removal');
update public.monitoring_alerts set dispatched_at = now() - interval '1 day'
where tenant_id = '00000000-0000-0000-0000-0000000000b1' and status = 'read';
do $$
declare tenant constant uuid := '00000000-0000-0000-0000-0000000000b1';
 before_rows jsonb; after_rows jsonb; before_count bigint; refused boolean := false;
begin
 select jsonb_agg(to_jsonb(a) order by id) into before_rows from public.monitoring_alerts a where tenant_id = tenant;
 select count(*) into before_count from public.audit_ledger where tenant_id = tenant;
 begin
  perform public.dispatch_monitoring_alerts(tenant, null);
 exception when not_null_violation then refused := true;
 end;
 perform pg_temp.assert_true(refused, 'ledger refuses a dispatch without its required correlation');
 select jsonb_agg(to_jsonb(a) order by id) into after_rows from public.monitoring_alerts a where tenant_id = tenant;
 perform pg_temp.assert_true(after_rows = before_rows, 'failed ledger append rolls back new insert and existing refreshes');
 perform pg_temp.assert_true((select count(*) = before_count from public.audit_ledger where tenant_id = tenant),
  'failed dispatch leaves the append-only ledger unchanged');
end $$;

rollback;
