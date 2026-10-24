-- Password-authenticated users may ask for help without the lost factor.
-- A request is a notification, never a recovery grant or an account fence.
alter type public.ledger_action_type add value if not exists 'mfa.recovery.requested';
alter type public.ledger_action_type add value if not exists 'mfa.recovery.request.cancelled';

create table controller_security.mfa_recovery_requests (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id),
  subject_user_id uuid not null references public.users(id),
  reviewer_user_id uuid not null references public.users(id),
  reason text not null check (length(btrim(reason)) between 10 and 1000),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp() + interval '24 hours',
  check (subject_user_id <> reviewer_user_id)
);
create table controller_security.mfa_recovery_request_resolutions (
  request_id uuid primary key references controller_security.mfa_recovery_requests(id),
  actor_user_id uuid not null references public.users(id),
  outcome text not null check (outcome = 'cancelled'),
  created_at timestamptz not null default clock_timestamp()
);
create index mfa_recovery_request_subject on controller_security.mfa_recovery_requests(subject_user_id,created_at);
create index mfa_recovery_request_inbox on controller_security.mfa_recovery_requests(reviewer_user_id,tenant_id,expires_at);
create function controller_security.refuse_mfa_request_rewrite() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'recovery request history is immutable' using errcode='42501'; end $$;
create trigger mfa_request_immutable before update or delete on controller_security.mfa_recovery_requests
for each statement execute function controller_security.refuse_mfa_request_rewrite();
create trigger mfa_request_resolution_immutable before update or delete on controller_security.mfa_recovery_request_resolutions
for each statement execute function controller_security.refuse_mfa_request_rewrite();
revoke all on function controller_security.refuse_mfa_request_rewrite() from public,anon,authenticated,service_role,human_action_writer;

alter table controller_security.mfa_recovery_requests enable row level security;
alter table controller_security.mfa_recovery_request_resolutions enable row level security;
revoke all on controller_security.mfa_recovery_requests,
  controller_security.mfa_recovery_request_resolutions from public, anon, authenticated, service_role,
  human_action_writer;

create function public.assert_mfa_request_subject(p_user uuid, p_session uuid, p_tenant uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.mfa_recovery_live_session(p_user, p_session)
     or public.mfa_recovery_open_case(p_user) is not null
     or not exists(select 1 from public.tenant_users where user_id=p_user and tenant_id=p_tenant)
     or not exists(select 1 from public.user_mfa_factors where user_id=p_user
       and factor_type='totp' and status='active') then
    raise exception 'current recovery-request subject required' using errcode='42501';
  end if;
end $$;

create function public.mfa_request_reviewer(p_subject uuid, p_reviewer uuid, p_tenant uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_subject <> p_reviewer and (
    public.is_live_platform_founder(p_reviewer) or exists(
      select 1 from public.tenant_users where user_id=p_reviewer and tenant_id=p_tenant
        and role='owner' and membership_source='explicit'));
$$;

create function public.mfa_request_receipt(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id',r.id,'tenantId',r.tenant_id,'subjectUserId',r.subject_user_id,
    'subjectEmail',(select email from public.users where id=r.subject_user_id),
    'reviewerUserId',r.reviewer_user_id,
    'reviewerEmail',(select email from public.users where id=r.reviewer_user_id),
    'reason',r.reason,'createdAt',r.created_at,'expiresAt',r.expires_at,
    'status',coalesce(d.outcome,case when exists (select 1 from public.mfa_recovery_cases c
      where c.subject_user_id=r.subject_user_id and c.created_at>=r.created_at) then 'recovery_opened'
      when r.expires_at<=clock_timestamp() then 'expired' else 'pending' end))
  from controller_security.mfa_recovery_requests r
  left join controller_security.mfa_recovery_request_resolutions d on d.request_id=r.id
  where r.id=p_id;
$$;

create function public.record_mfa_recovery_request(
  p_actor_id uuid,p_session_id uuid,p_tenant_id uuid,p_request_id uuid,p_reviewer_id uuid,p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r controller_security.mfa_recovery_requests%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_actor_id::text,152));
  perform public.assert_mfa_request_subject(p_actor_id,p_session_id,p_tenant_id);
  if p_request_id is null or p_reason is null or length(btrim(p_reason)) not between 10 and 1000
     or public.mfa_request_reviewer(p_actor_id,p_reviewer_id,p_tenant_id) is not true then
    raise exception 'recovery request refused' using errcode='42501';
  end if;
  select * into r from controller_security.mfa_recovery_requests where id=p_request_id;
  if found then
    if r.subject_user_id<>p_actor_id or r.tenant_id<>p_tenant_id
       or r.reviewer_user_id<>p_reviewer_id or r.reason<>btrim(p_reason) then
      raise exception 'recovery request conflict' using errcode='PT409';
    end if;
    return public.mfa_request_receipt(r.id);
  end if;
  if exists(select 1 from controller_security.mfa_recovery_requests x
    where x.subject_user_id=p_actor_id and x.expires_at>clock_timestamp()
      and not exists(select 1 from controller_security.mfa_recovery_request_resolutions d
        where d.request_id=x.id) and not exists(select 1 from public.mfa_recovery_cases c
        where c.subject_user_id=x.subject_user_id and c.created_at>=x.created_at)) then
    raise exception 'a recovery request is already pending' using errcode='PT409';
  end if;
  insert into controller_security.mfa_recovery_requests(id,tenant_id,subject_user_id,reviewer_user_id,reason)
    values(p_request_id,p_tenant_id,p_actor_id,p_reviewer_id,btrim(p_reason));
  perform public.append_ledger(p_tenant_id,p_request_id,'human'::public.actor_type,p_actor_id::text,
    null,null,null,'mfa.recovery.requested'::public.ledger_action_type,p_request_id::text,
    null,null,null,null,null,null,'success'::public.ledger_result,
    jsonb_build_object('reviewer_user_id',p_reviewer_id,'grants_access',false));
  return public.mfa_request_receipt(p_request_id);
end $$;

create function public.read_mfa_recovery_requests(p_actor_id uuid,p_session_id uuid,p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare can_review boolean;
begin
  if not public.mfa_recovery_live_session(p_actor_id,p_session_id)
     or not exists(select 1 from public.tenant_users where user_id=p_actor_id and tenant_id=p_tenant_id)
     or public.mfa_recovery_open_case(p_actor_id) is not null then
    raise exception 'current recovery-request session required' using errcode='42501';
  end if;
  can_review := exists(select 1 from public.user_mfa_factors where user_id=p_actor_id
    and factor_type='totp' and status='active') and exists(select 1 from public.mfa_session_attestations where user_id=p_actor_id
    and session_id=p_session_id::text and revoked_at is null and expires_at>clock_timestamp());
  return jsonb_build_object(
    'reviewers',coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'email',u.email,
      'kind',case when public.is_live_platform_founder(u.id) then 'founder' else 'owner' end) order by u.email)
      from public.users u where public.mfa_request_reviewer(p_actor_id,u.id,p_tenant_id)),'[]'::jsonb),
    'own',coalesce((select jsonb_agg(public.mfa_request_receipt(r.id) order by r.created_at desc)
      from controller_security.mfa_recovery_requests r where r.subject_user_id=p_actor_id
        and r.tenant_id=p_tenant_id and r.created_at>clock_timestamp()-interval '30 days'),'[]'::jsonb),
    'inbox',case when can_review then coalesce((select jsonb_agg(public.mfa_request_receipt(r.id)
      order by r.created_at) from controller_security.mfa_recovery_requests r
      where r.reviewer_user_id=p_actor_id and r.tenant_id=p_tenant_id
        and public.mfa_request_reviewer(r.subject_user_id,p_actor_id,p_tenant_id)
        and r.expires_at>clock_timestamp() and not exists(select 1 from public.mfa_recovery_cases c
          where c.subject_user_id=r.subject_user_id and c.created_at>=r.created_at) and not exists(
          select 1 from controller_security.mfa_recovery_request_resolutions d where d.request_id=r.id)),
      '[]'::jsonb) else '[]'::jsonb end);
end $$;

create function public.cancel_mfa_recovery_request(
  p_actor_id uuid,p_session_id uuid,p_tenant_id uuid,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r controller_security.mfa_recovery_requests%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_actor_id::text,152));
  perform public.assert_mfa_request_subject(p_actor_id,p_session_id,p_tenant_id);
  select * into r from controller_security.mfa_recovery_requests where id=p_request_id
    and subject_user_id=p_actor_id and tenant_id=p_tenant_id;
  if not found then raise exception 'recovery request refused' using errcode='42501';end if;
  if not exists(select 1 from controller_security.mfa_recovery_request_resolutions where request_id=r.id) then
    insert into controller_security.mfa_recovery_request_resolutions(request_id,actor_user_id,outcome)
      values(r.id,p_actor_id,'cancelled');
    perform public.append_ledger(p_tenant_id,r.id,'human'::public.actor_type,p_actor_id::text,
      null,null,null,'mfa.recovery.request.cancelled'::public.ledger_action_type,r.id::text,
      null,null,null,null,null,null,'success'::public.ledger_result,'{}'::jsonb);
  end if;
  return public.mfa_request_receipt(r.id);
end $$;


revoke all on function public.assert_mfa_request_subject(uuid,uuid,uuid),
 public.mfa_request_reviewer(uuid,uuid,uuid), public.mfa_request_receipt(uuid),
 public.record_mfa_recovery_request(uuid,uuid,uuid,uuid,uuid,text),
 public.read_mfa_recovery_requests(uuid,uuid,uuid),
 public.cancel_mfa_recovery_request(uuid,uuid,uuid,uuid)
 from public,anon,authenticated,service_role,human_action_writer;
grant execute on function public.read_mfa_recovery_requests(uuid,uuid,uuid)
 to service_role,human_action_writer;
grant execute on function public.record_mfa_recovery_request(uuid,uuid,uuid,uuid,uuid,text),
 public.cancel_mfa_recovery_request(uuid,uuid,uuid,uuid) to human_action_writer;
