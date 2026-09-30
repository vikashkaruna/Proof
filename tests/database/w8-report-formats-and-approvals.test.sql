-- W8 / migration 0079: Statutory report formats and approval exports.
--
-- Tests:
-- 1. record_approval_export RPC records export, enforces valid format/size/hash, and writes to audit ledger.
-- 2. Unsafe caller-authored statutory draft and unverified PDF paths remain unavailable to the service role.

begin;

create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
create function pg_temp.assert_eq(actual text, expected text, message text) returns void language plpgsql as $$
begin if actual is distinct from expected then
  raise exception 'ASSERTION FAILED: % (expected %, got %)', message, expected, actual; end if; end $$;

-- ─── Fixtures ────────────────────────────────────────────────────────
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'approver@w8test.invalid'),
  ('00000000-0000-0000-0000-0000000000d2', 'viewer@w8test.invalid');
insert into public.users(id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'approver@w8test.invalid'),
  ('00000000-0000-0000-0000-0000000000d2', 'viewer@w8test.invalid');

insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-0000000000a1', 'w8-test-tenant', 'W8 Test Tenant');

insert into public.tenant_users(tenant_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', 'founder'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d2', 'viewer');

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

-- ─── 2. Source-bound statutory report boundary ─────────────────────
do $$
begin
  perform pg_temp.assert_true(
    not has_function_privilege('service_role',
      'public.record_statutory_report_draft(uuid,uuid,uuid,text,text,text,text,text,uuid)',
      'EXECUTE'),
    'caller-authored statutory draft RPC is unavailable to service role');
  perform pg_temp.assert_true(
    not has_function_privilege('service_role',
      'public.attach_statutory_report_pdf(uuid,uuid,uuid,text,bigint,uuid)',
      'EXECUTE'),
    'unverified statutory PDF attachment RPC is unavailable to service role');
  perform pg_temp.assert_true(
    not has_table_privilege('service_role', 'public.statutory_report_artifacts', 'INSERT')
      and not has_table_privilege('service_role', 'public.statutory_report_artifacts', 'UPDATE'),
    'service role cannot write unverified statutory artifact metadata directly');
end $$;

-- The historical function is used only by this superuser fixture to create
-- an old draft. Runtime service_role no longer has EXECUTE on it.
create temporary table w8_legacy_draft(id uuid primary key);
insert into w8_legacy_draft
select (public.record_statutory_report_draft(
  '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000d1',
  '00000000-0000-0000-0000-0000000000a2',
  'auditor', 'Historical private draft', 'test-w8-lib',
  '{"schema_version":1,"kind":"auditor_pack"}', '<html></html>', gen_random_uuid()
)->>'reportId')::uuid;
grant select on w8_legacy_draft to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d2","role":"authenticated"}', true);
select pg_temp.assert_true(
  (select count(*) = 0 from public.statutory_report_artifacts
    where report_id in (select id from w8_legacy_draft)),
  'viewer cannot read unapproved statutory draft metadata');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
select pg_temp.assert_true(
  (select count(*) = 1 from public.statutory_report_artifacts
    where report_id in (select id from w8_legacy_draft)),
  'draft creator retains read access to historical artifact metadata');
reset role;

rollback;
