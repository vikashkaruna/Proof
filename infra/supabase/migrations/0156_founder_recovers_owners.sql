-- 0156: a live platform founder may also recover a tenant OWNER or ADMIN who
-- lost their authenticator. Before this, founder recovery (0152) accepted only
-- another live founder, and delegated owners (0154) only ordinary members, so
-- an owner had no recovery path at all.
--
-- Every 0152 safeguard is unchanged and applies to the new subjects: the actor
-- is a live founder with an attested session and a fresh purpose-bound
-- step-up; opening the case fences and ends all of the subject's sessions; the
-- subject binds a fresh session; the founder confirms that exact session; the
-- subject enrols a new TOTP once; every step is an append-only event.
--
-- Recoverable by a founder: a live platform founder, or a NON-internal user
-- with an explicit (not derived) owner or admin membership in some tenant.
-- Internal non-founders (e.g. analysts) and ordinary members stay out; the
-- latter remain the delegated-owner path (0154).

create function public.founder_recoverable_subject(p_subject uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_subject is not null and (
    public.is_live_platform_founder(p_subject)
    or (
      not exists (select 1 from public.users u where u.id = p_subject and u.is_axiom_internal)
      and exists (
        select 1 from public.tenant_users m
        where m.user_id = p_subject and m.membership_source = 'explicit'
          and m.role in ('owner', 'admin'))
    ));
$$;
revoke all on function public.founder_recoverable_subject(uuid) from public, anon, authenticated;

create or replace function public.open_mfa_recovery_case(
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
  if not public.founder_recoverable_subject(p_subject_id) then
    raise exception 'subject is not a founder, owner or admin' using errcode = '42501';
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

-- Re-checked at every step (0154): a founder case now needs a subject that is
-- still founder-recoverable (an owner demoted mid-case stops the case).
create or replace function public.assert_mfa_recovery_case_actor(
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
    if not public.founder_recoverable_subject(c.subject_user_id) then
      raise exception 'MFA recovery authorization refused' using errcode = '42501';
    end if;
  else
    perform public.assert_mfa_recovery_session_actor(p_actor, p_session);
    d := public.assert_live_recovery_delegation(c.delegation_id, p_actor, c.delegation_version);
    perform public.assert_delegated_recovery_subject(c.subject_user_id, p_actor, d);
  end if;
end;
$$;

-- The console lists founders (unchanged) and, new, recoverable owners/admins
-- with their explicit tenant roles.
create or replace function public.read_mfa_recovery_overview(p_actor_id uuid) returns jsonb
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
    'owners', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', o.id, 'email', o.email, 'full_name', o.full_name,
                                          'roles', o.roles) order by o.email)
      from (
        select u.id, u.email, u.full_name,
               jsonb_agg(distinct jsonb_build_object('tenant_id', m.tenant_id, 'role', m.role)) as roles
        from public.users u join public.tenant_users m on m.user_id = u.id
        where not u.is_axiom_internal and u.id <> p_actor_id
          and m.membership_source = 'explicit' and m.role in ('owner', 'admin')
        group by u.id, u.email, u.full_name) o), '[]'::jsonb),
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
