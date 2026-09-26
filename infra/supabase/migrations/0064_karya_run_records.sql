-- ─────────────────────────────────────────────────────────────────────
-- 0064_karya_run_records.sql
--
-- W5.7 — progress telemetry (Revision 93): Karya's per-task pre- and
-- post-records in `agent_runs`. The executor writes them through these
-- two functions and nothing else: a run opens `running` bound to the
-- plan and action it executes, and closes once, with a bounded error
-- code and latency. The redaction hashes are computed by the caller over
-- canonical content — the table stores hashes, never payloads.
-- ─────────────────────────────────────────────────────────────────────

-- 0006 left service_role with direct UPDATE on agent_runs; every direct
-- write path is revoked here so the run lifecycle can only move through
-- the two validated functions below.
revoke all on public.agent_runs from service_role;
grant select on public.agent_runs to service_role;

create function public.record_karya_run_start(
  p_tenant_id uuid,
  p_plan_id uuid,
  p_action_id uuid,
  p_correlation_id uuid,
  p_input_redacted_hash text
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  a public.remediation_actions;
  r public.agent_runs;
begin
  if p_input_redacted_hash is null or p_input_redacted_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('error', 'invalid_record');
  end if;
  select * into a from public.remediation_actions
    where tenant_id = p_tenant_id and id = p_action_id and plan_id = p_plan_id;
  if not found then
    return jsonb_build_object('error', 'action_not_found');
  end if;
  insert into public.agent_runs(tenant_id, agent, plan_id, correlation_id, status,
    input_redacted_hash, pii_redacted, metadata)
  values (p_tenant_id, 'karya', p_plan_id, p_correlation_id, 'running',
    p_input_redacted_hash, true,
    jsonb_build_object('action_id', p_action_id))
  returning * into r;
  return jsonb_build_object('run_id', r.id);
end $$;
revoke all on function public.record_karya_run_start(uuid,uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.record_karya_run_start(uuid,uuid,uuid,uuid,text) to service_role;

create function public.record_karya_run_finish(
  p_tenant_id uuid,
  p_run_id uuid,
  p_status text,
  p_error_code text,
  p_latency_ms integer,
  p_output_redacted_hash text
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare r public.agent_runs;
begin
  if p_status not in ('succeeded', 'failed', 'cancelled')
     or (p_error_code is not null and p_error_code !~ '^[a-z0-9_]{1,80}$')
     or (p_latency_ms is not null and p_latency_ms < 0)
     or (p_output_redacted_hash is not null and p_output_redacted_hash !~ '^[0-9a-f]{64}$') then
    return jsonb_build_object('error', 'invalid_record');
  end if;
  update public.agent_runs set
      status = p_status,
      completed_at = now(),
      latency_ms = p_latency_ms,
      error = p_error_code,
      output_redacted_hash = coalesce(p_output_redacted_hash, output_redacted_hash)
    where tenant_id = p_tenant_id and id = p_run_id and status = 'running'
    returning * into r;
  if not found then
    return jsonb_build_object('error', 'run_not_running');
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.record_karya_run_finish(uuid,uuid,text,text,integer,text)
  from public, anon, authenticated;
grant execute on function public.record_karya_run_finish(uuid,uuid,text,text,integer,text) to service_role;
