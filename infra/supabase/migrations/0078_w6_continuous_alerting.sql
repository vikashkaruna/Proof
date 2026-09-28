-- ─────────────────────────────────────────────────────────────────────
-- 0078_w6_continuous_alerting.sql
--
-- W6 · Continuous alerting & monitoring surface (Revision 105).
--
-- Provides tenant-scoped monitoring alert records and dispatch functions
-- for unacknowledged critical/high configuration drift events, overdue
-- monitoring schedules, and burning/breached statutory compliance deadlines.
-- ─────────────────────────────────────────────────────────────────────

alter type public.ledger_action_type add value if not exists 'monitoring.alert.dispatched';
alter type public.ledger_action_type add value if not exists 'monitoring.alert.dismissed';

create table public.monitoring_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  alert_type text not null check (alert_type in (
    'drift_critical', 'drift_high', 'schedule_overdue',
    'compliance_deadline_burning', 'compliance_deadline_breached'
  )),
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  title text not null check (length(title) between 1 and 200),
  summary text not null check (length(summary) between 1 and 500),
  source_id text not null check (length(source_id) between 1 and 100),
  source_type text not null check (source_type in (
    'drift_event', 'monitoring_schedule', 'compliance_event', 'breach', 'dsar'
  )),
  status text not null default 'unread' check (status in ('unread', 'read', 'dismissed', 'acknowledged')),
  dispatched_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid references public.users(id),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, alert_type, source_id),
  foreign key (tenant_id) references public.tenants(id) on delete cascade
);

create index monitoring_alerts_tenant_status on public.monitoring_alerts(tenant_id, status, created_at desc);
create index monitoring_alerts_tenant_severity on public.monitoring_alerts(tenant_id, severity, status);

alter table public.monitoring_alerts enable row level security;
revoke all on public.monitoring_alerts from public, anon, authenticated, service_role;
grant select, insert, update on public.monitoring_alerts to service_role;
grant select on public.monitoring_alerts to authenticated;

create policy bff_service_all on public.monitoring_alerts for all to service_role using (true) with check (true);
create policy tenant_member_read on public.monitoring_alerts for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- ─── Alert dispatch function ─────────────────────────────────────────

create function public.dispatch_monitoring_alerts(
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
    v_dispatched_count := v_dispatched_count + 1;
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
    v_dispatched_count := v_dispatched_count + 1;
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
    v_dispatched_count := v_dispatched_count + 1;
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

revoke all on function public.dispatch_monitoring_alerts(uuid, uuid) from public, anon, authenticated;
grant execute on function public.dispatch_monitoring_alerts(uuid, uuid) to service_role;

-- ─── Alert dismissal function ────────────────────────────────────────

create function public.dismiss_monitoring_alert(
  p_tenant_id uuid,
  p_alert_id uuid,
  p_user_id uuid,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_alert public.monitoring_alerts;
begin
  if p_user_id is null or not exists (select 1 from public.users where id = p_user_id) then
    return jsonb_build_object('error', 'invalid_user');
  end if;

  select * into v_alert from public.monitoring_alerts
   where tenant_id = p_tenant_id and id = p_alert_id for update;
  if not found then
    return jsonb_build_object('error', 'alert_not_found');
  end if;

  if v_alert.status = 'dismissed' then
    return jsonb_build_object('error', 'already_dismissed');
  end if;

  update public.monitoring_alerts
     set status = 'dismissed', acknowledged_at = now(), acknowledged_by = p_user_id
   where tenant_id = p_tenant_id and id = p_alert_id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_user_id::text, null, null, null,
    'monitoring.alert.dismissed', p_alert_id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object(
      'alert_id', p_alert_id,
      'alert_type', v_alert.alert_type,
      'severity', v_alert.severity,
      'source_id', v_alert.source_id,
      'source_type', v_alert.source_type
    )
  );

  return jsonb_build_object(
    'dismissed', true,
    'alertId', p_alert_id::text,
    'acknowledgedBy', p_user_id::text
  );
end $$;

revoke all on function public.dismiss_monitoring_alert(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.dismiss_monitoring_alert(uuid, uuid, uuid, uuid) to service_role;
