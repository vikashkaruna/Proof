-- ─────────────────────────────────────────────────────────────────────
-- 0151_platform_founder_authority.sql
--
-- A live platform founder reaches every current and future tenant without a
-- per-tenant grant (e450). Authority comes from one protected designation,
-- never from a browser claim, a role header or the internal-employee flag.
--
-- Rather than teach ~66 migrations' worth of SQL writers, RLS helpers, the BFF
-- resolver and SSR selection a second authority path, the designation
-- *derives* ordinary `founder` rows in tenant_users. Every existing check then
-- agrees by construction:
--   • a new tenant gets a row for each live founder in the same transaction;
--   • designating a founder adds rows for every tenant;
--   • revoking the designation, or clearing users.is_axiom_internal, deletes
--     the derived rows in the same transaction (live revocation).
-- Explicit memberships are never created, changed or deleted by this path, so
-- legacy membership, approval, evidence and ledger history is preserved. An
-- explicit row (any role) takes precedence over a derived one.
--
-- Not widened: axiom_analyst, owners, partners and agents. The internal flag
-- alone buys nothing (analyst-boundary.test.sql still holds).
-- ─────────────────────────────────────────────────────────────────────

create table public.platform_founders (
  user_id uuid primary key references public.users(id) on delete cascade,
  designated_at timestamptz not null default now(),
  designated_by text not null check (length(btrim(designated_by)) > 0),
  designation_reason text not null check (length(btrim(designation_reason)) > 0),
  revoked_at timestamptz,
  revoked_by text,
  revocation_reason text,
  check ((revoked_at is null) = (revoked_by is null)),
  check ((revoked_at is null) = (revocation_reason is null))
);

alter table public.platform_founders enable row level security;
revoke all on public.platform_founders from public, anon, authenticated, service_role;
-- A founder may see their own designation; nobody else's.
grant select on public.platform_founders to authenticated, service_role;
create policy platform_founders_service_read on public.platform_founders
  for select to service_role using (true);
create policy platform_founders_self_read on public.platform_founders
  for select to authenticated using (user_id = auth.uid());

alter table public.tenant_users
  add column membership_source text not null default 'explicit'
  check (membership_source in ('explicit', 'platform_founder'));
alter table public.tenant_users
  add constraint tenant_users_derived_founder_role
  check (membership_source = 'explicit' or role = 'founder');

create function public.is_live_platform_founder(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.platform_founders f
    join public.users u on u.id = f.user_id
    where f.user_id = p_user_id and f.revoked_at is null and u.is_axiom_internal
  );
$$;

-- Derived rows are written only inside this function. The guard trigger below
-- refuses any other insert, update or delete that touches them.
create function public.sync_platform_founder_memberships(
  p_user_id uuid default null,
  p_tenant_id uuid default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('axiom.platform_founder_sync', 'on', true);

  delete from public.tenant_users m
  where m.membership_source = 'platform_founder'
    and (p_user_id is null or m.user_id = p_user_id)
    and (p_tenant_id is null or m.tenant_id = p_tenant_id)
    and not public.is_live_platform_founder(m.user_id);

  insert into public.tenant_users(tenant_id, user_id, role, accepted_at, membership_source)
  select t.id, f.user_id, 'founder', now(), 'platform_founder'
  from public.platform_founders f
  join public.users u on u.id = f.user_id and u.is_axiom_internal
  cross join public.tenants t
  where f.revoked_at is null
    and (p_user_id is null or f.user_id = p_user_id)
    and (p_tenant_id is null or t.id = p_tenant_id)
  on conflict (tenant_id, user_id) do nothing;

  perform set_config('axiom.platform_founder_sync', 'off', true);
end;
$$;

create function public.guard_derived_founder_membership()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('axiom.platform_founder_sync', true) is distinct from 'on' then
    if tg_op in ('INSERT', 'UPDATE') and new.membership_source = 'platform_founder' then
      raise exception 'derived founder membership is maintained by platform_founders only'
        using errcode = '42501';
    end if;
    -- A tenant or user deletion cascades here after its parent row is gone;
    -- that is not a membership edit and must not be blocked.
    if tg_op = 'DELETE' and old.membership_source = 'platform_founder'
       and (not exists (select 1 from public.tenants where id = old.tenant_id)
            or not exists (select 1 from public.users where id = old.user_id)) then
      return old;
    end if;
    if tg_op in ('UPDATE', 'DELETE') and old.membership_source = 'platform_founder' then
      raise exception 'derived founder membership is maintained by platform_founders only'
        using errcode = '42501';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger tenant_users_guard_derived_founder
  before insert or update or delete on public.tenant_users
  for each row execute function public.guard_derived_founder_membership();

-- Designation rows are append-and-revoke only: no deletion, no un-revoke, no
-- rewriting who designated whom.
create function public.guard_platform_founder_designation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'platform founder designations are retained' using errcode = '42501';
  end if;
  if old.revoked_at is not null
     or new.user_id is distinct from old.user_id
     or new.designated_at is distinct from old.designated_at
     or new.designated_by is distinct from old.designated_by
     or new.designation_reason is distinct from old.designation_reason then
    raise exception 'platform founder designation may only be revoked once' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger platform_founders_guard
  before update or delete on public.platform_founders
  for each row execute function public.guard_platform_founder_designation();

create function public.platform_founders_after_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.sync_platform_founder_memberships(new.user_id, null);
  return null;
end;
$$;

create trigger platform_founders_sync
  after insert or update on public.platform_founders
  for each row execute function public.platform_founders_after_change();

create function public.tenants_after_insert_founders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.sync_platform_founder_memberships(null, new.id);
  return null;
end;
$$;

create trigger tenants_platform_founders
  after insert on public.tenants
  for each row execute function public.tenants_after_insert_founders();

create function public.users_internal_change_founders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.sync_platform_founder_memberships(new.id, null);
  return null;
end;
$$;

create trigger users_platform_founders
  after update of is_axiom_internal on public.users
  for each row when (old.is_axiom_internal is distinct from new.is_axiom_internal)
  execute function public.users_internal_change_founders();

-- Removing a live founder's explicit membership must not remove their access:
-- re-derive it for that tenant.
create function public.tenant_users_after_explicit_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.tenants where id = old.tenant_id)
     and public.is_live_platform_founder(old.user_id) then
    perform public.sync_platform_founder_memberships(old.user_id, old.tenant_id);
  end if;
  return null;
end;
$$;

create trigger tenant_users_rederive_founder
  after delete on public.tenant_users
  for each row when (old.membership_source = 'explicit')
  execute function public.tenant_users_after_explicit_delete();

-- Operator entry points. Only the service role (the BFF's audited admin path
-- or an operator session) may designate or revoke; never a signed-in user.
create function public.designate_platform_founder(
  p_user_id uuid,
  p_designated_by text,
  p_reason text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.users where id = p_user_id and is_axiom_internal) then
    raise exception 'only an internal user can be designated platform founder' using errcode = '42501';
  end if;
  insert into public.platform_founders(user_id, designated_by, designation_reason)
  values (p_user_id, p_designated_by, p_reason);
end;
$$;

create function public.revoke_platform_founder(
  p_user_id uuid,
  p_revoked_by text,
  p_reason text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.platform_founders
  set revoked_at = now(), revoked_by = p_revoked_by, revocation_reason = p_reason
  where user_id = p_user_id and revoked_at is null;
  if not found then
    raise exception 'no live platform founder designation' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.is_live_platform_founder(uuid),
  public.sync_platform_founder_memberships(uuid, uuid),
  public.guard_derived_founder_membership(),
  public.guard_platform_founder_designation(),
  public.platform_founders_after_change(),
  public.tenants_after_insert_founders(),
  public.users_internal_change_founders(),
  public.tenant_users_after_explicit_delete(),
  public.designate_platform_founder(uuid, text, text),
  public.revoke_platform_founder(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.is_live_platform_founder(uuid) to authenticated, service_role;
grant execute on function public.designate_platform_founder(uuid, text, text),
  public.revoke_platform_founder(uuid, text, text) to service_role;

-- Backfill: an internal user who already holds an explicit founder membership
-- is a platform founder today. Their explicit rows are untouched; rows for the
-- tenants they were missing are derived.
insert into public.platform_founders(user_id, designated_by, designation_reason)
select distinct m.user_id, 'migration 0151', 'existing internal founder membership'
from public.tenant_users m
join public.users u on u.id = m.user_id and u.is_axiom_internal
where m.role = 'founder';
