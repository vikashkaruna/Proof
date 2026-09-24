-- ─────────────────────────────────────────────────────────────────────
-- 0014_mfa_session_attestations.sql
-- Login-time MFA enforcement (W1 · SEC-8).
--
-- The plan requires MFA "at login for founder / owner / approver". A
-- password sign-in with Supabase Auth issues a session immediately, so
-- there has to be a second fact — separate from the session itself —
-- recording that the second factor was seen. This table is that fact.
--
-- It binds to GoTrue's `session_id` claim rather than to the access
-- token. The access token rotates roughly hourly; the session id does
-- not, and it dies when the session does. Binding to the token would
-- silently drop the attestation at the first refresh, which would look
-- like a bug and would be papered over by weakening the check.
--
-- Rows are append-only. A session that outlives the attestation window
-- gets a NEW row when it re-authenticates, so the table reads as the
-- history of when this person proved their factor — which is what an
-- incident reconstruction needs, and what an upsert would destroy.
-- ─────────────────────────────────────────────────────────────────────

create table public.mfa_session_attestations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,

  -- GoTrue's `session_id` JWT claim (a required claim, not an optional
  -- one). Text rather than uuid: it is an external identifier and we do
  -- not control its shape.
  session_id text not null,

  factor_id uuid references public.user_mfa_factors(id) on delete set null,
  challenge_id uuid references public.mfa_challenges(id) on delete set null,

  satisfied_at timestamptz not null default now(),
  expires_at timestamptz not null,

  -- Set when a factor is revoked, so retiring an authenticator also ends
  -- the sessions it vouched for. A revoked factor that leaves live
  -- attestations behind has not really been revoked.
  revoked_at timestamptz,

  constraint mfa_attestation_expiry_after_satisfaction check (expires_at > satisfied_at)
);

comment on table public.mfa_session_attestations is
  'Records that a session met its second factor, bound to the GoTrue session_id and expiring independently of the session (W1, SEC-8).';

-- The gate's only read: is there a live attestation for this session?
create index mfa_session_attestations_live_idx
  on public.mfa_session_attestations (user_id, session_id, expires_at)
  where revoked_at is null;

-- ─── RLS ─────────────────────────────────────────────────────────────
alter table public.mfa_session_attestations enable row level security;

-- The web app reads its own attestation server-side to decide whether to
-- render or to send the user to the code prompt, so self-select is
-- required. Writes go only through the BFF with the service-role key: a
-- client that could insert its own attestation would defeat the gate
-- entirely, which is the same reason `mfa_challenges` is write-closed.
create policy mfa_session_attestations_self on public.mfa_session_attestations
  for select using (user_id = auth.uid());

create policy mfa_session_attestations_no_client_write on public.mfa_session_attestations
  for all using (false) with check (false);
