-- W8 / migration 0079: Statutory report formats and approval exports.
--
-- Tests:
-- 1. record_approval_export RPC records export, enforces valid format/size/hash, and writes to audit ledger.
-- 2. record_statutory_report_draft RPC creates draft report and statutory_report_artifacts entry.
-- 3. attach_statutory_report_pdf RPC updates PDF artifact sha256/bytes and writes to ledger.

begin;

create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
create function pg_temp.assert_eq(actual text, expected text, message text) returns void language plpgsql as $$
begin if actual is distinct from expected then
  raise exception 'ASSERTION FAILED: % (expected %, got %)', message, expected, actual; end if; end $$;

-- ─── Fixtures ────────────────────────────────────────────────────────
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'approver@w8test.invalid');
insert into public.users(id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'approver@w8test.invalid');

insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-0000000000a1', 'w8-test-tenant', 'W8 Test Tenant');

insert into public.tenant_users(tenant_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', 'founder');

insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-w8-lib', now(), 'test', 'test', 0);

insert into public.engagements(id, tenant_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a1', 'test-w8-lib', 'Engagement W8');

insert into public.remediation_plans(id, tenant_id, engagement_id, title, library_version)
  values ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a1',
          '00000000-0000-0000-0000-0000000000a2', 'Remediation Plan W8', 'test-w8-lib');

-- ─── 1. Approval Export Recording ────────────────────────────────────
do $$
declare
  v_res jsonb;
  v_hash text := 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  v_corr uuid := gen_random_uuid();
begin
  -- Invalid format refusal
  v_res := public.record_approval_export(
    '00000000-0000-0000-0000-0000000000a1',
    '00000000-0000-0000-0000-0000000000d1',
    '00000000-0000-0000-0000-0000000000a3',
    'exe',
    '{}'::jsonb,
    '{"count": 1}'::jsonb,
    v_hash,
    1024,
    v_corr
  );
  perform pg_temp.assert_eq(v_res->>'error', 'invalid_format', 'refuses unsupported export format');

  -- Valid export recording
  v_res := public.record_approval_export(
    '00000000-0000-0000-0000-0000000000a1',
    '00000000-0000-0000-0000-0000000000d1',
    '00000000-0000-0000-0000-0000000000a3',
    'pdf',
    '{"mode": "batch"}'::jsonb,
    '{"total_approvals": 5}'::jsonb,
    v_hash,
    45000,
    v_corr
  );
  perform pg_temp.assert_eq(v_res->>'status', 'exported', 'records valid approval export');
  perform pg_temp.assert_true(v_res->>'exportId' is not null, 'returns exportId');

  -- Verify row in approval_exports
  perform pg_temp.assert_true(
    (select count(*) = 1 from public.approval_exports where tenant_id = '00000000-0000-0000-0000-0000000000a1'),
    'approval_exports row exists');

  -- Verify ledger entry
  perform pg_temp.assert_true(
    (select count(*) = 1 from public.audit_ledger
      where tenant_id = '00000000-0000-0000-0000-0000000000a1'
        and action_type = 'approval.exported'),
    'approval.exported written to audit ledger');
end $$;

-- ─── 2. Statutory Report Draft Recording ─────────────────────────────
do $$
declare
  v_res jsonb;
  v_content text := '{"schema_version": 1, "kind": "auditor_pack", "title": "Auditor Report"}';
  v_html text := '<!DOCTYPE html><html><body>Auditor Report</body></html>';
  v_report_id uuid;
  v_corr uuid := gen_random_uuid();
  v_pdf_hash text := 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
begin
  v_res := public.record_statutory_report_draft(
    '00000000-0000-0000-0000-0000000000a1',
    '00000000-0000-0000-0000-0000000000d1',
    '00000000-0000-0000-0000-0000000000a2',
    'auditor',
    'Statutory Auditor Pack Q3',
    'test-w8-lib',
    v_content,
    v_html,
    v_corr
  );

  perform pg_temp.assert_eq(v_res->>'status', 'draft', 'records statutory report draft');
  v_report_id := (v_res->>'reportId')::uuid;
  perform pg_temp.assert_true(v_report_id is not null, 'returns reportId');

  -- Verify statutory_report_artifacts entry
  perform pg_temp.assert_true(
    (select count(*) = 1 from public.statutory_report_artifacts where report_id = v_report_id),
    'statutory_report_artifacts entry created');

  -- Attach PDF
  v_res := public.attach_statutory_report_pdf(
    '00000000-0000-0000-0000-0000000000a1',
    '00000000-0000-0000-0000-0000000000d1',
    v_report_id,
    v_pdf_hash,
    85000,
    v_corr
  );
  perform pg_temp.assert_eq(v_res->>'status', 'pdf_attached', 'attaches statutory report PDF');

  -- Verify PDF fields in artifact row
  perform pg_temp.assert_true(
    (select pdf_sha256 = v_pdf_hash and pdf_bytes = 85000
       from public.statutory_report_artifacts where report_id = v_report_id),
    'artifact row updated with exact pdf metadata');

  -- Verify ledger entry for report.exported
  perform pg_temp.assert_true(
    (select count(*) = 1 from public.audit_ledger
      where tenant_id = '00000000-0000-0000-0000-0000000000a1'
        and action_type = 'report.exported'),
    'report.exported written to audit ledger');
end $$;

rollback;
