-- ─────────────────────────────────────────────────────────────────────
-- 0066_scheduler_write_paths.sql
--
-- W6 · Continuous compliance, scheduler slice (Revision 95).
--
-- `record_drift_event` — the only write path into drift_events. Detections
-- are bounded, identifier-shaped facts: what changed, by name; severity
-- is a closed set. Acknowledgement happens later, by a human, through a
-- future route — the table's check constraint keeps the two columns
-- together.
--
-- `record_schedule_run` — the scheduler's bookkeeping: advances a
-- schedule's last_run_at and next_run_at in one validated transaction,
-- refusing anything but an active schedule and a next fire in the
-- future. A scheduler that cannot compute its next fire does not fire.
-- ─────────────────────────────────────────────────────────────────────

alter type public.ledger_action_type add value if not exists 'monitoring.drift.detected';
alter type public.ledger_action_type add value if not exists 'monitoring.schedule.fired';

create function public.record_drift_event(
  p_tenant_id uuid,
  p_estate_id uuid,
  p_kind text,
  p_severity text,
  p_summary text,
  p_source_ref text,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  r public.drift_events;
begin
  if p_kind not in ('system_added', 'system_removed', 'system_changed', 'connection_lost', 'control_drift')
     or p_severity not in ('low', 'medium', 'high', 'critical')
     or p_summary is null or length(p_summary) = 0 or length(p_summary) > 300
     or (p_source_ref is not null and (length(p_source_ref) = 0 or length(p_source_ref) > 200
        or p_source_ref !~ '^[A-Za-z0-9._:/-]+$'))
     or p_correlation_id is null then
    return jsonb_build_object('error', 'invalid_event');
  end if;
  if not exists (select 1 from public.estates
                  where tenant_id = p_tenant_id and id = p_estate_id) then
    return jsonb_build_object('error', 'estate_not_found');
  end if;

  insert into public.drift_events(tenant_id, estate_id, kind, severity, summary, source_ref)
  values (p_tenant_id, p_estate_id, p_kind, p_severity, p_summary, p_source_ref)
  returning * into r;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'agent', 'nazar', null, null, null,
    'monitoring.drift.detected', p_estate_id::text, null, null, null, null, null, null,
    (case when p_severity in ('high', 'critical') then 'failure' else 'success' end)::public.ledger_result,
    jsonb_build_object('drift_event_id', r.id, 'kind', p_kind, 'severity', p_severity,
      'summary', p_summary));

  return jsonb_build_object('driftEvent', jsonb_build_object(
    'id', r.id, 'kind', r.kind, 'severity', r.severity, 'detectedAt', r.detected_at));
end $$;
revoke all on function public.record_drift_event(uuid,uuid,text,text,text,text,uuid)
  from public, anon, authenticated;
grant execute on function public.record_drift_event(uuid,uuid,text,text,text,text,uuid)
  to service_role;

create function public.record_schedule_run(
  p_tenant_id uuid,
  p_schedule_id uuid,
  p_next_run_at timestamptz,
  p_outcome text,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare s public.monitoring_schedules;
begin
  if p_outcome not in ('drift_detected', 'no_drift', 'no_baseline', 'failed')
     or p_next_run_at is null or p_next_run_at <= now() then
    return jsonb_build_object('error', 'invalid_run');
  end if;

  select * into s from public.monitoring_schedules
    where tenant_id = p_tenant_id and id = p_schedule_id for update;
  if not found then
    return jsonb_build_object('error', 'schedule_not_found');
  end if;
  if s.status <> 'active' then
    return jsonb_build_object('error', 'schedule_not_active');
  end if;

  update public.monitoring_schedules
     set last_run_at = now(), next_run_at = p_next_run_at, updated_at = now()
   where tenant_id = p_tenant_id and id = s.id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'agent', 'nazar', null, null, null,
    'monitoring.schedule.fired', s.id::text, null, null, null, null, null, null,
    (case when p_outcome = 'failed' then 'failure' else 'success' end)::public.ledger_result,
    jsonb_build_object('schedule_id', s.id, 'kind', s.kind, 'estate_id', s.estate_id,
      'outcome', p_outcome, 'next_run_at', p_next_run_at));

  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.record_schedule_run(uuid,uuid,timestamptz,text,uuid)
  from public, anon, authenticated;
grant execute on function public.record_schedule_run(uuid,uuid,timestamptz,text,uuid)
  to service_role;
