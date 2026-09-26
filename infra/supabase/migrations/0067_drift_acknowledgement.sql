-- ─────────────────────────────────────────────────────────────────────
-- 0067_drift_acknowledgement.sql
--
-- W6 · monitoring-the-monitoring (Revision 96).
--
-- `acknowledge_drift_event` is the human's write path onto a detection:
-- an operator records that they have seen and judged a drift event. The
-- table's check constraint keeps `acknowledged_by` and `acknowledged_at`
-- together; this function keeps them bound to a real event and a real
-- user, and ledgeres the acknowledgement so the monitoring story —
-- what fired, what it found, who judged it — is reconstructable.
-- ─────────────────────────────────────────────────────────────────────

alter type public.ledger_action_type add value if not exists 'monitoring.drift.acknowledged';

create function public.acknowledge_drift_event(
  p_tenant_id uuid,
  p_event_id uuid,
  p_acknowledged_by uuid,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare r public.drift_events;
begin
  if p_acknowledged_by is null
     or not exists (select 1 from public.users where id = p_acknowledged_by) then
    return jsonb_build_object('error', 'invalid_record');
  end if;

  select * into r from public.drift_events
    where tenant_id = p_tenant_id and id = p_event_id for update;
  if not found then
    return jsonb_build_object('error', 'event_not_found');
  end if;
  if r.acknowledged_at is not null then
    return jsonb_build_object('error', 'already_acknowledged');
  end if;

  update public.drift_events
     set acknowledged_by = p_acknowledged_by, acknowledged_at = now()
   where tenant_id = p_tenant_id and id = r.id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_acknowledged_by::text, null, null, null,
    'monitoring.drift.acknowledged', r.id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('drift_event_id', r.id, 'estate_id', r.estate_id,
      'kind', r.kind, 'severity', r.severity));

  return jsonb_build_object('acknowledged', true, 'acknowledgedBy', p_acknowledged_by::text);
end $$;
revoke all on function public.acknowledge_drift_event(uuid,uuid,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.acknowledge_drift_event(uuid,uuid,uuid,uuid)
  to service_role;
