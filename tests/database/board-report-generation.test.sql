-- Real DB authority, finalized assessment binding, founder draft & release gate for board reports.
begin;
create function pg_temp.ok(v boolean, m text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'ASSERTION FAILED: %', m; end if; end $$;

insert into auth.users(id, email)
  select ('99750000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'board-' || n || '@example.invalid'
  from generate_series(1, 5) n;

insert into public.users(id, email, full_name, is_axiom_internal)
  values
  ('99750000-0000-4000-8000-000000000001', 'board-1@example.invalid', 'Manager User', false),
  ('99750000-0000-4000-8000-000000000002', 'board-2@example.invalid', 'Internal Founder', true),
  ('99750000-0000-4000-8000-000000000003', 'board-3@example.invalid', 'External Founder', false),
  ('99750000-0000-4000-8000-000000000004', 'board-4@example.invalid', 'Viewer User', false),
  ('99750000-0000-4000-8000-000000000005', 'board-5@example.invalid', 'Foreign Tenant User', false);

insert into public.tenants(id, slug, name)
  values
  ('99750000-0000-4000-8000-000000000010', 'board-tenant-a', 'Board Tenant A'),
  ('99750000-0000-4000-8000-000000000020', 'board-tenant-b', 'Board Tenant B');

insert into public.tenant_users(tenant_id, user_id, role)
  values
  ('99750000-0000-4000-8000-000000000010', '99750000-0000-4000-8000-000000000001', 'admin'),
  ('99750000-0000-4000-8000-000000000010', '99750000-0000-4000-8000-000000000002', 'founder'),
  ('99750000-0000-4000-8000-000000000010', '99750000-0000-4000-8000-000000000003', 'founder'),
  ('99750000-0000-4000-8000-000000000010', '99750000-0000-4000-8000-000000000004', 'viewer'),
  ('99750000-0000-4000-8000-000000000020', '99750000-0000-4000-8000-000000000005', 'admin');

insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('board-test-lib', now(), 'fixture', 'synthetic', 1);

insert into public.controls(id, library_version, title, obligation, domain, severity, citations, evidence_required, assessment_questions, scoring, remediation_patterns, introduced_in_version)
  values ('BOARD-001', 'board-test-lib', 'Synthetic control', 'Fixture only', 'GOV', 'low', '[]', '[]', '[]', '{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":1000000}', '{}', 'board-test-lib');

insert into public.estates(id, tenant_id, name, slug)
  values ('99750000-0000-4000-8000-000000000050', '99750000-0000-4000-8000-000000000010', 'Board estate', 'board-estate');

insert into public.engagements(id, tenant_id, estate_id, library_version, title)
  values
  ('99750000-0000-4000-8000-000000000030', '99750000-0000-4000-8000-000000000010', '99750000-0000-4000-8000-000000000050', 'board-test-lib', 'Board Engagement');

insert into public.workload_identities(id, tenant_id, agent_name, spiffe_id, status)
  values ('99750000-0000-4000-8000-000000000041', '99750000-0000-4000-8000-000000000010', 'parikshan', 'spiffe://axiom.test/parikshan', 'active');

-- Produce an assessment through the real worker/confirmation RPC chain.
create temporary table board_issued as
select (public.delegate_workload_task(
  '99750000-0000-4000-8000-000000000010',
  '99750000-0000-4000-8000-000000000001',
  '99750000-0000-4000-8000-000000000041', 'parikshan',
  '99750000-0000-4000-8000-000000000050',
  '99750000-0000-4000-8000-000000000030', gen_random_uuid(),
  repeat('a',64), repeat('b',64),
  array['control_library.read','findings.write'], clock_timestamp()+interval '10 minutes'
)->>'run_id')::uuid run_id;
grant select on board_issued to service_role;

select public.start_workload_assessment(
  '99750000-0000-4000-8000-000000000010', (select run_id from board_issued),
  '99750000-0000-4000-8000-000000000041', repeat('b',64), repeat('a',64),
  clock_timestamp()+interval '5 minutes');
select public.complete_workload_assessment(
  '99750000-0000-4000-8000-000000000010', (select run_id from board_issued),
  '99750000-0000-4000-8000-000000000041', repeat('b',64),
  (select library_digest from public.workload_assessment_packets where run_id=(select run_id from board_issued)),
  '{"library_version":"board-test-lib","posture_score":85,"estimated_exposure_inr":1000000,"findings":[{"control_id":"BOARD-001","score":85,"risk_points":0,"rationale":"Synthetic fixture"}]}'::jsonb,
  clock_timestamp()+interval '5 minutes');

-- Test 1: Manager requests board report
set local role service_role;
do $$
declare
  t uuid := '99750000-0000-4000-8000-000000000010';
  m uuid := '99750000-0000-4000-8000-000000000001';
  eng uuid := '99750000-0000-4000-8000-000000000030';
  run uuid := (select run_id from board_issued);
  op uuid := gen_random_uuid();
  res jsonb;
  req_id uuid;
begin
  res := public.request_board_report(t, m, op, eng, run, 'Q3 Board Report', gen_random_uuid());
  perform pg_temp.ok(res->>'error' = 'assessment_not_finalized', 'completed packet without controller finalization refuses request');
  perform pg_temp.ok((select count(*)=0 from public.board_report_requests), 'unfinalized refusal creates no request');

  res := public.confirm_workload_assessment(t, run);
  perform pg_temp.ok(res->>'status'='succeeded', 'controller finalizes real assessment');

  res := public.request_board_report(t, m, op, eng, run, 'Q3 Board Report', gen_random_uuid());
  perform pg_temp.ok(res->>'status' = 'requested', 'request_board_report returns requested status');
  req_id := (res->>'requestId')::uuid;
  perform pg_temp.ok(exists (
    select 1 from public.board_request_sources s
    join public.workload_assessment_packets p on p.tenant_id=s.tenant_id
      and p.run_id=run
    where s.tenant_id=t and s.request_id=req_id
      and s.source_sha256=encode(sha256(convert_to(s.source_text,'UTF8')),'hex')
      and s.controls_sha256=p.library_digest
      and s.result_sha256=p.result_digest
      and s.source_text::jsonb->>'controls_text'=p.controls::text
      and s.source_text::jsonb->>'result_text'=p.result::text
  ), 'request freezes exact finalized controls and result text');
  perform pg_temp.ok(
    not has_table_privilege('service_role','public.board_request_sources','INSERT')
    and not has_table_privilege('service_role','public.board_request_sources','UPDATE')
    and not has_table_privilege('authenticated','public.board_request_sources','SELECT'),
    'frozen source has no direct client read or service write path');

  -- Replay with same op key is idempotent
  res := public.request_board_report(t, m, op, eng, run, 'Q3 Board Report', gen_random_uuid());
  perform pg_temp.ok(res->>'replayed' = 'true', 'idempotent request replays clean');
  perform pg_temp.ok((select count(*)=1 from public.board_request_sources where request_id=req_id),
    'replay does not replace or duplicate source snapshot');

  -- Viewer cannot request
  res := public.request_board_report(t, '99750000-0000-4000-8000-000000000004'::uuid, gen_random_uuid(), eng, run, 'Unauthorized', gen_random_uuid());
  perform pg_temp.ok(res->>'error' = 'forbidden', 'viewer denied request_board_report');
end $$;

-- A replay must not conceal subsequent source tampering; the current packet
-- and receipt chain are checked before idempotency returns the old request.
reset role;
savepoint board_changed_result;
update public.workload_assessment_packets
  set result=jsonb_set(result, '{posture_score}', '12'::jsonb)
  where run_id=(select run_id from board_issued);
set local role service_role;
select pg_temp.ok(
  public.request_board_report(
    '99750000-0000-4000-8000-000000000010',
    '99750000-0000-4000-8000-000000000001', gen_random_uuid(),
    '99750000-0000-4000-8000-000000000030',
    (select run_id from board_issued), 'Tampered', gen_random_uuid()
  )->>'error'='assessment_not_finalized',
  'changed result digest refuses a new request');
rollback to board_changed_result;

savepoint board_changed_receipt;
update public.workload_assessment_packets
  set finalized_receipt=completed_receipt
  where run_id=(select run_id from board_issued);
set local role service_role;
select pg_temp.ok(
  public.request_board_report(
    '99750000-0000-4000-8000-000000000010',
    '99750000-0000-4000-8000-000000000001', gen_random_uuid(),
    '99750000-0000-4000-8000-000000000030',
    (select run_id from board_issued), 'Tampered', gen_random_uuid()
  )->>'error'='assessment_not_finalized',
  'substituted finalized receipt refuses a new request');
rollback to board_changed_receipt;
set local role service_role;

-- Test 2: Internal founder records draft
do $$
declare
  t uuid := '99750000-0000-4000-8000-000000000010';
  f_internal uuid := '99750000-0000-4000-8000-000000000002';
  f_external uuid := '99750000-0000-4000-8000-000000000003';
  req_id uuid;
  res jsonb;
  rep_id uuid;
  content text := '{"schema_version":1,"kind":"board_report","title":"Q3 Board Report","executive_summary":{"score":85}}';
  html text := '<html><body><h1>Q3 Board Report</h1></body></html>';
begin
  select id into req_id from public.board_report_requests where tenant_id = t;
  content := (content::jsonb || jsonb_build_object(
    'source_sha256', (select source_sha256 from public.board_request_sources where request_id=req_id),
    'assessment_run_id', (select assessment_run_id from public.board_report_requests where id=req_id),
    'assessment_result_digest', (select assessment_result_digest from public.board_report_requests where id=req_id),
    'library_digest', (select library_digest from public.board_report_requests where id=req_id)
  ))::text;

  -- External founder denied
  res := public.record_board_report_draft(t, f_external, req_id, content, html, gen_random_uuid());
  perform pg_temp.ok(res->>'error' = 'founder_authority_required', 'external founder cannot record draft');

  begin
    perform public.record_board_report_draft(
      t, f_internal, req_id,
      (content::jsonb || jsonb_build_object('source_sha256', repeat('0',64)))::text,
      html, gen_random_uuid());
    raise exception 'ASSERTION FAILED: mismatched source digest was accepted';
  exception when others then
    if sqlerrm <> 'board draft source binding mismatch' then raise; end if;
  end;
  perform pg_temp.ok((select count(*)=0 from public.reports where tenant_id=t and kind='board'),
    'mismatched source leaves no draft behind');

  -- Internal founder succeeds
  res := public.record_board_report_draft(t, f_internal, req_id, content, html, gen_random_uuid());
  perform pg_temp.ok(res->>'status' = 'draft', 'internal founder records draft');
  rep_id := (res->>'reportId')::uuid;
  perform pg_temp.ok((select generated_by_agent='board-report-builder' from public.reports where id=rep_id),
    'draft attributes actual deterministic renderer');
  perform pg_temp.ok(exists(select 1 from public.audit_ledger where tenant_id=t
    and action_type='report.drafted' and target_ref=rep_id::text
    and actor_type='system' and actor_id='board-report-builder'),
    'draft ledger attributes actual deterministic renderer');

  -- Artifacts attached
  perform pg_temp.ok(exists (
    select 1 from public.board_report_artifacts a
    join public.board_request_sources s on s.tenant_id=a.tenant_id and s.request_id=req_id
    where a.tenant_id = t and a.report_id = rep_id
      and a.source_json_sha256=s.source_sha256
      and a.source_json_bytes=octet_length(s.source_text)
  ), 'draft metadata binds the exact frozen source, without claiming a vault receipt');
end $$;

reset role;
savepoint board_draft_changed_source;
update public.workload_assessment_packets
  set result=jsonb_set(result, '{posture_score}', '12'::jsonb)
  where run_id=(select run_id from board_issued);
set local role service_role;
select pg_temp.ok(
  public.record_board_report_draft(
    '99750000-0000-4000-8000-000000000010',
    '99750000-0000-4000-8000-000000000002',
    (select id from public.board_report_requests where tenant_id='99750000-0000-4000-8000-000000000010'),
    '{"schema_version":1,"kind":"board_report","title":"Q3 Board Report","executive_summary":{"score":85}}',
    '<html><body><h1>Q3 Board Report</h1></body></html>', gen_random_uuid()
  )->>'error'='assessment_not_finalized',
  'changed source refuses draft replay');
rollback to board_draft_changed_source;
set local role service_role;

-- Test 3: Review and release
do $$
declare
  t uuid := '99750000-0000-4000-8000-000000000010';
  f_internal uuid := '99750000-0000-4000-8000-000000000002';
  rep_id uuid;
  h text;
  res jsonb;
begin
  select id, content_sha256 into rep_id, h from public.reports where tenant_id = t and kind = 'board';

  -- Review approval
  res := public.review_report(t, rep_id, 'approved', 'Board report approved by founder', f_internal, h, gen_random_uuid());
  perform pg_temp.ok(res->>'status' = 'approved', 'review_report succeeds');

  -- A fabricated object key/version is no longer a permitted service write.
  perform pg_temp.ok(
    not has_function_privilege('service_role',
      'public.attach_board_report_pdf(uuid,uuid,uuid,text,bigint,text,text,text,text,timestamptz)',
      'EXECUTE'),
    'unverified PDF attachment function is unavailable to the service role');

  -- Release report
  res := public.release_report(t, rep_id, f_internal, h, null, gen_random_uuid());
  perform pg_temp.ok(res->>'error' = 'report_artifact_unverified', 'unverified board PDF metadata cannot publish a report');
end $$;

rollback;
