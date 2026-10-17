-- ─────────────────────────────────────────────────────────────────────
-- 0154_scoped_owner_recovery_delegation.sql
--
-- A live platform founder may delegate MFA recovery of ordinary members to a
-- tenant owner (e447–e449): scoped to ONE tenant, an explicit set of target
-- roles (approver/reviewer/viewer only), an expiry and a version, and
-- revocable. The same fence, bound session, one-shot grant and receipts from
-- 0152 apply; only who may act changes.
--
-- A delegated owner can NEVER recover: themselves, an internal or founder
-- account, anyone holding owner/admin/founder/axiom_analyst/partner/agent
-- anywhere, or anyone with a membership outside the delegated tenant. Every
-- eligibility fact is re-checked at open AND authorize. Membership inserts and
-- role changes take the same per-subject lock as recovery and are refused
-- while a delegated case is open, so nobody can be promoted or moved into a
-- second tenant mid-recovery.
-- ─────────────────────────────────────────────────────────────────────

create table public.mfa_recovery_delegations (
  id uuid primary key default gen_random_uuid(),
  founder_user_id uuid not null references public.users(id),
  owner_user_id uuid not null references public.users(id),
  tenant_id uuid not null references public.tenants(id),
  target_roles user_role[] not null check (
    cardinality(target_roles) between 1 and 3
    and target_roles <@ array['approver', 'reviewer', 'viewer']::user_role[]),
  version integer not null default 1 check (version >= 1),
  reason text not null check (length(btrim(reason)) between 10 and 1000),
  issued_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references public.users(id),
  revocation_reason text,
  check (founder_user_id <> owner_user_id),
  check (expires_at > issued_at and expires_at <= issued_at + interval '31 days'),
  check ((revoked_at is null) = (revoked_by is null)),
  check ((revoked_at is null) = (revocation_reason is null))
);
alter table public.mfa_recovery_delegations enable row level security;
revoke all on public.mfa_recovery_delegations from public, anon, authenticated, service_role;

alter table public.mfa_recovery_cases
  add column kind text not null default 'founder' check (kind in ('founder', 'delegated_owner')),
  add column delegation_id uuid references public.mfa_recovery_delegations(id),
  add column delegation_version integer,
  add column tenant_id uuid references public.tenants(id),
  add constraint mfa_recovery_cases_delegation_shape check (
    (kind = 'founder' and delegation_id is null and tenant_id is null)
    or (kind = 'delegated_owner' and delegation_id is not null and tenant_id is not null
        and delegation_version is not null));

-- ─── Shared actor checks ─────────────────────────────────────────────
-- Live session after any fence, active authenticator, live MFA attestation on
-- this session, and not itself under recovery.
create function public.assert_mfa_recovery_session_actor(p_actor uuid, p_session uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_actor is null or p_session is null
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

-- The delegation is live, unchanged, held by this explicit owner of its tenant.
create function public.assert_live_recovery_delegation(
  p_delegation uuid, p_owner uuid, p_version integer
) returns public.mfa_recovery_delegations
language plpgsql security definer set search_path = '' as $$
declare
  d public.mfa_recovery_delegations%rowtype;
begin
  select * into d from public.mfa_recovery_delegations where id = p_delegation for share;
  if not found or d.owner_user_id is distinct from p_owner or d.revoked_at is not null
     or d.expires_at <= clock_timestamp()
     or (p_version is not null and d.version <> p_version)
     or not public.is_live_platform_founder(d.founder_user_id)
     or exists (select 1 from public.users where id = p_owner and is_axiom_internal)
     or not exists (
       select 1 from public.tenant_users
       where tenant_id = d.tenant_id and user_id = p_owner
         and role = 'owner' and membership_source = 'explicit') then
    raise exception 'MFA recovery delegation refused' using errcode = '42501';
  end if;
  return d;
end;
$$;

-- The subject is an ordinary member of exactly the delegated tenant, in a
-- delegated role, and nothing more privileged anywhere.
create function public.assert_delegated_recovery_subject(
  p_subject uuid, p_owner uuid, d public.mfa_recovery_delegations
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_subject is null or p_subject = p_owner or p_subject = d.founder_user_id
     or exists (select 1 from public.users where id = p_subject and is_axiom_internal)
     or exists (select 1 from public.platform_founders where user_id = p_subject)
     or exists (
       select 1 from public.tenant_users
       where user_id = p_subject
         and (tenant_id <> d.tenant_id
              or role in ('owner', 'admin', 'founder', 'axiom_analyst', 'partner', 'agent')
              or not (role = any (d.target_roles))))
     or not exists (
       select 1 from public.tenant_users where user_id = p_subject and tenant_id = d.tenant_id) then
    raise exception 'subject is outside this recovery delegation' using errcode = '42501';
  end if;
end;
$$;

-- ─── Membership serialization ────────────────────────────────────────
create function public.guard_membership_during_delegated_recovery() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.role is not distinct from old.role
     and new.tenant_id is not distinct from old.tenant_id
     and new.user_id is not distinct from old.user_id then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 152));
  if exists (
    select 1 from public.mfa_recovery_cases
    where subject_user_id = new.user_id and kind = 'delegated_owner'
      and state not in ('completed', 'cancelled')) then
    raise exception 'membership change refused during delegated MFA recovery' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger tenant_users_delegated_recovery_guard
  before insert or update on public.tenant_users
  for each row execute function public.guard_membership_during_delegated_recovery();

-- ─── Delegation RPCs ─────────────────────────────────────────────────
create function public.issue_mfa_recovery_delegation(
  p_founder_id uuid, p_founder_session_id uuid, p_challenge_id uuid,
  p_owner_id uuid, p_tenant_id uuid, p_target_roles user_role[],
  p_expires_at timestamptz, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  d public.mfa_recovery_delegations%rowtype;
begin
  perform public.assert_mfa_recovery_actor(p_founder_id, p_founder_session_id);
  if p_owner_id is null or p_owner_id = p_founder_id
     or exists (select 1 from public.users where id = p_owner_id and is_axiom_internal)
     or not exists (
       select 1 from public.tenant_users
       where tenant_id = p_tenant_id and user_id = p_owner_id
         and role = 'owner' and membership_source = 'explicit') then
    raise exception 'delegate must be an explicit owner of the tenant' using errcode = '42501';
  end if;
  perform public.consume_mfa_recovery_challenge(p_founder_id, p_challenge_id,
    'delegate:' || p_owner_id || ':' || p_tenant_id);
  insert into public.mfa_recovery_delegations(
    founder_user_id, owner_user_id, tenant_id, target_roles, reason, expires_at)
  values (p_founder_id, p_owner_id, p_tenant_id, p_target_roles, btrim(p_reason), p_expires_at)
  returning * into d;
  return jsonb_build_object('delegation_id', d.id, 'version', d.version, 'expires_at', d.expires_at);
end;
$$;

create function public.revoke_mfa_recovery_delegation(
  p_founder_id uuid, p_founder_session_id uuid, p_delegation_id uuid, p_reason text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_mfa_recovery_actor(p_founder_id, p_founder_session_id);
  update public.mfa_recovery_delegations
     set revoked_at = clock_timestamp(), revoked_by = p_founder_id,
         revocation_reason = coalesce(nullif(btrim(p_reason), ''), 'revoked'),
         version = version + 1
   where id = p_delegation_id and revoked_at is null;
  if not found then
    raise exception 'no live delegation' using errcode = 'P0002';
  end if;
end;
$$;

create function public.open_delegated_mfa_recovery_case(
  p_owner_id uuid, p_owner_session_id uuid, p_challenge_id uuid,
  p_delegation_id uuid, p_subject_id uuid, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  d public.mfa_recovery_delegations%rowtype;
  v_now timestamptz;
  v_epoch bigint;
  v_case public.mfa_recovery_cases%rowtype;
begin
  if p_owner_id is null or p_subject_id is null or p_owner_id = p_subject_id then
    raise exception 'self-recovery refused' using errcode = '42501';
  end if;
  perform public.lock_mfa_recovery_accounts(p_owner_id, p_subject_id);
  perform public.assert_mfa_recovery_session_actor(p_owner_id, p_owner_session_id);
  d := public.assert_live_recovery_delegation(p_delegation_id, p_owner_id, null);
  perform public.assert_delegated_recovery_subject(p_subject_id, p_owner_id, d);
  perform set_config('axiom.mfa_recovery', 'on', true);
  update public.mfa_recovery_cases set state = 'cancelled', cancelled_at = clock_timestamp()
   where subject_user_id = p_subject_id and state not in ('completed', 'cancelled')
     and expires_at <= clock_timestamp();
  if public.mfa_recovery_open_case(p_subject_id) is not null then
    raise exception 'a recovery case is already open for this account' using errcode = 'PT409';
  end if;
  perform public.consume_mfa_recovery_challenge(p_owner_id, p_challenge_id,
    'open:' || p_subject_id || ':' || p_delegation_id);

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
    subject_user_id, actor_user_id, actor_session_id, reason, epoch, cutoff_at, state, expires_at,
    kind, delegation_id, delegation_version, tenant_id)
  values (p_subject_id, p_owner_id, p_owner_session_id, btrim(p_reason), v_epoch, v_now, 'opened',
          v_now + interval '24 hours', 'delegated_owner', d.id, d.version, d.tenant_id)
  returning * into v_case;
  perform public.mfa_recovery_event(v_case.id, 'opened', p_owner_id, p_owner_session_id,
    jsonb_build_object('subject_user_id', p_subject_id, 'epoch', v_epoch, 'reason', v_case.reason,
                       'delegation_id', d.id, 'delegation_version', d.version, 'tenant_id', d.tenant_id));
  perform set_config('axiom.mfa_recovery', 'off', true);
  return jsonb_build_object('case_id', v_case.id, 'epoch', v_epoch,
    'cutoff_at', v_case.cutoff_at, 'expires_at', v_case.expires_at);
end;
$$;

-- The actor of a case, re-checked at every step: a founder case needs a live
-- founder; a delegated case needs the same owner, the same unrevoked
-- delegation version, and a subject still inside it.
create function public.assert_mfa_recovery_case_actor(
  c public.mfa_recovery_cases, p_actor uuid, p_session uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  d public.mfa_recovery_delegations%rowtype;
begin
  if c.actor_user_id is distinct from p_actor then
    raise exception 'MFA recovery actor refused' using errcode = '42501';
  end if;
  if c.kind = 'founder' then
    perform public.assert_mfa_recovery_actor(p_actor, p_session);
    if not public.is_live_platform_founder(c.subject_user_id) then
      raise exception 'MFA recovery authorization refused' using errcode = '42501';
    end if;
  else
    perform public.assert_mfa_recovery_session_actor(p_actor, p_session);
    d := public.assert_live_recovery_delegation(c.delegation_id, p_actor, c.delegation_version);
    perform public.assert_delegated_recovery_subject(c.subject_user_id, p_actor, d);
  end if;
end;
$$;

create or replace function public.authorize_mfa_recovery_session(
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
  perform public.assert_mfa_recovery_case_actor(v_case, p_actor_id, p_actor_session_id);
  if v_case.state <> 'bound' or v_case.expires_at <= clock_timestamp()
     or v_case.beneficiary_session_id is distinct from p_beneficiary_session_id
     or not public.mfa_recovery_live_session(v_case.subject_user_id, p_beneficiary_session_id) then
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

create or replace function public.cancel_mfa_recovery_case(
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
  select * into v_case from public.mfa_recovery_cases where id = p_case_id for update;
  if v_case.state in ('completed', 'cancelled') then
    raise exception 'MFA recovery case is closed' using errcode = 'PT409';
  end if;
  -- Any live founder may stop a case; a delegated owner only their own while
  -- the delegation still stands.
  if public.is_live_platform_founder(p_actor_id) then
    perform public.assert_mfa_recovery_actor(p_actor_id, p_actor_session_id);
  else
    perform public.assert_mfa_recovery_case_actor(v_case, p_actor_id, p_actor_session_id);
  end if;
  update public.mfa_recovery_cases
     set state = 'cancelled', cancelled_at = clock_timestamp(), cancelled_by = p_actor_id
   where id = p_case_id;
  perform public.mfa_recovery_event(p_case_id, 'cancelled', p_actor_id, p_actor_session_id);
end;
$$;

-- What an owner (or founder) sees: delegations they hold or issued, the
-- members each delegation could recover, and their own cases.
create function public.read_mfa_recovery_delegations(p_actor_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_founder boolean := public.is_live_platform_founder(p_actor_id);
begin
  return jsonb_build_object(
    'owners', case when v_founder then coalesce((
      select jsonb_agg(jsonb_build_object('user_id', u.id, 'email', u.email, 'tenant_id', m.tenant_id)
                       order by u.email)
      from public.tenant_users m join public.users u on u.id = m.user_id
      where m.role = 'owner' and m.membership_source = 'explicit' and not u.is_axiom_internal
    ), '[]'::jsonb) else '[]'::jsonb end,
    'delegations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'delegation_id', d.id, 'founder_user_id', d.founder_user_id,
        'owner_user_id', d.owner_user_id,
        'owner_email', (select email from public.users where id = d.owner_user_id),
        'tenant_id', d.tenant_id, 'tenant_name', (select name from public.tenants where id = d.tenant_id),
        'target_roles', d.target_roles, 'version', d.version, 'reason', d.reason,
        'expires_at', d.expires_at, 'revoked_at', d.revoked_at,
        'eligible', case when d.owner_user_id = p_actor_id and d.revoked_at is null
                          and d.expires_at > clock_timestamp() then coalesce((
          select jsonb_agg(jsonb_build_object('user_id', u.id, 'email', u.email, 'role', m.role)
                           order by u.email)
          from public.tenant_users m join public.users u on u.id = m.user_id
          where m.tenant_id = d.tenant_id and m.role = any (d.target_roles)
            and u.id <> p_actor_id and not u.is_axiom_internal
            and not exists (select 1 from public.platform_founders f where f.user_id = u.id)
            and not exists (
              select 1 from public.tenant_users o where o.user_id = u.id
                and (o.tenant_id <> d.tenant_id
                     or o.role in ('owner','admin','founder','axiom_analyst','partner','agent')))
        ), '[]'::jsonb) else '[]'::jsonb end
      ) order by d.issued_at desc)
      from public.mfa_recovery_delegations d
      where (v_founder or d.owner_user_id = p_actor_id)
        and (d.revoked_at is null or d.revoked_at > clock_timestamp() - interval '30 days')), '[]'::jsonb),
    'cases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'case_id', c.id, 'subject_user_id', c.subject_user_id,
        'subject_email', (select email from public.users where id = c.subject_user_id),
        'state', c.state, 'reason', c.reason, 'expires_at', c.expires_at,
        'beneficiary_session', case when c.beneficiary_session_id is null then null else (
          select jsonb_build_object('session_id', s.id, 'created_at', s.created_at,
                                    'user_agent', s.user_agent)
          from auth.sessions s where s.id = c.beneficiary_session_id) end) order by c.created_at desc)
      from public.mfa_recovery_cases c
      where c.kind = 'delegated_owner' and c.actor_user_id = p_actor_id
        and c.state not in ('completed', 'cancelled')), '[]'::jsonb)
  );
end;
$$;

revoke all on function
  public.assert_mfa_recovery_session_actor(uuid, uuid),
  public.assert_live_recovery_delegation(uuid, uuid, integer),
  public.assert_delegated_recovery_subject(uuid, uuid, public.mfa_recovery_delegations),
  public.guard_membership_during_delegated_recovery(),
  public.issue_mfa_recovery_delegation(uuid, uuid, uuid, uuid, uuid, user_role[], timestamptz, text),
  public.revoke_mfa_recovery_delegation(uuid, uuid, uuid, text),
  public.open_delegated_mfa_recovery_case(uuid, uuid, uuid, uuid, uuid, text),
  public.assert_mfa_recovery_case_actor(public.mfa_recovery_cases, uuid, uuid),
  public.read_mfa_recovery_delegations(uuid)
  from public, anon, authenticated;
grant execute on function
  public.issue_mfa_recovery_delegation(uuid, uuid, uuid, uuid, uuid, user_role[], timestamptz, text),
  public.revoke_mfa_recovery_delegation(uuid, uuid, uuid, text),
  public.open_delegated_mfa_recovery_case(uuid, uuid, uuid, uuid, uuid, text),
  public.read_mfa_recovery_delegations(uuid)
  to service_role;
