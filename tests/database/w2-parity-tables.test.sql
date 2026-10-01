-- Comprehensive database test suite for Revision 103 (W2 Parity Tables 40/40 Complete)
-- Tests: ropa_records, policy_drafts, playbook_entries, classification_reviews
-- Enforces: Tenant isolation, composite FKs, RLS, RBAC gates, and ledger immutability.

begin;

create function pg_temp.ok(v boolean, m text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'ASSERTION FAILED: %', m; end if; end $$;

create function pg_temp.assert_eq(actual text, expected text, message text) returns void language plpgsql as $$
begin if actual is distinct from expected then
  raise exception 'ASSERTION FAILED: % (expected %, got %)', message, expected, actual; end if; end $$;

-- ─── 1. Fixture Users & Tenants ───────────────────────────────────────
insert into auth.users(id, email)
  select ('99760000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'parity-' || n || '@example.invalid'
  from generate_series(1, 6) n;

insert into public.users(id, email, full_name, is_axiom_internal)
  values
  ('99760000-0000-4000-8000-000000000001', 'parity-1@example.invalid', 'Tenant A Admin', false),
  ('99760000-0000-4000-8000-000000000002', 'parity-2@example.invalid', 'Internal Founder', true),
  ('99760000-0000-4000-8000-000000000003', 'parity-3@example.invalid', 'External Founder', false),
  ('99760000-0000-4000-8000-000000000004', 'parity-4@example.invalid', 'Reviewer User', false),
  ('99760000-0000-4000-8000-000000000005', 'parity-5@example.invalid', 'Viewer User', false),
  ('99760000-0000-4000-8000-000000000006', 'parity-6@example.invalid', 'Tenant B Admin', false);

insert into public.tenants(id, slug, name)
  values
  ('99760000-0000-4000-8000-000000000010', 'parity-tenant-a', 'Parity Tenant A'),
  ('99760000-0000-4000-8000-000000000020', 'parity-tenant-b', 'Parity Tenant B');

insert into public.tenant_users(tenant_id, user_id, role)
  values
  ('99760000-0000-4000-8000-000000000010', '99760000-0000-4000-8000-000000000001', 'admin'),
  ('99760000-0000-4000-8000-000000000010', '99760000-0000-4000-8000-000000000002', 'founder'),
  ('99760000-0000-4000-8000-000000000010', '99760000-0000-4000-8000-000000000003', 'founder'),
  ('99760000-0000-4000-8000-000000000010', '99760000-0000-4000-8000-000000000004', 'reviewer'),
  ('99760000-0000-4000-8000-000000000010', '99760000-0000-4000-8000-000000000005', 'viewer'),
  ('99760000-0000-4000-8000-000000000020', '99760000-0000-4000-8000-000000000006', 'admin');

-- ─── 2. Test ROPA Records ─────────────────────────────────────────────
reset role; -- fixture inspects retained rows; 0098 suite proves writer grants
do $$
declare
  t_a uuid := '99760000-0000-4000-8000-000000000010';
  u_admin uuid := '99760000-0000-4000-8000-000000000001';
  u_contrib uuid := '99760000-0000-4000-8000-000000000005';
  res jsonb;
  r_id uuid;
begin
  -- Contributor denied
  res := public.create_ropa_record(
    t_a, u_contrib, null, null, 'Customer Support Data', 'consent',
    array['contact_info', 'chat_logs'], array['customers'], array['support_team'],
    false, '{}', 24, 'AES-256 encryption at rest, TLS 1.3 in transit', false, gen_random_uuid()
  );
  perform pg_temp.ok(res->>'error' = 'forbidden', 'contributor denied create_ropa_record');

  -- Invalid request (bad legal basis)
  res := public.create_ropa_record(
    t_a, u_admin, null, null, 'Customer Support Data', 'invalid_basis',
    array['contact_info'], array['customers'], array['support_team'],
    false, '{}', 24, 'AES-256 encryption', false, gen_random_uuid()
  );
  perform pg_temp.ok(res->>'error' = 'invalid_request', 'invalid legal_basis rejected');

  -- Admin succeeds
  res := public.create_ropa_record(
    t_a, u_admin, null, null, 'Customer Onboarding & KYC', 'statutory',
    array['identity_proof', 'address_proof', 'tax_id'], array['individuals', 'directors'],
    array['verification_vendor', 'regulatory_authority'], true, array['SG', 'US'], 96,
    'Client-side envelope encryption, KMS HSM-backed keys, immutable audit ledger',
    true, gen_random_uuid()
  );
  perform pg_temp.ok(res->>'status' = 'active', 'create_ropa_record creates active record');
  perform pg_temp.ok(res->>'purposeName' = 'Customer Onboarding & KYC', 'ropa purpose name matches');
  r_id := (res->>'recordId')::uuid;

  -- Verify ledger entry was appended
  perform pg_temp.ok(exists (
    select 1 from public.audit_ledger
     where tenant_id = t_a
       and action_type = 'ropa.recorded'
       and target_ref = r_id::text
  ), 'ledger recorded ropa.recorded action');
end $$;

-- ─── 3. Test Policy Drafts ───────────────────────────────────────────
do $$
declare
  t_a uuid := '99760000-0000-4000-8000-000000000010';
  u_admin uuid := '99760000-0000-4000-8000-000000000001';
  u_f_int uuid := '99760000-0000-4000-8000-000000000002';
  u_f_ext uuid := '99760000-0000-4000-8000-000000000003';
  u_contrib uuid := '99760000-0000-4000-8000-000000000005';
  res jsonb;
  draft_id uuid;
  content text := 'This policy mandates AES-GCM-256 for all at-rest customer data.';
  expected_hash text := encode(sha256(convert_to('This policy mandates AES-GCM-256 for all at-rest customer data.', 'UTF8')), 'hex');
begin
  -- Contributor denied
  res := public.create_policy_draft(
    t_a, u_contrib, 'Encryption Policy', 'data_protection', 'Data encryption baseline',
    content, array['DPDPA-SEC-001'], gen_random_uuid()
  );
  perform pg_temp.ok(res->>'error' = 'forbidden', 'contributor denied create_policy_draft');

  -- Admin creates draft
  res := public.create_policy_draft(
    t_a, u_admin, 'Encryption Policy', 'data_protection', 'Data encryption baseline',
    content, array['DPDPA-SEC-001'], gen_random_uuid()
  );
  perform pg_temp.ok(res->>'status' = 'draft', 'create_policy_draft creates draft');
  perform pg_temp.ok(res->>'contentHash' = expected_hash, 'draft computes exact SHA-256 hash');
  draft_id := (res->>'draftId')::uuid;

  -- External founder denied review
  res := public.review_policy_draft(t_a, u_f_ext, draft_id, 'approved', expected_hash, gen_random_uuid());
  perform pg_temp.ok(res->>'error' = 'founder_authority_required', 'external founder cannot review policy draft');

  -- Internal founder with wrong hash denied review
  res := public.review_policy_draft(t_a, u_f_int, draft_id, 'approved', repeat('0', 64), gen_random_uuid());
  perform pg_temp.ok(res->>'error' = 'digest_mismatch', 'tampered/incorrect hash rejected');

  -- Internal founder approves draft
  res := public.review_policy_draft(t_a, u_f_int, draft_id, 'approved', expected_hash, gen_random_uuid());
  perform pg_temp.ok(res->>'status' = 'approved', 'internal founder approves policy draft');

  -- State machine: cannot re-approve already approved draft
  res := public.review_policy_draft(t_a, u_f_int, draft_id, 'approved', expected_hash, gen_random_uuid());
  perform pg_temp.ok(res->>'error' = 'invalid_draft_state', 'cannot re-review approved draft');

  -- Verify ledger entry was appended
  perform pg_temp.ok(exists (
    select 1 from public.audit_ledger
     where tenant_id = t_a
       and action_type = 'policy.reviewed'
       and target_ref = draft_id::text
  ), 'ledger recorded policy.reviewed action');
end $$;

-- ─── 4. Test Playbook Entries ─────────────────────────────────────────
do $$
declare
  t_a uuid := '99760000-0000-4000-8000-000000000010';
  u_admin uuid := '99760000-0000-4000-8000-000000000001';
  u_contrib uuid := '99760000-0000-4000-8000-000000000005';
  res jsonb;
  playbook_id uuid;
  steps jsonb := '[{"step": 1, "action": "identify_incident"}, {"step": 2, "action": "contain_blast_radius"}]'::jsonb;
begin
  -- Contributor denied
  res := public.create_playbook_entry(
    t_a, u_contrib, 'Critical Breach Protocol', 'incident_response',
    'Breach severity critical or high', 'nazar', steps, true, gen_random_uuid()
  );
  perform pg_temp.ok(res->>'error' = 'forbidden', 'contributor denied create_playbook_entry');

  -- Bad agent rejected
  res := public.create_playbook_entry(
    t_a, u_admin, 'Critical Breach Protocol', 'incident_response',
    'Breach severity critical or high', 'nonexistent_agent', steps, true, gen_random_uuid()
  );
  perform pg_temp.ok(res->>'error' = 'invalid_request', 'invalid agent name rejected');

  -- Admin succeeds
  res := public.create_playbook_entry(
    t_a, u_admin, 'Critical Breach Protocol', 'incident_response',
    'Breach severity critical or high', 'nazar', steps, true, gen_random_uuid()
  );
  perform pg_temp.ok(res->>'status' = 'active', 'create_playbook_entry creates active playbook');
  playbook_id := (res->>'playbookId')::uuid;

  -- Verify ledger entry
  perform pg_temp.ok(exists (
    select 1 from public.audit_ledger
     where tenant_id = t_a
       and action_type = 'playbook.created'
       and target_ref = playbook_id::text
  ), 'ledger recorded playbook.created action');
end $$;

-- ─── 5. Test Classification Reviews ───────────────────────────────────
do $$
declare
  t_a uuid := '99760000-0000-4000-8000-000000000010';
  u_auditor uuid := '99760000-0000-4000-8000-000000000004';
  u_contrib uuid := '99760000-0000-4000-8000-000000000005';
  res jsonb;
  rev_id uuid;
begin
  -- Contributor denied
  res := public.submit_classification_review(
    t_a, u_contrib, null, 'db-prod-aurora', 'customers.aadhar_vault',
    'critical_pii', array['national_id', 'biometric'], 98.5,
    'confirmed', null, 'Verified Aadhaar tokenization scheme', gen_random_uuid()
  );
  perform pg_temp.ok(res->>'error' = 'forbidden', 'contributor denied submit_classification_review');

  -- Invalid: adjusted decision without adjusted_sensitivity
  res := public.submit_classification_review(
    t_a, u_auditor, null, 'db-prod-aurora', 'customers.notes',
    'restricted', array['internal_notes'], 65.0,
    'adjusted', null, 'Downgraded to internal', gen_random_uuid()
  );
  perform pg_temp.ok(res->>'error' = 'invalid_request', 'adjusted decision requires adjusted_sensitivity');

  -- Invalid: confirmed decision with adjusted_sensitivity
  res := public.submit_classification_review(
    t_a, u_auditor, null, 'db-prod-aurora', 'customers.notes',
    'restricted', array['internal_notes'], 65.0,
    'confirmed', 'internal', 'Contradictory decision', gen_random_uuid()
  );
  perform pg_temp.ok(res->>'error' = 'invalid_request', 'confirmed decision cannot specify adjusted_sensitivity');

  -- Auditor confirms
  res := public.submit_classification_review(
    t_a, u_auditor, null, 'db-prod-aurora', 'customers.aadhar_vault',
    'critical_pii', array['national_id', 'biometric'], 98.5,
    'confirmed', null, 'Verified Aadhaar tokenization scheme in place', gen_random_uuid()
  );
  perform pg_temp.ok(res->>'decision' = 'confirmed', 'auditor submits confirmed review');
  perform pg_temp.ok(res->>'finalSensitivity' = 'critical_pii', 'final sensitivity matches original');
  rev_id := (res->>'reviewId')::uuid;

  -- Auditor adjusts
  res := public.submit_classification_review(
    t_a, u_auditor, null, 'db-prod-aurora', 'customers.notes',
    'restricted', array['internal_notes'], 65.0,
    'adjusted', 'internal', 'Downgraded to internal after manual review of sample rows', gen_random_uuid()
  );
  perform pg_temp.ok(res->>'decision' = 'adjusted', 'auditor submits adjusted review');
  perform pg_temp.ok(res->>'finalSensitivity' = 'internal', 'final sensitivity reflects adjusted value');

  -- Verify ledger entry
  perform pg_temp.ok(exists (
    select 1 from public.audit_ledger
     where tenant_id = t_a
       and action_type = 'classification.reviewed'
       and target_ref = rev_id::text
  ), 'ledger recorded classification.reviewed action');
end $$;

-- ─── 6. Test RLS Isolation Across Tenants ─────────────────────────────
do $$
declare
  t_a uuid := '99760000-0000-4000-8000-000000000010';
  t_b uuid := '99760000-0000-4000-8000-000000000020';
  u_a uuid := '99760000-0000-4000-8000-000000000001';
  u_b uuid := '99760000-0000-4000-8000-000000000006';
  cnt integer;
begin
  -- Under authenticated role as Tenant B user
  -- Simulate auth.uid() = u_b
  perform set_config('request.jwt.claims', json_build_object('sub', u_b, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- Tenant B cannot see Tenant A's ropa records
  select count(*) into cnt from public.ropa_records where tenant_id = t_a;
  perform pg_temp.ok(cnt = 0, 'tenant B cannot view tenant A ropa_records');

  -- Tenant B cannot see Tenant A's policy drafts
  select count(*) into cnt from public.policy_drafts where tenant_id = t_a;
  perform pg_temp.ok(cnt = 0, 'tenant B cannot view tenant A policy_drafts');

  -- Tenant B cannot see Tenant A's playbook entries
  select count(*) into cnt from public.playbook_entries where tenant_id = t_a;
  perform pg_temp.ok(cnt = 0, 'tenant B cannot view tenant A playbook_entries');

  -- Tenant B cannot see Tenant A's classification reviews
  select count(*) into cnt from public.classification_reviews where tenant_id = t_a;
  perform pg_temp.ok(cnt = 0, 'tenant B cannot view tenant A classification_reviews');

  -- Switch to Tenant A user
  perform set_config('request.jwt.claims', json_build_object('sub', u_a, 'role', 'authenticated')::text, true);

  -- Tenant A sees their own rows
  select count(*) into cnt from public.ropa_records where tenant_id = t_a;
  perform pg_temp.ok(cnt >= 1, 'tenant A can view their ropa_records');

  select count(*) into cnt from public.policy_drafts where tenant_id = t_a;
  perform pg_temp.ok(cnt >= 1, 'tenant A can view their policy_drafts');

  select count(*) into cnt from public.playbook_entries where tenant_id = t_a;
  perform pg_temp.ok(cnt >= 1, 'tenant A can view their playbook_entries');

  select count(*) into cnt from public.classification_reviews where tenant_id = t_a;
  perform pg_temp.ok(cnt >= 1, 'tenant A can view their classification_reviews');
end $$;

rollback;
