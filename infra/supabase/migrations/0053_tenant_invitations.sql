-- C-W1-3: tenant invitations. An owner/admin invites an email address to a
-- client role; the invitee accepts while signed in as that exact, confirmed
-- email. Creation, revocation and acceptance are each atomic with their ledger
-- entry. The raw invitation token never reaches the database: only its SHA-256.
-- Delivery status records only what the provider confirmed (see 0052).
-- Internal roles (founder, axiom_analyst, agent) and partner are never
-- granted by invitation; they are provisioned explicitly.
alter type public.ledger_action_type add value if not exists 'tenant.invitation.created';
alter type public.ledger_action_type add value if not exists 'tenant.invitation.revoked';
alter type public.ledger_action_type add value if not exists 'tenant.invitation.accepted';

create table public.tenant_invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  email text not null check (email = lower(email) and char_length(email) between 3 and 320 and position('@' in email) > 1),
  role public.user_role not null check (role in ('owner','admin','approver','reviewer','viewer')),
  approval_scopes text[] not null default '{}' check (cardinality(approval_scopes) <= 32),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references public.users(id) on delete restrict,
  revoked_at timestamptz,
  revoked_by uuid references public.users(id) on delete restrict,
  delivery_status text not null default 'not_configured'
    check (delivery_status in ('not_configured','pending','sent','failed')),
  delivery_completed_at timestamptz,
  provider_message_id text check (provider_message_id is null or char_length(provider_message_id) between 1 and 200),
  delivery_error_code text check (delivery_error_code is null or delivery_error_code in
    ('provider_refused','provider_unavailable','provider_no_receipt')),
  constraint invitation_lifetime check (expires_at > created_at and expires_at <= created_at + interval '14 days'),
  constraint invitation_single_outcome check (not (accepted_at is not null and revoked_at is not null)),
  constraint invitation_accept_consistent check ((accepted_at is null) = (accepted_by is null)),
  constraint invitation_revoke_consistent check ((revoked_at is null) = (revoked_by is null)),
  constraint invitation_delivery_consistent check (
    (delivery_status in ('not_configured','pending') and delivery_completed_at is null
       and provider_message_id is null and delivery_error_code is null)
    or (delivery_status = 'sent' and delivery_completed_at is not null
       and provider_message_id is not null and delivery_error_code is null)
    or (delivery_status = 'failed' and delivery_completed_at is not null
       and provider_message_id is null and delivery_error_code is not null)
  )
);
-- At most one open invitation per address and tenant (expired ones are
-- closed lazily by the create RPC, which revokes nothing but checks expiry).
create unique index tenant_invitations_one_open on public.tenant_invitations(tenant_id, email)
  where accepted_at is null and revoked_at is null;
create index idx_tenant_invitations_tenant on public.tenant_invitations(tenant_id, created_at desc);

alter table public.tenant_invitations enable row level security;
revoke all on public.tenant_invitations from public, anon, authenticated, service_role;
-- Reads go through the BFF (which never selects token_hash for display) or
-- through tenant owners/admins in their own session. Writes are RPC-only.
grant select on public.tenant_invitations to service_role;
create policy invitation_backend_read on public.tenant_invitations for select to service_role using (true);
grant select (id, tenant_id, email, role, approval_scopes, invited_by, created_at, expires_at,
  accepted_at, accepted_by, revoked_at, revoked_by, delivery_status, delivery_completed_at)
  on public.tenant_invitations to authenticated;
create policy invitation_admin_read on public.tenant_invitations for select to authenticated using (
  exists (select 1 from public.tenant_users m where m.tenant_id = tenant_invitations.tenant_id
          and m.user_id = auth.uid() and m.role in ('founder','owner','admin'))
);
-- Only the settle update is allowed, and only on the delivery columns.
grant update (delivery_status, delivery_completed_at, provider_message_id, delivery_error_code)
  on public.tenant_invitations to service_role;
create policy invitation_backend_settle on public.tenant_invitations for update to service_role
  using (delivery_status = 'pending' and accepted_at is null and revoked_at is null) with check (true);

-- Invitation content is immutable once written; lifecycle columns move once.
create function public.tenant_invitation_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'invitations are retained' using errcode = '42501';
  end if;
  if (new.id, new.tenant_id, new.email, new.role, new.approval_scopes, new.token_hash,
      new.invited_by, new.created_at, new.expires_at)
     is distinct from
     (old.id, old.tenant_id, old.email, old.role, old.approval_scopes, old.token_hash,
      old.invited_by, old.created_at, old.expires_at) then
    raise exception 'invitation content is immutable' using errcode = '42501';
  end if;
  if (old.accepted_at is not null and new.accepted_at is distinct from old.accepted_at)
     or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at)
     or (old.accepted_by is not null and new.accepted_by is distinct from old.accepted_by)
     or (old.revoked_by is not null and new.revoked_by is distinct from old.revoked_by) then
    raise exception 'invitation outcome already settled' using errcode = '42501';
  end if;
  if old.delivery_status in ('sent','failed','not_configured')
     and new.delivery_status is distinct from old.delivery_status then
    raise exception 'invitation delivery already settled' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger tenant_invitation_guard before update or delete on public.tenant_invitations
  for each row execute function public.tenant_invitation_guard();

-- Whether an inviter may grant a role. Owners (and the founder) may grant any
-- invitable role including owner; admins may not create owners or admins.
create function public.invitation_role_grantable(p_inviter public.user_role, p_role public.user_role)
returns boolean language sql immutable set search_path = '' as $$
  select case
    when p_role not in ('owner','admin','approver','reviewer','viewer') then false
    when p_inviter in ('founder','owner') then true
    when p_inviter = 'admin' then p_role in ('approver','reviewer','viewer')
    else false end;
$$;
revoke all on function public.invitation_role_grantable(public.user_role, public.user_role) from public, anon, authenticated;

create function public.create_tenant_invitation(
  p_tenant_id uuid, p_actor_id uuid, p_email text, p_role public.user_role,
  p_approval_scopes text[], p_token_hash text, p_ttl_hours integer,
  p_deliver boolean, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  inviter public.user_role; normalized text := lower(btrim(p_email)); inv public.tenant_invitations;
begin
  select role into inviter from public.tenant_users
    where tenant_id = p_tenant_id and user_id = p_actor_id and role in ('founder','owner','admin') for share;
  if not found then return jsonb_build_object('error','forbidden'); end if;
  if not public.invitation_role_grantable(inviter, p_role) then
    return jsonb_build_object('error','role_not_grantable');
  end if;
  if p_ttl_hours is null or p_ttl_hours < 1 or p_ttl_hours > 336 then
    return jsonb_build_object('error','invalid_request');
  end if;
  if p_role <> 'approver' and cardinality(coalesce(p_approval_scopes, '{}')) > 0 then
    return jsonb_build_object('error','scopes_require_approver');
  end if;
  if exists (select 1 from public.tenant_users m join public.users u on u.id = m.user_id
             where m.tenant_id = p_tenant_id and lower(u.email) = normalized) then
    return jsonb_build_object('error','already_member');
  end if;
  -- Serialize per (tenant, email) so an expired open invitation is closed
  -- before its replacement, never alongside it.
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || '/' || normalized, 0));
  update public.tenant_invitations set revoked_at = now(), revoked_by = p_actor_id
    where tenant_id = p_tenant_id and email = normalized and accepted_at is null
      and revoked_at is null and expires_at <= now();
  if exists (select 1 from public.tenant_invitations where tenant_id = p_tenant_id and email = normalized
             and accepted_at is null and revoked_at is null) then
    return jsonb_build_object('error','invitation_open');
  end if;
  insert into public.tenant_invitations(tenant_id, email, role, approval_scopes, token_hash, invited_by,
    expires_at, delivery_status)
  values (p_tenant_id, normalized, p_role, coalesce(p_approval_scopes, '{}'), p_token_hash, p_actor_id,
    now() + make_interval(hours => p_ttl_hours), case when p_deliver then 'pending' else 'not_configured' end)
  returning * into inv;
  perform public.append_ledger(p_tenant_id, p_correlation_id, 'human', p_actor_id::text, null, null, null,
    'tenant.invitation.created', inv.id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('role', inv.role, 'approval_scopes', inv.approval_scopes,
      'email_sha256', encode(sha256(convert_to(inv.email, 'UTF8')), 'hex'), 'expires_at', inv.expires_at));
  return jsonb_build_object('invitation', to_jsonb(inv) - 'token_hash');
end $$;

create function public.revoke_tenant_invitation(
  p_tenant_id uuid, p_actor_id uuid, p_invitation_id uuid, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare inviter public.user_role; inv public.tenant_invitations;
begin
  select role into inviter from public.tenant_users
    where tenant_id = p_tenant_id and user_id = p_actor_id and role in ('founder','owner','admin') for share;
  if not found then return jsonb_build_object('error','forbidden'); end if;
  select * into inv from public.tenant_invitations where tenant_id = p_tenant_id and id = p_invitation_id for update;
  if not found then return jsonb_build_object('error','not_found'); end if;
  if not public.invitation_role_grantable(inviter, inv.role) then return jsonb_build_object('error','role_not_grantable'); end if;
  if inv.accepted_at is not null then return jsonb_build_object('error','already_accepted'); end if;
  if inv.revoked_at is not null then return jsonb_build_object('invitation', to_jsonb(inv) - 'token_hash'); end if;
  update public.tenant_invitations set revoked_at = now(), revoked_by = p_actor_id where id = inv.id returning * into inv;
  perform public.append_ledger(p_tenant_id, p_correlation_id, 'human', p_actor_id::text, null, null, null,
    'tenant.invitation.revoked', inv.id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('role', inv.role));
  return jsonb_build_object('invitation', to_jsonb(inv) - 'token_hash');
end $$;

-- The invitee proves possession of the token and must be signed in as the
-- invited, confirmed email. Membership and acceptance commit together.
create function public.accept_tenant_invitation(
  p_token_hash text, p_user_id uuid, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare inv public.tenant_invitations; account_email text; confirmed timestamptz; membership public.tenant_users;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('error','not_found'); end if;
  select * into inv from public.tenant_invitations where token_hash = p_token_hash for update;
  if not found then return jsonb_build_object('error','not_found'); end if;
  select lower(email), email_confirmed_at into account_email, confirmed from auth.users where id = p_user_id;
  if not found then return jsonb_build_object('error','forbidden'); end if;
  -- Report a mismatch without revealing the invited address.
  if account_email is distinct from inv.email then return jsonb_build_object('error','email_mismatch'); end if;
  if confirmed is null then return jsonb_build_object('error','email_unconfirmed'); end if;
  if inv.revoked_at is not null then return jsonb_build_object('error','revoked'); end if;
  if inv.accepted_at is not null then
    if inv.accepted_by = p_user_id then
      return jsonb_build_object('tenant_id', inv.tenant_id, 'role', inv.role, 'replayed', true);
    end if;
    return jsonb_build_object('error','already_accepted');
  end if;
  if inv.expires_at <= now() then return jsonb_build_object('error','expired'); end if;
  insert into public.users(id, email) values (p_user_id, account_email) on conflict (id) do nothing;
  insert into public.tenant_users(tenant_id, user_id, role, approval_scopes, invited_at, accepted_at)
    values (inv.tenant_id, p_user_id, inv.role, inv.approval_scopes, inv.created_at, now())
    on conflict (tenant_id, user_id) do nothing
    returning * into membership;
  if membership.id is null then return jsonb_build_object('error','already_member'); end if;
  update public.tenant_invitations set accepted_at = now(), accepted_by = p_user_id where id = inv.id returning * into inv;
  perform public.append_ledger(inv.tenant_id, p_correlation_id, 'human', p_user_id::text, null, null, null,
    'tenant.invitation.accepted', inv.id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('role', inv.role, 'approval_scopes', inv.approval_scopes, 'invited_by', inv.invited_by));
  return jsonb_build_object('tenant_id', inv.tenant_id, 'role', inv.role, 'replayed', false);
end $$;

revoke all on function public.create_tenant_invitation(uuid,uuid,text,public.user_role,text[],text,integer,boolean,uuid) from public, anon, authenticated;
revoke all on function public.revoke_tenant_invitation(uuid,uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.accept_tenant_invitation(text,uuid,uuid) from public, anon, authenticated;
grant execute on function public.create_tenant_invitation(uuid,uuid,text,public.user_role,text[],text,integer,boolean,uuid) to service_role;
grant execute on function public.revoke_tenant_invitation(uuid,uuid,uuid,uuid) to service_role;
grant execute on function public.accept_tenant_invitation(text,uuid,uuid) to service_role;
