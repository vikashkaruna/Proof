-- ─────────────────────────────────────────────────────────────────────
-- 0152_founder_mfa_recovery.sql
--
-- A live platform founder can recover a DIFFERENT live founder who has lost
-- their authenticator (e447–e450). The subject never needs the lost factor,
-- and nobody can recover themselves.
--
--   1. open        actor (live founder, live session, active TOTP, live MFA
--                  attestation, fresh step-up bound to the subject) fences
--                  the subject: every session created before the cutoff is
--                  dead everywhere (BFF, RLS, SQL writers), pending factors
--                  and attestations are retired, GoTrue sessions deleted.
--   2. bind        the subject signs in afresh with their password; that
--                  session (created after the cutoff) is bound to the case.
--   3. authorize   the actor confirms that exact session with a second fresh
--                  step-up. This is the one-shot grant, valid briefly.
--   4. enrol       the bound session alone may begin and finalize a new TOTP
--                  enrolment; finalize retires every old TOTP, recovery code
--                  and attestation and issues ten new recovery code hashes.
--
-- While a case is open, every ordinary MFA writer for the subject is refused,
-- so in-flight legacy enrolment, challenge, counter or attestation writes
-- cannot race the reset. Receipts are append-only.
--
-- Owner delegation (scoped, non-founder subjects) is a later migration; it
-- does not exist here, so no owner can reach any of this.
-- ─────────────────────────────────────────────────────────────────────

alter type public.mfa_challenge_purpose add value if not exists 'mfa_recovery';

-- ─── Account fence ───────────────────────────────────────────────────
create table public.mfa_account_fences (
  user_id uuid primary key references public.users(id) on delete cascade,
  epoch bigint not null default 0 check (epoch >= 0),
  sessions_valid_after timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.mfa_account_fences enable row level security;
revoke all on public.mfa_account_fences from public, anon, authenticated, service_role;

create function public.jwt_session_id() returns uuid
language plpgsql stable set search_path = '' as $$
begin
  return nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'session_id', '')::uuid;
exception when others then
  return null;
end;
$$;

-- True when the user's session postdates their fence (or they have none).
-- plpgsql (not sql) throughout where auth.sessions is read: GoTrue owns that
-- table, and a body validated at creation would bind this migration to it.
create function public.session_postdates_fence(p_user_id uuid, p_session_id uuid)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_cutoff timestamptz;
begin
  -- Unfenced accounts (nearly all) never touch auth.sessions: this runs inside
  -- every tenant RLS check.
  select sessions_valid_after into v_cutoff
    from public.mfa_account_fences where user_id = p_user_id;
  if not found then
    return true;
  end if;
  return p_session_id is not null and exists (
    select 1 from auth.sessions s
    where s.id = p_session_id and s.user_id = p_user_id and s.created_at >= v_cutoff
  );
end;
$$;

-- RLS form: the calling JWT's own session.
create function public.session_is_current() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is null
    or public.session_postdates_fence(auth.uid(), public.jwt_session_id());
$$;

-- Every tenant policy reaches data through these helpers, so a fenced
-- (pre-cutoff) JWT loses direct PostgREST access everywhere at once.
create or replace function public.is_tenant_member(check_tenant uuid) returns boolean
language sql security definer set search_path = public
as $$
  select public.session_is_current() and exists (
    select 1 from public.tenant_users
    where tenant_id = check_tenant
      and user_id = auth.uid()
  );
$$;

create or replace function public.has_tenant_role(check_tenant uuid, allowed_roles user_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select public.session_is_current() and exists (
    select 1 from public.tenant_users
    where tenant_id = check_tenant and user_id = auth.uid() and role = any(allowed_roles)
  );
$$;

create or replace function public.current_tenant_roles() returns user_role[]
language sql stable security definer set search_path = public
as $$
  select case when public.session_is_current() then (
    select coalesce(array_agg(role), '{}'::user_role[])
    from public.tenant_users
    where tenant_id = public.current_tenant_id()
      and user_id = auth.uid()
  ) else '{}'::user_role[] end;
$$;

alter policy user_mfa_factors_self on public.user_mfa_factors
  using (user_id = auth.uid() and public.session_is_current());
alter policy mfa_challenges_self on public.mfa_challenges
  using (user_id = auth.uid() and public.session_is_current());
alter policy mfa_session_attestations_self on public.mfa_session_attestations
  using (user_id = auth.uid() and public.session_is_current());
alter policy tenant_users_member_read on public.tenant_users
  using (public.session_is_current() and (user_id = auth.uid() or public.is_tenant_member(tenant_id)));
alter policy platform_founders_self_read on public.platform_founders
  using (user_id = auth.uid() and public.session_is_current());
alter policy users_read_self_or_colleague on public.users using (
  public.session_is_current() and (id = auth.uid() or exists (
    select 1 from public.tenant_users membership
    where membership.user_id = users.id and public.is_tenant_member(membership.tenant_id)
  ))
);
alter policy users_update_self on public.users
  using (id = auth.uid() and public.session_is_current())
  with check (id = auth.uid() and public.session_is_current());

-- ─── Cases and receipts ──────────────────────────────────────────────
create table public.mfa_recovery_cases (
  id uuid primary key default gen_random_uuid(),
  subject_user_id uuid not null references public.users(id),
  actor_user_id uuid not null references public.users(id),
  actor_session_id uuid not null,
  reason text not null check (length(btrim(reason)) between 10 and 1000),
  epoch bigint not null,
  cutoff_at timestamptz not null,
  state text not null check (state in ('opened', 'bound', 'authorized', 'enrolling', 'completed', 'cancelled')),
  beneficiary_session_id uuid,
  authorized_session_id uuid,
  authorized_at timestamptz,
  grant_expires_at timestamptz,
  pending_factor_id uuid references public.user_mfa_factors(id),
  activated_factor_id uuid references public.user_mfa_factors(id),
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid references public.users(id),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  check (actor_user_id <> subject_user_id)
);
create unique index mfa_recovery_cases_one_open
  on public.mfa_recovery_cases (subject_user_id)
  where state not in ('completed', 'cancelled');
alter table public.mfa_recovery_cases enable row level security;
revoke all on public.mfa_recovery_cases from public, anon, authenticated, service_role;

create table public.mfa_recovery_events (
  id bigint generated always as identity primary key,
  case_id uuid not null references public.mfa_recovery_cases(id),
  event text not null check (event in (
    'opened', 'expired', 'bound', 'authorized', 'enrolment_started', 'completed', 'cancelled')),
  actor_user_id uuid not null references public.users(id),
  session_id uuid,
  occurred_at timestamptz not null default clock_timestamp(),
  detail jsonb not null default '{}'::jsonb
);
alter table public.mfa_recovery_events enable row level security;
revoke all on public.mfa_recovery_events from public, anon, authenticated, service_role;

create function public.guard_mfa_recovery_events() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'MFA recovery receipts are append-only' using errcode = '42501';
end;
$$;
create trigger mfa_recovery_events_append_only
  before update or delete on public.mfa_recovery_events
  for each row execute function public.guard_mfa_recovery_events();

create function public.mfa_recovery_open_case(p_user_id uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.mfa_recovery_cases
  where subject_user_id = p_user_id and state not in ('completed', 'cancelled');
$$;

-- ─── Guards on every ordinary MFA writer ─────────────────────────────
create function public.guard_mfa_writes_during_recovery() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := coalesce(new.user_id, old.user_id);
begin
  if current_setting('axiom.mfa_recovery', true) = 'on' then
    return coalesce(new, old);
  end if;
  if public.mfa_recovery_open_case(v_user) is not null then
    raise exception 'MFA recovery in progress for this account' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger user_mfa_factors_recovery_guard
  before insert or update or delete on public.user_mfa_factors
  for each row execute function public.guard_mfa_writes_during_recovery();
create trigger mfa_challenges_recovery_guard
  before insert or update on public.mfa_challenges
  for each row execute function public.guard_mfa_writes_during_recovery();

-- An attestation must come from a session that postdates the fence, and none
-- may be written while a case is open.
create function public.guard_mfa_attestation_fence() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_session uuid;
begin
  if public.mfa_recovery_open_case(new.user_id) is not null then
    raise exception 'MFA recovery in progress for this account' using errcode = '42501';
  end if;
  if exists (select 1 from public.mfa_account_fences where user_id = new.user_id) then
    begin
      v_session := new.session_id::uuid;
    exception when others then
      v_session := null;
    end;
    if v_session is null or not public.session_postdates_fence(new.user_id, v_session) then
      raise exception 'session predates the account fence' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger mfa_session_attestations_fence
  before insert on public.mfa_session_attestations
  for each row execute function public.guard_mfa_attestation_fence();

-- ─── Internal helpers ────────────────────────────────────────────────
create function public.mfa_recovery_event(
  p_case uuid, p_event text, p_actor uuid, p_session uuid, p_detail jsonb default '{}'::jsonb
) returns void
language sql security definer set search_path = '' as $$
  insert into public.mfa_recovery_events(case_id, event, actor_user_id, session_id, detail)
  values (p_case, p_event, p_actor, p_session, coalesce(p_detail, '{}'::jsonb));
$$;

create function public.mfa_recovery_live_session(p_user uuid, p_session uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (
    select 1 from auth.sessions s
    where s.id = p_session and s.user_id = p_user
      and (s.not_after is null or s.not_after > clock_timestamp())
  ) and public.session_postdates_fence(p_user, p_session);
end;
$$;

-- The actor must be a live founder on a live, MFA-attested session with an
-- active authenticator, and must not themselves be under recovery.
create function public.assert_mfa_recovery_actor(p_actor uuid, p_session uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_actor is null or p_session is null
     or not public.is_live_platform_founder(p_actor)
     or not public.mfa_recovery_live_session(p_actor, p_session)
     or public.mfa_recovery_open_case(p_actor) is not null
     or not exists (
       select 1 from public.user_mfa_factors
       where user_id = p_actor and factor_type = 'totp' and status = 'active')
     or not exists (
       select 1 from public.mfa_session_attestations
       where user_id = p_actor and session_id = p_session::text
         and revoked_at is null and expires_at > clock_timestamp()) then
    raise exception 'MFA recovery actor refused' using errcode = '42501';
  end if;
end;
$$;

-- Spend the actor's satisfied, unexpired, recent step-up bound to p_ref.
create function public.consume_mfa_recovery_challenge(p_actor uuid, p_challenge uuid, p_ref text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.mfa_challenges
     set consumed_at = clock_timestamp(), consumed_for = 'mfa_recovery:' || p_ref
   where id = p_challenge and user_id = p_actor and purpose = 'mfa_recovery'
     and bound_resource_ref = p_ref
     and satisfied_at is not null and consumed_at is null
     and expires_at > clock_timestamp()
     and satisfied_at > clock_timestamp() - interval '5 minutes';
  if not found then
    raise exception 'MFA recovery step-up refused' using errcode = '42501';
  end if;
end;
$$;

-- Lock order: subject advisory lock, then users rows in uuid order.
create function public.lock_mfa_recovery_accounts(p_a uuid, p_b uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_b::text, 152));
  perform 1 from public.users where id in (p_a, p_b) order by id for no key update;
end;
$$;

-- ─── RPCs (BFF only, via service_role) ───────────────────────────────
create function public.open_mfa_recovery_case(
  p_actor_id uuid, p_actor_session_id uuid, p_challenge_id uuid,
  p_subject_id uuid, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz;
  v_epoch bigint;
  v_case public.mfa_recovery_cases%rowtype;
  v_expired uuid;
begin
  if p_actor_id is null or p_subject_id is null or p_actor_id = p_subject_id then
    raise exception 'self-recovery refused' using errcode = '42501';
  end if;
  perform public.lock_mfa_recovery_accounts(p_actor_id, p_subject_id);
  perform public.assert_mfa_recovery_actor(p_actor_id, p_actor_session_id);
  if not public.is_live_platform_founder(p_subject_id) then
    raise exception 'subject is not a live platform founder' using errcode = '42501';
  end if;
  perform set_config('axiom.mfa_recovery', 'on', true);

  -- A lapsed case is closed, never silently reused. Its fence stands.
  update public.mfa_recovery_cases set state = 'cancelled', cancelled_at = clock_timestamp()
   where subject_user_id = p_subject_id and state not in ('completed', 'cancelled')
     and expires_at <= clock_timestamp()
  returning id into v_expired;
  if v_expired is not null then
    perform public.mfa_recovery_event(v_expired, 'expired', p_actor_id, p_actor_session_id);
  end if;
  if public.mfa_recovery_open_case(p_subject_id) is not null then
    raise exception 'a recovery case is already open for this account' using errcode = 'PT409';
  end if;

  perform public.consume_mfa_recovery_challenge(p_actor_id, p_challenge_id, 'open:' || p_subject_id);

  v_now := clock_timestamp();
  insert into public.mfa_account_fences(user_id, epoch, sessions_valid_after, updated_at)
  values (p_subject_id, 1, v_now, v_now)
  on conflict (user_id) do update
    set epoch = public.mfa_account_fences.epoch + 1, sessions_valid_after = v_now, updated_at = v_now
  returning epoch into v_epoch;

  update public.mfa_session_attestations set revoked_at = v_now
   where user_id = p_subject_id and revoked_at is null;
  update public.user_mfa_factors set status = 'revoked', revoked_at = v_now
   where user_id = p_subject_id and factor_type = 'totp' and status = 'pending';
  delete from auth.sessions where user_id = p_subject_id;

  insert into public.mfa_recovery_cases(
    subject_user_id, actor_user_id, actor_session_id, reason, epoch, cutoff_at, state, expires_at)
  values (p_subject_id, p_actor_id, p_actor_session_id, btrim(p_reason), v_epoch, v_now, 'opened',
          v_now + interval '24 hours')
  returning * into v_case;
  perform public.mfa_recovery_event(v_case.id, 'opened', p_actor_id, p_actor_session_id,
    jsonb_build_object('subject_user_id', p_subject_id, 'epoch', v_epoch, 'reason', v_case.reason));

  perform set_config('axiom.mfa_recovery', 'off', true);

  return jsonb_build_object('case_id', v_case.id, 'epoch', v_epoch,
    'cutoff_at', v_case.cutoff_at, 'expires_at', v_case.expires_at);
end;
$$;

create function public.bind_mfa_recovery_session(
  p_subject_id uuid, p_session_id uuid, p_case_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.mfa_recovery_cases%rowtype;
  v_session record;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_subject_id::text, 152));
  select * into v_case from public.mfa_recovery_cases where id = p_case_id for update;
  if not found or v_case.subject_user_id is distinct from p_subject_id
     or v_case.state not in ('opened', 'bound') or v_case.expires_at <= clock_timestamp() then
    raise exception 'MFA recovery case refused' using errcode = '42501';
  end if;
  select s.id, s.created_at, s.user_agent, s.ip::text as ip into v_session
    from auth.sessions s
   where s.id = p_session_id and s.user_id = p_subject_id
     and s.created_at >= v_case.cutoff_at
     and (s.not_after is null or s.not_after > clock_timestamp());
  if not found then
    raise exception 'session predates the recovery case' using errcode = '42501';
  end if;
  update public.mfa_recovery_cases set state = 'bound', beneficiary_session_id = p_session_id
   where id = p_case_id;
  perform public.mfa_recovery_event(p_case_id, 'bound', p_subject_id, p_session_id);
  return jsonb_build_object('case_id', p_case_id, 'session_created_at', v_session.created_at,
    'user_agent', v_session.user_agent, 'ip', v_session.ip);
end;
$$;

create function public.authorize_mfa_recovery_session(
  p_actor_id uuid, p_actor_session_id uuid, p_challenge_id uuid,
  p_case_id uuid, p_beneficiary_session_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.mfa_recovery_cases%rowtype;
  v_now timestamptz;
begin
  select * into v_case from public.mfa_recovery_cases where id = p_case_id;
  if not found then
    raise exception 'MFA recovery case refused' using errcode = '42501';
  end if;
  perform public.lock_mfa_recovery_accounts(p_actor_id, v_case.subject_user_id);
  select * into v_case from public.mfa_recovery_cases where id = p_case_id for update;
  perform public.assert_mfa_recovery_actor(p_actor_id, p_actor_session_id);
  if v_case.actor_user_id is distinct from p_actor_id or v_case.state <> 'bound'
     or v_case.expires_at <= clock_timestamp()
     or v_case.beneficiary_session_id is distinct from p_beneficiary_session_id
     or not public.mfa_recovery_live_session(v_case.subject_user_id, p_beneficiary_session_id)
     or not public.is_live_platform_founder(v_case.subject_user_id) then
    raise exception 'MFA recovery authorization refused' using errcode = '42501';
  end if;
  perform public.consume_mfa_recovery_challenge(p_actor_id, p_challenge_id,
    'authorize:' || p_case_id || ':' || p_beneficiary_session_id);
  v_now := clock_timestamp();
  update public.mfa_recovery_cases
     set state = 'authorized', authorized_session_id = p_actor_session_id,
         authorized_at = v_now, grant_expires_at = v_now + interval '15 minutes'
   where id = p_case_id;
  perform public.mfa_recovery_event(p_case_id, 'authorized', p_actor_id, p_actor_session_id,
    jsonb_build_object('beneficiary_session_id', p_beneficiary_session_id));
  return jsonb_build_object('case_id', p_case_id, 'grant_expires_at', v_now + interval '15 minutes');
end;
$$;

create function public.begin_recovery_totp_enrolment(
  p_subject_id uuid, p_session_id uuid, p_case_id uuid,
  p_secret_encrypted text, p_label text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.mfa_recovery_cases%rowtype;
  v_factor uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_subject_id::text, 152));
  perform 1 from public.users where id = p_subject_id for no key update;
  perform 1 from public.user_mfa_factors
    where user_id = p_subject_id and factor_type = 'totp' order by id for update;
  select * into v_case from public.mfa_recovery_cases where id = p_case_id for update;
  if not found or v_case.subject_user_id is distinct from p_subject_id
     or v_case.state not in ('authorized', 'enrolling')
     or v_case.grant_expires_at is null or v_case.grant_expires_at <= clock_timestamp()
     or v_case.beneficiary_session_id is distinct from p_session_id
     or not public.mfa_recovery_live_session(p_subject_id, p_session_id)
     or p_secret_encrypted is null then
    raise exception 'MFA recovery enrolment refused' using errcode = '42501';
  end if;
  perform set_config('axiom.mfa_recovery', 'on', true);
  update public.user_mfa_factors set status = 'revoked', revoked_at = clock_timestamp()
   where user_id = p_subject_id and factor_type = 'totp' and status = 'pending';
  insert into public.user_mfa_factors(user_id, factor_type, status, label, secret_encrypted)
  values (p_subject_id, 'totp', 'pending', p_label, p_secret_encrypted)
  returning id into v_factor;
  update public.mfa_recovery_cases set state = 'enrolling', pending_factor_id = v_factor
   where id = p_case_id;
  perform public.mfa_recovery_event(p_case_id, 'enrolment_started', p_subject_id, p_session_id,
    jsonb_build_object('factor_id', v_factor));
  perform set_config('axiom.mfa_recovery', 'off', true);
  return v_factor;
end;
$$;

create function public.finalize_recovery_totp_enrolment(
  p_subject_id uuid, p_session_id uuid, p_case_id uuid, p_factor_id uuid,
  p_last_used_counter bigint, p_recovery_hashes text[]
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.mfa_recovery_cases%rowtype;
  v_swap record;
  v_now timestamptz;
begin
  if p_recovery_hashes is null or cardinality(p_recovery_hashes) <> 10
     or (select count(distinct h) from unnest(p_recovery_hashes) h) <> 10
     or exists (select 1 from unnest(p_recovery_hashes) h
       where h is null or h !~ '^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$') then
    raise exception 'ten distinct recovery hashes required' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_subject_id::text, 152));
  perform 1 from public.users where id = p_subject_id for no key update;
  perform 1 from public.user_mfa_factors
    where user_id = p_subject_id and factor_type = 'totp' order by id for update;
  select * into v_case from public.mfa_recovery_cases where id = p_case_id for update;
  if not found or v_case.subject_user_id is distinct from p_subject_id
     or v_case.state <> 'enrolling' or v_case.pending_factor_id is distinct from p_factor_id
     or v_case.grant_expires_at <= clock_timestamp()
     or v_case.beneficiary_session_id is distinct from p_session_id
     or not public.mfa_recovery_live_session(p_subject_id, p_session_id) then
    raise exception 'MFA recovery enrolment refused' using errcode = '42501';
  end if;
  perform set_config('axiom.mfa_recovery', 'on', true);
  select * into v_swap from public.activate_totp_factor(p_subject_id, p_factor_id, p_last_used_counter);
  if v_swap.activated_factor_id is null then
    raise exception 'MFA recovery enrolment refused' using errcode = '42501';
  end if;
  v_now := clock_timestamp();
  -- Every old credential leaves: other TOTP rows, all recovery codes, all
  -- attestations. Retired, not deleted, so challenge history still resolves.
  update public.user_mfa_factors set status = 'revoked', revoked_at = v_now
   where user_id = p_subject_id and status <> 'revoked' and id <> p_factor_id;
  insert into public.user_mfa_factors(user_id, factor_type, status, code_hash)
    select p_subject_id, 'recovery_code', 'active', h from unnest(p_recovery_hashes) h;
  update public.mfa_session_attestations set revoked_at = v_now
   where user_id = p_subject_id and revoked_at is null;
  update public.mfa_account_fences set epoch = epoch + 1, updated_at = v_now
   where user_id = p_subject_id;
  update public.mfa_recovery_cases
     set state = 'completed', completed_at = v_now, activated_factor_id = p_factor_id,
         grant_expires_at = v_now
   where id = p_case_id;
  perform public.mfa_recovery_event(p_case_id, 'completed', p_subject_id, p_session_id,
    jsonb_build_object('factor_id', p_factor_id));
  perform set_config('axiom.mfa_recovery', 'off', true);
  return p_factor_id;
end;
$$;

create function public.cancel_mfa_recovery_case(
  p_actor_id uuid, p_actor_session_id uuid, p_case_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.mfa_recovery_cases%rowtype;
begin
  select * into v_case from public.mfa_recovery_cases where id = p_case_id;
  if not found then
    raise exception 'MFA recovery case refused' using errcode = '42501';
  end if;
  perform public.lock_mfa_recovery_accounts(p_actor_id, v_case.subject_user_id);
  perform public.assert_mfa_recovery_actor(p_actor_id, p_actor_session_id);
  select * into v_case from public.mfa_recovery_cases where id = p_case_id for update;
  if v_case.state in ('completed', 'cancelled') then
    raise exception 'MFA recovery case is closed' using errcode = 'PT409';
  end if;
  update public.mfa_recovery_cases
     set state = 'cancelled', cancelled_at = clock_timestamp(), cancelled_by = p_actor_id
   where id = p_case_id;
  perform public.mfa_recovery_event(p_case_id, 'cancelled', p_actor_id, p_actor_session_id);
end;
$$;

-- What the BFF needs on every request: is this session still valid, and is
-- the account under recovery?
create function public.read_mfa_session_access(p_user_id uuid, p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  return jsonb_build_object(
    'session_current', public.session_postdates_fence(p_user_id, p_session_id),
    'recovery', (
      select jsonb_build_object('case_id', c.id, 'state', c.state,
        'bound_here', c.beneficiary_session_id = p_session_id,
        'grant_expires_at', c.grant_expires_at, 'expires_at', c.expires_at)
      from public.mfa_recovery_cases c
      where c.subject_user_id = p_user_id and c.state not in ('completed', 'cancelled')
    )
  );
end;
$$;

-- Founder console: the other live founders and every case the actor can see.
create function public.read_mfa_recovery_overview(p_actor_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_live_platform_founder(p_actor_id) then
    raise exception 'MFA recovery overview refused' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'founders', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', u.id, 'email', u.email, 'full_name', u.full_name)
                       order by u.email)
      from public.platform_founders f join public.users u on u.id = f.user_id
      where f.revoked_at is null and u.is_axiom_internal and u.id <> p_actor_id), '[]'::jsonb),
    'cases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'case_id', c.id, 'subject_user_id', c.subject_user_id, 'actor_user_id', c.actor_user_id,
        'state', c.state, 'reason', c.reason, 'cutoff_at', c.cutoff_at, 'expires_at', c.expires_at,
        'beneficiary_session', case when c.beneficiary_session_id is null then null else (
          select jsonb_build_object('session_id', s.id, 'created_at', s.created_at,
                                    'user_agent', s.user_agent, 'ip', s.ip::text)
          from auth.sessions s where s.id = c.beneficiary_session_id) end,
        'grant_expires_at', c.grant_expires_at, 'completed_at', c.completed_at,
        'cancelled_at', c.cancelled_at) order by c.created_at desc)
      from public.mfa_recovery_cases c
      where c.created_at > clock_timestamp() - interval '30 days'), '[]'::jsonb)
  );
end;
$$;

revoke all on function
  public.jwt_session_id(),
  public.session_is_current(),
  public.session_postdates_fence(uuid, uuid),
  public.mfa_recovery_open_case(uuid),
  public.guard_mfa_writes_during_recovery(),
  public.guard_mfa_attestation_fence(),
  public.guard_mfa_recovery_events(),
  public.mfa_recovery_event(uuid, text, uuid, uuid, jsonb),
  public.mfa_recovery_live_session(uuid, uuid),
  public.assert_mfa_recovery_actor(uuid, uuid),
  public.consume_mfa_recovery_challenge(uuid, uuid, text),
  public.lock_mfa_recovery_accounts(uuid, uuid),
  public.open_mfa_recovery_case(uuid, uuid, uuid, uuid, text),
  public.bind_mfa_recovery_session(uuid, uuid, uuid),
  public.authorize_mfa_recovery_session(uuid, uuid, uuid, uuid, uuid),
  public.begin_recovery_totp_enrolment(uuid, uuid, uuid, text, text),
  public.finalize_recovery_totp_enrolment(uuid, uuid, uuid, uuid, bigint, text[]),
  public.cancel_mfa_recovery_case(uuid, uuid, uuid),
  public.read_mfa_session_access(uuid, uuid),
  public.read_mfa_recovery_overview(uuid)
  from public, anon, authenticated;
grant execute on function public.session_is_current(), public.jwt_session_id() to authenticated;
grant execute on function
  public.open_mfa_recovery_case(uuid, uuid, uuid, uuid, text),
  public.bind_mfa_recovery_session(uuid, uuid, uuid),
  public.authorize_mfa_recovery_session(uuid, uuid, uuid, uuid, uuid),
  public.begin_recovery_totp_enrolment(uuid, uuid, uuid, text, text),
  public.finalize_recovery_totp_enrolment(uuid, uuid, uuid, uuid, bigint, text[]),
  public.cancel_mfa_recovery_case(uuid, uuid, uuid),
  public.read_mfa_session_access(uuid, uuid),
  public.read_mfa_recovery_overview(uuid)
  to service_role;
