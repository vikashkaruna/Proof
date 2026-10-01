-- Board requests must bind a genuinely finalized assessment, not a packet
-- whose completion timestamp or digest was merely populated. Recheck the
-- immutable controller and ledger chain at the same transaction boundary.
create function public.board_assessment_source_valid(
  p_tenant_id uuid, p_run_id uuid, p_engagement_id uuid
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  packet public.workload_assessment_packets;
  run public.agent_runs;
  task public.workload_task_delegations;
  started public.audit_ledger;
  completed public.audit_ledger;
  finalized public.audit_ledger;
begin
  -- Match the controller's task -> run -> packet lock order.
  select * into task from public.workload_task_delegations where tenant_id=p_tenant_id and run_id=p_run_id for share;
  select * into run from public.agent_runs where tenant_id=p_tenant_id and id=p_run_id for share;
  select * into packet from public.workload_assessment_packets
    where tenant_id=p_tenant_id and run_id=p_run_id and engagement_id=p_engagement_id
    for share;
  if not found or packet.completed_at is null or packet.finalized_at is null
     or packet.started_receipt is null or packet.completed_receipt is null
     or packet.finalized_receipt is null then return false; end if;

  select * into started from public.audit_ledger where tenant_id=p_tenant_id and id=packet.started_receipt;
  select * into completed from public.audit_ledger where tenant_id=p_tenant_id and id=packet.completed_receipt;
  select * into finalized from public.audit_ledger where tenant_id=p_tenant_id and id=packet.finalized_receipt;

  return coalesce(
    task.agent_name='parikshan' and task.engagement_id=p_engagement_id
    and run.agent='parikshan' and run.engagement_id=p_engagement_id
    and run.status='succeeded' and run.error is null
    and run.correlation_id=task.correlation_id
    and run.input_redacted_hash=task.input_hash
    and run.completed_at=packet.completed_at
    and run.output_redacted_hash=packet.result_digest
    and packet.library_digest=encode(sha256(convert_to(packet.controls::text,'UTF8')),'hex')
    and packet.result_digest=encode(sha256(convert_to(packet.result::text,'UTF8')),'hex')
    and packet.result->>'library_version'=packet.library_version
    and started.id<>completed.id and completed.id<>finalized.id
    and started.id<>finalized.id
    and started.action_type='assessment.started' and started.result='pending'
    and completed.action_type='assessment.scored' and completed.result='success'
    and finalized.action_type='workload.task_completed' and finalized.result='success'
    and started.actor_type='agent' and started.actor_id='parikshan'
    and completed.actor_type='agent' and completed.actor_id='parikshan'
    and finalized.actor_type='system' and finalized.actor_id='assessment-controller'
    and started.correlation_id=task.correlation_id
    and completed.correlation_id=task.correlation_id
    and finalized.correlation_id=task.correlation_id
    and started.target_ref=p_engagement_id::text
    and completed.target_ref=p_engagement_id::text
    and finalized.target_ref=p_run_id::text
    and started.input_hash=task.input_hash
    and completed.input_hash=task.input_hash
    and finalized.input_hash=task.input_hash
    and completed.output_hash=packet.result_digest
    and finalized.output_hash=packet.result_digest
    and started.detail->>'run_id'=p_run_id::text
    and completed.detail->>'run_id'=p_run_id::text
    and started.detail->>'workload_id'=task.workload_identity_id::text
    and completed.detail->>'workload_id'=task.workload_identity_id::text
    and started.detail->>'library_digest'=packet.library_digest
    and completed.detail->>'library_digest'=packet.library_digest,
    false
  );
end $$;

revoke all on function public.board_assessment_source_valid(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.board_assessment_source_valid(uuid,uuid,uuid) to service_role;


-- Preserve the existing idempotency and ledger contract while requiring
-- the read-only provenance check before a new or replayed request.
create or replace function public.request_board_report(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_operation_key uuid,
  p_engagement_id uuid,
  p_assessment_run_id uuid,
  p_title text,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_req public.board_report_requests;
  v_pkt public.workload_assessment_packets;
begin
  if not public.evidence_manager_allowed(p_tenant_id, p_actor_id) then
    return jsonb_build_object('error', 'forbidden');
  end if;

  if p_operation_key is null or p_correlation_id is null or p_engagement_id is null
     or p_assessment_run_id is null or p_title is null
     or length(btrim(p_title)) not between 1 and 300 then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  select * into v_pkt from public.workload_assessment_packets
   where tenant_id = p_tenant_id
     and run_id = p_assessment_run_id
     and engagement_id = p_engagement_id;

  if not found then
    return jsonb_build_object('error', 'assessment_not_found');
  end if;

  if not public.board_assessment_source_valid(p_tenant_id, p_assessment_run_id, p_engagement_id) then
    return jsonb_build_object('error', 'assessment_not_finalized');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || p_operation_key::text, 0));

  select * into v_req from public.board_report_requests
   where tenant_id = p_tenant_id and operation_key = p_operation_key for update;

  if found then
    if v_req.requested_by is distinct from p_actor_id
       or v_req.engagement_id is distinct from p_engagement_id
       or v_req.assessment_run_id is distinct from p_assessment_run_id
       or v_req.title is distinct from btrim(p_title) then
      return jsonb_build_object('error', 'idempotency_conflict');
    end if;
    return jsonb_build_object(
      'requestId', v_req.id,
      'status', v_req.status,
      'reportId', v_req.report_id,
      'replayed', true
    );
  end if;

  insert into public.board_report_requests (
    tenant_id, engagement_id, assessment_run_id, operation_key,
    requested_by, title, status, assessment_result_digest,
    library_version, library_digest
  ) values (
    p_tenant_id, p_engagement_id, p_assessment_run_id, p_operation_key,
    p_actor_id, btrim(p_title), 'requested', v_pkt.result_digest,
    v_pkt.library_version, v_pkt.library_digest
  ) returning * into v_req;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_actor_id::text, null, null, null,
    'report.requested'::public.ledger_action_type, v_req.id::text,
    null, null, null, null, null, null, 'success',
    jsonb_build_object(
      'assessment_run_id', p_assessment_run_id,
      'result_digest', v_pkt.result_digest,
      'library_version', v_pkt.library_version
    )
  );

  return jsonb_build_object(
    'requestId', v_req.id,
    'status', 'requested',
    'reportId', null,
    'replayed', false
  );
end $$;


-- Draft creation rechecks provenance and records the actual deterministic
-- BFF renderer as producer; it must not impersonate Prativedan.
create or replace function public.record_board_report_draft(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_request_id uuid,
  p_content_text text,
  p_html_text text,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_req public.board_report_requests;
  v_report public.reports;
  v_content jsonb;
  v_content_hash text;
  v_html_hash text;
begin
  if not public.report_founder_allowed(p_tenant_id, p_actor_id) then
    return jsonb_build_object('error', 'founder_authority_required');
  end if;

  if p_request_id is null or p_correlation_id is null or p_content_text is null
     or octet_length(p_content_text) > 5242880 or p_html_text is null
     or octet_length(p_html_text) > 5242880 then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  begin
    v_content := p_content_text::jsonb;
  exception when invalid_text_representation then
    return jsonb_build_object('error', 'invalid_request');
  end;

  if jsonb_typeof(v_content) is distinct from 'object' then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  select * into v_req from public.board_report_requests
   where tenant_id = p_tenant_id and id = p_request_id;

  if not found then
    return jsonb_build_object('error', 'request_not_found');
  end if;

  if not public.board_assessment_source_valid(p_tenant_id, v_req.assessment_run_id, v_req.engagement_id) then
    return jsonb_build_object('error', 'assessment_not_finalized');
  end if;

  select * into v_req from public.board_report_requests
   where tenant_id = p_tenant_id and id = p_request_id for update;
  if not found then
    return jsonb_build_object('error', 'request_not_found');
  end if;

  if v_req.status not in ('requested', 'drafted') then
    return jsonb_build_object('error', 'invalid_request_state');
  end if;

  v_content_hash := encode(sha256(convert_to(p_content_text, 'UTF8')), 'hex');
  v_html_hash := encode(sha256(convert_to(p_html_text, 'UTF8')), 'hex');

  if v_req.report_id is not null then
    select * into v_report from public.reports
     where tenant_id = p_tenant_id and id = v_req.report_id for update;
    if found and v_report.content_sha256 = v_content_hash then
      return jsonb_build_object(
        'reportId', v_report.id,
        'requestId', v_req.id,
        'status', v_report.status,
        'contentHash', v_content_hash,
        'replayed', true
      );
    end if;
  end if;

  insert into public.reports (
    tenant_id, engagement_id, kind, title, storage_uri, content,
    library_version, generated_by_agent, operation_key, created_by,
    content_text, content_sha256
  ) values (
    p_tenant_id, v_req.engagement_id, 'board'::public.report_kind, v_req.title, null, v_content,
    v_req.library_version, 'board-report-builder', v_req.operation_key, p_actor_id,
    p_content_text, v_content_hash
  ) returning * into v_report;

  insert into public.board_report_artifacts (
    tenant_id, report_id, source_json_sha256, source_json_bytes,
    html_sha256, html_bytes
  ) values (
    p_tenant_id, v_report.id, v_content_hash, octet_length(p_content_text),
    v_html_hash, octet_length(p_html_text)
  );

  update public.board_report_requests
     set report_id = v_report.id,
         status = 'drafted',
         updated_at = clock_timestamp()
   where tenant_id = p_tenant_id and id = v_req.id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'system', 'board-report-builder', null, null, null,
    'report.drafted'::public.ledger_action_type, v_report.id::text,
    null, null, null, null, null, null, 'success',
    jsonb_build_object(
      'request_id', v_req.id,
      'content_hash', v_content_hash,
      'html_hash', v_html_hash
    )
  );

  return jsonb_build_object(
    'reportId', v_report.id,
    'requestId', v_req.id,
    'status', 'draft',
    'contentHash', v_content_hash,
    'replayed', false
  );
end $$;
