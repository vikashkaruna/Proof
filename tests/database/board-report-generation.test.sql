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
  values ('BOARD-001', 'board-test-lib', 'Synthetic control', 'Fixture only', 'GOV', 'low', '[]', '[]', '[]', '{}', '{}', 'board-test-lib');

insert into public.engagements(id, tenant_id, library_version, title)
  values
  ('99750000-0000-4000-8000-000000000030', '99750000-0000-4000-8000-000000000010', 'board-test-lib', 'Board Engagement');

insert into public.workload_identities(id, tenant_id, agent_name, spiffe_id, status)
  values ('99750000-0000-4000-8000-000000000041', '99750000-0000-4000-8000-000000000010', 'parikshan', 'spiffe://axiom.test/parikshan', 'active');

insert into public.agent_runs(id, tenant_id, agent, engagement_id, correlation_id, status, input_redacted_hash, metadata)
  values
  ('99750000-0000-4000-8000-000000000040', '99750000-0000-4000-8000-000000000010', 'parikshan', '99750000-0000-4000-8000-000000000030', gen_random_uuid(), 'succeeded', repeat('a', 64), '{}'::jsonb);

insert into public.workload_task_delegations(
  run_id, tenant_id, workload_identity_id, agent_name, created_by,
  engagement_id, correlation_id, input_hash, proof_hash, scopes,
  created_at, expires_at
) values (
  '99750000-0000-4000-8000-000000000040',
  '99750000-0000-4000-8000-000000000010',
  '99750000-0000-4000-8000-000000000041',
  'parikshan',
  '99750000-0000-4000-8000-000000000001',
  '99750000-0000-4000-8000-000000000030',
  gen_random_uuid(),
  repeat('a', 64),
  repeat('b', 64),
  array['control_library.read', 'findings.write'],
  clock_timestamp(),
  clock_timestamp() + interval '10 minutes'
);

-- Seed finalized assessment packet
insert into public.workload_assessment_packets(
  run_id, tenant_id, engagement_id, library_version, controls, library_digest,
  started_receipt, completed_receipt, result_digest, result, completed_at
) values (
  '99750000-0000-4000-8000-000000000040',
  '99750000-0000-4000-8000-000000000010',
  '99750000-0000-4000-8000-000000000030',
  'board-test-lib',
  '[]'::jsonb,
  '1111111111111111111111111111111111111111111111111111111111111111',
  1, 2,
  '2222222222222222222222222222222222222222222222222222222222222222',
  jsonb_build_object('posture_score', 85, 'findings', '[]'::jsonb),
  clock_timestamp()
);

-- Test 1: Manager requests board report
set local role service_role;
do $$
declare
  t uuid := '99750000-0000-4000-8000-000000000010';
  m uuid := '99750000-0000-4000-8000-000000000001';
  eng uuid := '99750000-0000-4000-8000-000000000030';
  run uuid := '99750000-0000-4000-8000-000000000040';
  op uuid := gen_random_uuid();
  res jsonb;
  req_id uuid;
begin
  res := public.request_board_report(t, m, op, eng, run, 'Q3 Board Report', gen_random_uuid());
  perform pg_temp.ok(res->>'status' = 'requested', 'request_board_report returns requested status');
  req_id := (res->>'requestId')::uuid;

  -- Replay with same op key is idempotent
  res := public.request_board_report(t, m, op, eng, run, 'Q3 Board Report', gen_random_uuid());
  perform pg_temp.ok(res->>'replayed' = 'true', 'idempotent request replays clean');

  -- Viewer cannot request
  res := public.request_board_report(t, '99750000-0000-4000-8000-000000000004'::uuid, gen_random_uuid(), eng, run, 'Unauthorized', gen_random_uuid());
  perform pg_temp.ok(res->>'error' = 'forbidden', 'viewer denied request_board_report');
end $$;

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

  -- External founder denied
  res := public.record_board_report_draft(t, f_external, req_id, content, html, gen_random_uuid());
  perform pg_temp.ok(res->>'error' = 'founder_authority_required', 'external founder cannot record draft');

  -- Internal founder succeeds
  res := public.record_board_report_draft(t, f_internal, req_id, content, html, gen_random_uuid());
  perform pg_temp.ok(res->>'status' = 'draft', 'internal founder records draft');
  rep_id := (res->>'reportId')::uuid;

  -- Artifacts attached
  perform pg_temp.ok(exists (
    select 1 from public.board_report_artifacts where tenant_id = t and report_id = rep_id
  ), 'artifacts row created');
end $$;

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
