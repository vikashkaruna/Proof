-- ==============================================================================
-- Axiom Proof — Multi-Tenant User & Identity Seed Script (seed-users.sql)
-- ==============================================================================
-- Idempotently seeds standard authenticated users, identities, and tenant memberships
-- into Supabase Auth (auth.users, auth.identities) and Axiom application tables
-- (public.users, public.tenants, public.tenant_users).
--
-- Roster:
--   1. Founder / Super Admin  : founder@axiomminds.ai  (Pass: Admin@12345678)
--   2. Fintech DPO (Meridian) : dpo@meridianpay.com     (Pass: Meridian@123456)
--   3. Healthcare Auditor     : auditor@aarogya.in      (Pass: Aarogya@123456)
--   4. SaaS SecOps Approver   : security@streamline.io  (Pass: Streamline@123456)
--
-- Execution:
--   psql "$DATABASE_URL" -f infra/supabase/seed-users.sql
--   or via pnpm seed:users
-- ==============================================================================

-- 1. Ensure Standard Tenants Exist
insert into public.tenants (id, slug, name, tier, is_sdf, processes_health_data)
values
  ('00000000-0000-0000-0000-000000000001', 'meridian', 'Meridian Pay (Fintech)', 'growth', true, false),
  ('00000000-0000-0000-0000-000000000002', 'aarogya', 'Aarogya Health (Healthcare)', 'enterprise', true, true),
  ('00000000-0000-0000-0000-000000000003', 'streamline', 'Streamline SaaS (B2B SaaS)', 'essential', false, false)
on conflict (id) do update set
  name = excluded.name,
  slug = excluded.slug,
  tier = excluded.tier,
  is_sdf = excluded.is_sdf,
  processes_health_data = excluded.processes_health_data;

-- 2. Seed Users into auth.users with bcrypt passwords
-- Password crypt utilizes pgcrypto gen_salt('bf') standard for GoTrue compatibility.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, last_sign_in_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin
)
values
  -- Founder / Super Admin
  (
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'founder@axiomminds.ai',
    crypt('Admin@12345678', gen_salt('bf')),
    now(), now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Axiom Founder"}'::jsonb,
    true
  ),
  -- Meridian Pay DPO (Fintech Admin)
  (
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'dpo@meridianpay.com',
    crypt('Meridian@123456', gen_salt('bf')),
    now(), now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Ravi Sharma (DPO)"}'::jsonb,
    false
  ),
  -- Aarogya Health Auditor (Healthcare Reviewer)
  (
    '00000000-0000-0000-0000-000000000020',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'auditor@aarogya.in',
    crypt('Aarogya@123456', gen_salt('bf')),
    now(), now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Dr. Sunita Patel (Lead Auditor)"}'::jsonb,
    false
  ),
  -- Streamline SaaS SecOps (Approver)
  (
    '00000000-0000-0000-0000-000000000030',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'security@streamline.io',
    crypt('Streamline@123456', gen_salt('bf')),
    now(), now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Karan Malhotra (SecOps Lead)"}'::jsonb,
    false
  )
on conflict (id) do update set
  encrypted_password = excluded.encrypted_password,
  email_confirmed_at = excluded.email_confirmed_at,
  raw_user_meta_data = excluded.raw_user_meta_data,
  updated_at = now();

-- 3. Seed Identities into auth.identities (Required for GoTrue password sign-in)
insert into auth.identities (
  id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    '{"sub":"00000000-0000-0000-0000-000000000001","email":"founder@axiomminds.ai"}'::jsonb,
    'email',
    'founder@axiomminds.ai',
    now(), now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000010',
    '{"sub":"00000000-0000-0000-0000-000000000010","email":"dpo@meridianpay.com"}'::jsonb,
    'email',
    'dpo@meridianpay.com',
    now(), now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000020',
    '00000000-0000-0000-0000-000000000020',
    '{"sub":"00000000-0000-0000-0000-000000000020","email":"auditor@aarogya.in"}'::jsonb,
    'email',
    'auditor@aarogya.in',
    now(), now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000030',
    '00000000-0000-0000-0000-000000000030',
    '{"sub":"00000000-0000-0000-0000-000000000030","email":"security@streamline.io"}'::jsonb,
    'email',
    'security@streamline.io',
    now(), now(), now()
  )
on conflict (provider_id, provider) do update set
  identity_data = excluded.identity_data,
  updated_at = now();

-- 4. Mirror Users to public.users
insert into public.users (id, email, full_name, is_axiom_internal)
values
  ('00000000-0000-0000-0000-000000000001', 'founder@axiomminds.ai', 'Axiom Founder', true),
  ('00000000-0000-0000-0000-000000000010', 'dpo@meridianpay.com', 'Ravi Sharma (DPO)', false),
  ('00000000-0000-0000-0000-000000000020', 'auditor@aarogya.in', 'Dr. Sunita Patel (Lead Auditor)', false),
  ('00000000-0000-0000-0000-000000000030', 'security@streamline.io', 'Karan Malhotra (SecOps Lead)', false)
on conflict (id) do update set
  email = excluded.email,
  full_name = excluded.full_name,
  is_axiom_internal = excluded.is_axiom_internal,
  updated_at = now();

-- 5. Seed Tenant Memberships (public.tenant_users)
insert into public.tenant_users (tenant_id, user_id, role, approval_scopes)
values
  -- Founder has owner authority across all 3 tenants
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'owner', '{"*"}'),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'owner', '{"*"}'),
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'owner', '{"*"}'),

  -- Meridian Pay DPO (Admin)
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'admin', '{"discovery","assessment","remediation","approvals"}'),

  -- Aarogya Health Auditor (Reviewer)
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000020', 'reviewer', '{"assessment","reports","audit"}'),

  -- Streamline SaaS SecOps (Approver)
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000030', 'approver', '{"remediation","approvals"}')
on conflict (tenant_id, user_id) do update set
  role = excluded.role,
  approval_scopes = excluded.approval_scopes;
