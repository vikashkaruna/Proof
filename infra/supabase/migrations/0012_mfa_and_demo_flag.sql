-- ─────────────────────────────────────────────────────────────────────
-- 0012_mfa_and_demo_flag.sql
-- Multi-factor authentication (W1 · SEC-8) and the demo-data flag.
--
-- SEC-8: a repo-wide search for mfa|2fa|totp|otp|authenticator|second
-- factor|verifyOtp|signInWithOtp returned only UI copy strings and one
-- control-library description. `04_Solution_Architecture.md` §4.1
-- specifies "email+MFA in Phase 1". It was not implemented at all.
--
-- Self-managed TOTP rather than Supabase Auth factors, decided with the
-- founder: W10 requires onprem to run air-gapped, and binding MFA to a
-- hosted GoTrue would mean either a second implementation for onprem or
-- an environment that authenticates differently from the others — which
-- is precisely what W0.0 exists to prevent, and what the W0.1 parity
-- lane would be unable to compare.
--
-- Enforcement is step-up, not blanket: required at login for founder /
-- owner / approver, and re-challenged at the moment of approval-token
-- issuance. That second challenge is the one that matters — it binds a
-- fresh, strong authentication to the exact act of approving, which is
-- what FR-7.3 ("approver identity, timestamp, scope recorded") has to
-- mean in front of an auditor.
-- ─────────────────────────────────────────────────────────────────────

-- `sms` is defined but never issued. Reserving the enum slot means adding
-- a provider later is configuration rather than a migration; no SMS
-- provider is integrated and no SMS code ships (decision E.1).
create type mfa_factor_type as enum ('totp', 'email_otp', 'sms', 'recovery_code');

create type mfa_factor_status as enum (
  'pending',   -- secret issued, first verification not yet completed
  'active',
  'revoked'
);

create table public.user_mfa_factors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  factor_type mfa_factor_type not null,
  status mfa_factor_status not null default 'pending',
  -- Friendly name, e.g. "iPhone Authenticator". Never the secret.
  label text,

  -- TOTP shared secret, base32, encrypted at rest by the application
  -- before it reaches this column. Null for factor types that have none.
  secret_encrypted text,

  -- Recovery codes are hashed, never stored in the clear: a recovery code
  -- is a bearer credential equivalent to the second factor itself.
  code_hash text,
  consumed_at timestamptz,

  -- Replay defence. A TOTP code is valid for a whole step, so the same
  -- code must not be accepted twice within its own window.
  last_used_counter bigint,

  created_at timestamptz not null default now(),
  activated_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,

  constraint mfa_secret_present_for_totp check (
    factor_type <> 'totp' or secret_encrypted is not null
  ),
  constraint mfa_hash_present_for_recovery check (
    factor_type <> 'recovery_code' or code_hash is not null
  )
);

comment on table public.user_mfa_factors is
  'Enrolled second factors. TOTP secrets are encrypted; recovery codes are hashed (W1, SEC-8).';

-- One active TOTP authenticator per user. Recovery codes are many.
create unique index user_mfa_factors_one_active_totp
  on public.user_mfa_factors (user_id)
  where factor_type = 'totp' and status = 'active';

create index user_mfa_factors_user_idx
  on public.user_mfa_factors (user_id, status);

-- Unconsumed recovery codes, the hot path when someone has lost a device.
create index user_mfa_factors_recovery_idx
  on public.user_mfa_factors (user_id)
  where factor_type = 'recovery_code' and consumed_at is null;

-- ─── Challenges ──────────────────────────────────────────────────────
create type mfa_challenge_purpose as enum (
  'login',
  -- The step-up that binds a fresh authentication to a specific act.
  'approval_issuance',
  'enrolment',
  'factor_revocation'
);

create table public.mfa_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  tenant_id uuid references public.tenants(id) on delete cascade,
  factor_id uuid references public.user_mfa_factors(id) on delete set null,
  purpose mfa_challenge_purpose not null,

  -- What this challenge authorises. For `approval_issuance` this is the
  -- plan and action set, so a satisfied challenge cannot be replayed
  -- against a DIFFERENT approval — the same binding property the
  -- approval token itself has.
  bound_resource_ref text,
  bound_payload_sha256 text,

  -- Email OTP only; hashed for the same reason recovery codes are.
  code_hash text,

  attempts integer not null default 0,
  max_attempts integer not null default 5,

  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  satisfied_at timestamptz,

  constraint mfa_challenge_expiry_after_creation check (expires_at > created_at)
);

comment on table public.mfa_challenges is
  'In-flight MFA challenges. `approval_issuance` challenges are bound to the exact plan and actions being approved (FR-7.3).';

create index mfa_challenges_open_idx
  on public.mfa_challenges (user_id, purpose, expires_at)
  where satisfied_at is null;

-- ─── Role-level MFA requirement ──────────────────────────────────────
-- Which roles must hold an active factor. Data rather than code, so
-- tightening the policy for a tenant does not need a deploy.
alter table public.tenants
  add column if not exists mfa_required_roles user_role[] not null
    default array['owner', 'approver']::user_role[];

comment on column public.tenants.mfa_required_roles is
  'Roles that must hold an active MFA factor to sign in. Founder is always required regardless of this column.';

-- ─── Demo-data flag ──────────────────────────────────────────────────
-- Ten module pages ship illustrative figures ("12.4M rows", "47 tables").
-- They are useful for demonstrations and actively dangerous in front of a
-- real client, who cannot distinguish an invented number from their own
-- posture. Gate them on an explicit per-tenant flag rather than on a
-- query returning nothing.
alter table public.tenants
  add column if not exists is_demo boolean not null default false;

comment on column public.tenants.is_demo is
  'When true, module pages may render illustrative sample figures, labelled as simulated. Never true for a client tenant.';

-- ─── RLS ─────────────────────────────────────────────────────────────
alter table public.user_mfa_factors enable row level security;
alter table public.mfa_challenges enable row level security;

-- A user sees their own factors and nobody else's — not even a tenant
-- owner's. Enrolment state is personal security data, and an owner
-- knowing which of their approvers lack a factor is not worth the
-- precedent of letting one user read another's credential metadata.
create policy user_mfa_factors_self on public.user_mfa_factors
  for select using (user_id = auth.uid());

create policy mfa_challenges_self on public.mfa_challenges
  for select using (user_id = auth.uid());

-- All writes go through the BFF with the service-role key, after it has
-- verified the session. No direct client write path: a client that could
-- insert its own `satisfied_at` would defeat the entire mechanism.
create policy user_mfa_factors_no_client_write on public.user_mfa_factors
  for all using (false) with check (false);

create policy mfa_challenges_no_client_write on public.mfa_challenges
  for all using (false) with check (false);
