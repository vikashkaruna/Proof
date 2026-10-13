-- Count inserted/refreshed alerts, not scanned sources. A conflict against a
-- dismissed/acknowledged alert changes no row and must earn no dispatch receipt.
-- CREATE OR REPLACE preserves the existing owner and EXECUTE grants, including
-- the established service-role dispatch and separate human dismissal boundary.
create or replace function public.dispatch_monitoring_alerts(
  p_tenant_id uuid,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_dispatched_count integer := 0;
  v_critical_count integer := 0;
  v_high_count integer := 0;
  v_unread_count integer := 0;
  v_alert record;
  v_affected_count integer;
begin
  if not exists (select 1 from public.tenants where id = p_tenant_id) then
    return jsonb_build_object('error', 'tenant_not_found');
  end if;

  -- 1. Scan critical and high unacknowledged drift events
  for v_alert in (
    select
      d.id::text as src_id,
      'drift_event' as src_type,
      case when d.severity = 'critical' then 'drift_critical' else 'drift_high' end as a_type,
      d.severity as a_sev,
      case when d.severity = 'critical' then 'Critical Configuration Drift: ' || d.kind
           else 'High Severity Configuration Drift: ' || d.kind end as a_title,
      substring(d.summary from 1 for 500) as a_summary,
      jsonb_build_object(
        'estate_id', d.estate_id,
        'drift_kind', d.kind,
        'severity', d.severity,
        'detected_at', d.detected_at
      ) as a_meta
    from public.drift_events d
    where d.tenant_id = p_tenant_id
      and d.acknowledged_at is null
      and d.severity in ('critical', 'high')
  ) loop
    insert into public.monitoring_alerts (
      tenant_id, alert_type, severity, title, summary, source_id, source_type, status, dispatched_at, metadata
    ) values (
      p_tenant_id, v_alert.a_type, v_alert.a_sev, v_alert.a_title, v_alert.a_summary,
      v_alert.src_id, v_alert.src_type, 'unread', now(), v_alert.a_meta
    )
    on conflict (tenant_id, alert_type, source_id) do update
      set dispatched_at = now()
      where monitoring_alerts.status in ('unread', 'read');
    get diagnostics v_affected_count = row_count;
    v_dispatched_count := v_dispatched_count + v_affected_count;
  end loop;

  -- 2. Scan overdue active monitoring schedules
  for v_alert in (
    select
      s.id::text as src_id,
      'monitoring_schedule' as src_type,
      'schedule_overdue' as a_type,
      'high' as a_sev,
      'Overdue Monitoring Schedule: ' || s.name as a_title,
      'Schedule ' || s.name || ' (' || s.kind || ') missed run scheduled for ' || s.next_run_at::text as a_summary,
      jsonb_build_object(
        'estate_id', s.estate_id,
        'schedule_kind', s.kind,
        'cadence', s.cadence,
        'next_run_at', s.next_run_at
      ) as a_meta
    from public.monitoring_schedules s
    where s.tenant_id = p_tenant_id
      and s.status = 'active'
      and s.next_run_at < now()
  ) loop
    insert into public.monitoring_alerts (
      tenant_id, alert_type, severity, title, summary, source_id, source_type, status, dispatched_at, metadata
    ) values (
      p_tenant_id, v_alert.a_type, v_alert.a_sev, v_alert.a_title, v_alert.a_summary,
      v_alert.src_id, v_alert.src_type, 'unread', now(), v_alert.a_meta
    )
    on conflict (tenant_id, alert_type, source_id) do update
      set dispatched_at = now()
      where monitoring_alerts.status in ('unread', 'read');
    get diagnostics v_affected_count = row_count;
    v_dispatched_count := v_dispatched_count + v_affected_count;
  end loop;

  -- 3. Scan compliance events burning (< 24 hours) or breached (< now)
  for v_alert in (
    select
      c.id::text as src_id,
      'compliance_event' as src_type,
      case when c.due_at < now() then 'compliance_deadline_breached' else 'compliance_deadline_burning' end as a_type,
      case when c.due_at < now() then 'critical' else 'high' end as a_sev,
      case when c.due_at < now() then 'Statutory Deadline Breached: ' || c.title
           else 'Statutory Deadline Burning: ' || c.title end as a_title,
      coalesce(substring(c.description from 1 for 500), c.title) as a_summary,
      jsonb_build_object(
        'due_at', c.due_at,
        'dsar_id', c.dsar_id,
        'breach_id', c.breach_id,
        'control_id', c.control_id
      ) as a_meta
    from public.compliance_events c
    where c.tenant_id = p_tenant_id
      and c.status = 'open'
      and c.due_at < now() + interval '24 hours'
  ) loop
    insert into public.monitoring_alerts (
      tenant_id, alert_type, severity, title, summary, source_id, source_type, status, dispatched_at, metadata
    ) values (
      p_tenant_id, v_alert.a_type, v_alert.a_sev, v_alert.a_title, v_alert.a_summary,
      v_alert.src_id, v_alert.src_type, 'unread', now(), v_alert.a_meta
    )
    on conflict (tenant_id, alert_type, source_id) do update
      set dispatched_at = now()
      where monitoring_alerts.status in ('unread', 'read');
    get diagnostics v_affected_count = row_count;
    v_dispatched_count := v_dispatched_count + v_affected_count;
  end loop;

  select count(*) into v_unread_count
    from public.monitoring_alerts
   where tenant_id = p_tenant_id and status in ('unread', 'read');

  select count(*) into v_critical_count
    from public.monitoring_alerts
   where tenant_id = p_tenant_id and status in ('unread', 'read') and severity = 'critical';

  select count(*) into v_high_count
    from public.monitoring_alerts
   where tenant_id = p_tenant_id and status in ('unread', 'read') and severity = 'high';

  if v_dispatched_count > 0 then
    perform public.append_ledger(
      p_tenant_id, p_correlation_id, 'system', 'nazar', null, null, null,
      'monitoring.alert.dispatched', p_tenant_id::text, null, null, null, null, null, null, 'success',
      jsonb_build_object(
        'dispatched_count', v_dispatched_count,
        'critical_count', v_critical_count,
        'high_count', v_high_count,
        'total_unread', v_unread_count
      )
    );
  end if;

  return jsonb_build_object(
    'dispatchedCount', v_dispatched_count,
    'totalUnread', v_unread_count,
    'criticalCount', v_critical_count,
    'highCount', v_high_count
  );
end $$;

