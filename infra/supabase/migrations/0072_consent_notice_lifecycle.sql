-- W8: reviewed purpose/notice publication and capture provenance.
-- Applied history remains unchanged. Legacy records retain a NULL snapshot
-- hash: observing today's notice does not prove the bytes originally shown.
-- Every new capture pins a retained notice under the same purpose row lock
-- used by publication/deactivation. These are human BFF operations, not
-- authority for agents to mutate downstream systems.

alter type public.ledger_action_type add value if not exists 'consent.purpose.registered';
alter type public.ledger_action_type add value if not exists 'consent.notice.published';
alter type public.ledger_action_type add value if not exists 'consent.purpose.status_changed';

-- Restore 0016's membership-only read boundary. An employee flag alone must
-- never reveal a client's consent principal references or notices.
do $$
declare t text;
begin
  foreach t in array array['consent_purposes','consent_records','consent_withdrawals'] loop
    execute format('drop policy tenant_member_read on public.%I', t);
    execute format('create policy tenant_member_read on public.%I for select to authenticated using (public.is_tenant_member(tenant_id))', t);
    execute format('alter table public.%I drop constraint %I', t, t || '_tenant_id_fkey');
    execute format('alter table public.%I add constraint %I foreign key (tenant_id) references public.tenants(id) on delete restrict', t, t || '_tenant_id_fkey');
  end loop;
end $$;

alter table public.consent_purposes add constraint consent_purposes_tenant_identity unique(tenant_id,id);
create table public.consent_notice_versions (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  purpose_id uuid not null,
  notice_version integer not null check(notice_version > 0),
  notice_en text not null,
  notice_hi text,
  snapshot_sha256 text not null check(snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  provenance text not null check(provenance in ('published','legacy_current')),
  created_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  primary key(tenant_id,purpose_id,notice_version),
  unique(tenant_id,purpose_id,notice_version,snapshot_sha256),
  foreign key(tenant_id,purpose_id) references public.consent_purposes(tenant_id,id) on delete restrict
);
alter table public.consent_notice_versions enable row level security;
revoke all on public.consent_notice_versions from public,anon,authenticated,service_role;
grant select on public.consent_notice_versions to authenticated,service_role;
create policy tenant_member_read on public.consent_notice_versions for select to authenticated
  using(public.is_tenant_member(tenant_id));
create policy bff_service_read on public.consent_notice_versions for select to service_role using(true);

create function public.consent_notice_hash(p_purpose_id uuid, p_version integer, p_en text, p_hi text)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(jsonb_build_object('purpose_id',p_purpose_id,
    'notice_version',p_version,'notice_en',p_en,'notice_hi',p_hi)::text,'UTF8')),'hex');
$$;
revoke all on function public.consent_notice_hash(uuid,integer,text,text) from public,anon,authenticated,service_role;

-- Only the version observed now is available. Do not copy it into other
-- historic version numbers, or claim a fresh human review during migration.
insert into public.consent_notice_versions(tenant_id,purpose_id,notice_version,notice_en,notice_hi,
  snapshot_sha256,provenance,created_by)
select tenant_id,id,notice_version,notice_en,notice_hi,
  public.consent_notice_hash(id,notice_version,notice_en,notice_hi),'legacy_current',created_by
from public.consent_purposes;

create function public.refuse_consent_notice_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'consent_notice_immutable' using errcode='42501'; end $$;
revoke all on function public.refuse_consent_notice_mutation() from public,anon,authenticated,service_role;
create trigger consent_notice_immutable before update or delete on public.consent_notice_versions
for each row execute function public.refuse_consent_notice_mutation();

alter table public.consent_records add column notice_snapshot_sha256 text
  check(notice_snapshot_sha256 is null or notice_snapshot_sha256 ~ '^[0-9a-f]{64}$');
alter table public.consent_records add constraint consent_record_notice_snapshot
  foreign key(tenant_id,purpose_id,notice_version,notice_snapshot_sha256)
  references public.consent_notice_versions(tenant_id,purpose_id,notice_version,snapshot_sha256) on delete restrict;

-- The BFF is the authenticated caller; actor identity is supplied only from
-- its session. Recheck and lock the corresponding live manager membership.
create function public.consent_manager_allowed(p_tenant_id uuid,p_actor_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id
    and role in ('founder','owner','admin') for share;
  return found;
end $$;
revoke all on function public.consent_manager_allowed(uuid,uuid) from public,anon,authenticated,service_role;

create function public.register_consent_purpose(
  p_tenant_id uuid,p_purpose_key text,p_name_en text,p_name_hi text,
  p_description_en text,p_description_hi text,p_lawful_basis text,
  p_notice_en text,p_notice_hi text,p_reviewed boolean,p_created_by uuid,p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.consent_purposes; v_hash text;
begin
  if p_correlation_id is null or p_reviewed is distinct from true
    or p_purpose_key is null or p_purpose_key !~ '^[a-z0-9_.-]{1,64}$'
    or p_name_en is null or char_length(p_name_en) > 160 or char_length(btrim(p_name_en)) = 0
    or p_name_hi is null or char_length(p_name_hi) > 160 or char_length(btrim(p_name_hi)) = 0
    or char_length(p_description_en)>2000 or char_length(p_description_hi)>2000
    or p_lawful_basis is null or p_lawful_basis not in ('consent','legitimate_uses')
    or p_notice_en is null or char_length(p_notice_en) > 20000 or char_length(btrim(p_notice_en)) = 0
    or p_notice_hi is null or char_length(p_notice_hi) > 20000 or char_length(btrim(p_notice_hi)) = 0 then
    return jsonb_build_object('error','invalid_request');
  end if;
  if not public.consent_manager_allowed(p_tenant_id,p_created_by) then
    return jsonb_build_object('error','forbidden');
  end if;
  insert into public.consent_purposes(tenant_id,purpose_key,name_en,name_hi,description_en,description_hi,
    lawful_basis,notice_version,notice_en,notice_hi,created_by)
  values(p_tenant_id,p_purpose_key,p_name_en,p_name_hi,p_description_en,p_description_hi,
    p_lawful_basis,1,p_notice_en,p_notice_hi,p_created_by)
  on conflict(tenant_id,purpose_key) do nothing returning * into r;
  if not found then return jsonb_build_object('error','purpose_exists'); end if;
  v_hash:=public.consent_notice_hash(r.id,1,p_notice_en,p_notice_hi);
  insert into public.consent_notice_versions(tenant_id,purpose_id,notice_version,notice_en,notice_hi,
    snapshot_sha256,provenance,created_by)
  values(p_tenant_id,r.id,1,p_notice_en,p_notice_hi,v_hash,'published',p_created_by);
  perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_created_by::text,null,null,null,
    'consent.purpose.registered',r.id::text,null,null,null,null,null,null,'success',
    jsonb_build_object('purpose_id',r.id,'purpose_key',r.purpose_key,'notice_version',1,
      'notice_snapshot_sha256',v_hash,'reviewed',true,'lawful_basis',p_lawful_basis));
  return jsonb_build_object('purpose_id',r.id,'notice_version',1);
end $$;

create function public.publish_consent_notice(
  p_tenant_id uuid,p_purpose_id uuid,p_expected_notice_version integer,
  p_notice_en text,p_notice_hi text,p_reviewed boolean,p_published_by uuid,p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.consent_purposes; v_version integer; v_hash text;
begin
  if p_correlation_id is null or p_reviewed is distinct from true
    or p_expected_notice_version is null or p_expected_notice_version < 1
    or p_notice_en is null or char_length(p_notice_en) > 20000 or char_length(btrim(p_notice_en)) = 0
    or p_notice_hi is null or char_length(p_notice_hi) > 20000 or char_length(btrim(p_notice_hi)) = 0 then
    return jsonb_build_object('error','invalid_request');
  end if;
  if not public.consent_manager_allowed(p_tenant_id,p_published_by) then
    return jsonb_build_object('error','forbidden');
  end if;
  select * into r from public.consent_purposes where tenant_id=p_tenant_id and id=p_purpose_id for update;
  if not found then return jsonb_build_object('error','purpose_not_found'); end if;
  if r.notice_version<>p_expected_notice_version then
    return jsonb_build_object('error','stale_notice_version');
  end if;
  if r.notice_version=2147483647 then return jsonb_build_object('error','version_exhausted'); end if;
  v_version:=r.notice_version+1;
  v_hash:=public.consent_notice_hash(r.id,v_version,p_notice_en,p_notice_hi);
  insert into public.consent_notice_versions(tenant_id,purpose_id,notice_version,notice_en,notice_hi,
    snapshot_sha256,provenance,created_by)
  values(p_tenant_id,r.id,v_version,p_notice_en,p_notice_hi,v_hash,'published',p_published_by);
  update public.consent_purposes set notice_version=v_version,notice_en=p_notice_en,
    notice_hi=p_notice_hi,updated_at=clock_timestamp() where id=r.id;
  perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_published_by::text,null,null,null,
    'consent.notice.published',r.id::text,null,null,null,null,null,null,'success',
    jsonb_build_object('purpose_id',r.id,'previous_notice_version',r.notice_version,
      'notice_version',v_version,'notice_snapshot_sha256',v_hash,'reviewed',true));
  return jsonb_build_object('purpose_id',r.id,'notice_version',v_version);
end $$;

create function public.set_consent_purpose_active(
  p_tenant_id uuid,p_purpose_id uuid,p_is_active boolean,p_changed_by uuid,p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.consent_purposes;
begin
  if p_correlation_id is null or p_is_active is null then return jsonb_build_object('error','invalid_request'); end if;
  if not public.consent_manager_allowed(p_tenant_id,p_changed_by) then return jsonb_build_object('error','forbidden'); end if;
  select * into r from public.consent_purposes where tenant_id=p_tenant_id and id=p_purpose_id for update;
  if not found then return jsonb_build_object('error','purpose_not_found'); end if;
  if r.is_active=p_is_active then return jsonb_build_object('error','status_unchanged'); end if;
  update public.consent_purposes set is_active=p_is_active,updated_at=clock_timestamp() where id=r.id;
  perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_changed_by::text,null,null,null,
    'consent.purpose.status_changed',r.id::text,null,null,null,null,null,null,'success',
    jsonb_build_object('purpose_id',r.id,'is_active',p_is_active));
  return jsonb_build_object('purpose_id',r.id,'is_active',p_is_active);
end $$;

-- Remove the unchecked overload: no caller may silently capture whichever
-- version happens to be current after the principal reviewed another one.
drop function public.record_consent(uuid,uuid,text,text,text,text,timestamptz,uuid,uuid);

create function public.record_consent(
  p_tenant_id uuid,
  p_purpose_id uuid,
  p_expected_notice_version integer,
  p_principal_type text,
  p_principal_ref text,
  p_language text,
  p_channel text,
  p_expires_at timestamptz,
  p_granted_by uuid,
  p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_purpose public.consent_purposes;
  v_record public.consent_records;
  v_revived boolean := false;
  v_notice public.consent_notice_versions;
begin
  -- Shape first: every argument explicit, every value bounded. Each field
  -- is null-guarded before its set test — a NULL `not in` yields NULL, and
  -- a NULL that slipped through here would die on a NOT NULL constraint
  -- instead of returning a refusal.
  if p_expected_notice_version is null or p_expected_notice_version < 1
     or p_tenant_id is null or p_purpose_id is null or p_correlation_id is null
     or p_granted_by is null
     or p_principal_type is null or p_principal_type not in ('email', 'phone', 'cookie_id', 'user_id')
     or p_language is null or p_language not in ('en', 'hi')
     or p_channel is null or p_channel not in ('cookie', 'form', 'api', 'offline')
     or p_principal_ref is null
     or char_length(p_principal_ref) not between 3 and 320
     or (p_expires_at is not null and p_expires_at <= clock_timestamp())
     or not exists (select 1 from public.tenants where id = p_tenant_id)
     or not exists (select 1 from public.users where id = p_granted_by) then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  -- The principal reference is validated per type: an address is an
  -- address, a number is a number, an identifier is identifier-shaped, and
  -- a user_id is a real uuid of a real member of THIS tenant. No free text
  -- enters the consent vault.
  if p_principal_type = 'email'
     and p_principal_ref !~ '^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$' then
    return jsonb_build_object('error', 'invalid_request');
  elsif p_principal_type = 'phone'
     and p_principal_ref !~ '^\+?[0-9]{8,15}$' then
    return jsonb_build_object('error', 'invalid_request');
  elsif p_principal_type = 'cookie_id'
     and p_principal_ref !~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$' then
    return jsonb_build_object('error', 'invalid_request');
  elsif p_principal_type = 'user_id'
     and p_principal_ref !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  -- The uuid membership check runs only after the shape check above has
  -- returned for any non-uuid: the cast below is unreachable for free
  -- text, rather than merely ordered before it.
  if p_principal_type = 'user_id'
     and not exists (select 1 from public.tenant_users
                      where tenant_id = p_tenant_id
                        and user_id = p_principal_ref::uuid) then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  if not public.consent_manager_allowed(p_tenant_id, p_granted_by) then
    return jsonb_build_object('error', 'forbidden');
  end if;

  select * into v_purpose from public.consent_purposes
   where tenant_id = p_tenant_id and id = p_purpose_id for update;
  if not found then
    -- A purpose of another tenant is not found, not refused differently:
    -- existence across the tenant boundary is not ours to disclose.
    return jsonb_build_object('error', 'purpose_not_found');
  end if;
  if not v_purpose.is_active then
    return jsonb_build_object('error', 'purpose_inactive');
  end if;

  if v_purpose.lawful_basis <> 'consent' then
    return jsonb_build_object('error', 'consent_not_applicable');
  end if;
  if v_purpose.notice_version <> p_expected_notice_version then
    return jsonb_build_object('error', 'stale_notice_version');
  end if;
  select * into v_notice from public.consent_notice_versions
   where tenant_id = p_tenant_id and purpose_id = p_purpose_id
     and notice_version = p_expected_notice_version;
  if not found then
    return jsonb_build_object('error', 'notice_unavailable');
  end if;
  if nullif(btrim(case p_language when 'hi' then v_notice.notice_hi else v_notice.notice_en end), '') is null then
    return jsonb_build_object('error', 'missing_notice');
  end if;

  insert into public.consent_records(
      tenant_id, purpose_id, principal_type, principal_ref, notice_version,
      language, channel, status, granted_at, granted_by, expires_at, correlation_id, notice_snapshot_sha256)
  values (p_tenant_id, v_purpose.id, p_principal_type, p_principal_ref,
          v_purpose.notice_version, p_language, p_channel, 'granted',
          clock_timestamp(), p_granted_by, p_expires_at, p_correlation_id, v_notice.snapshot_sha256)
  on conflict (tenant_id, purpose_id, principal_type, principal_ref) do nothing
  returning * into v_record;

  if v_record is null then
    -- A row already exists for this (purpose, principal). A granted consent
    -- is not re-granted; a withdrawn one is revived as a fresh capture —
    -- the notice version, language, channel and expiry of THIS capture, a
    -- new granted_at, and the withdrawal references cleared. History stays
    -- in the ledger; the row stays the current state. A legal hold, being a
    -- retention freeze, is neither set nor cleared here.
    update public.consent_records
       set status = 'granted',
           granted_at = clock_timestamp(),
           granted_by = p_granted_by,
           notice_version = v_purpose.notice_version,
           notice_snapshot_sha256 = v_notice.snapshot_sha256,
           language = p_language,
           channel = p_channel,
           expires_at = p_expires_at,
           withdrawn_at = null,
           withdrawn_via_consent_id = null,
           correlation_id = p_correlation_id
     where tenant_id = p_tenant_id
       and purpose_id = p_purpose_id
       and principal_type = p_principal_type
       and principal_ref = p_principal_ref
       and status = 'withdrawn'
    returning * into v_record;
    if v_record is null then
      return jsonb_build_object('error', 'already_granted');
    end if;
    v_revived := true;
  end if;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_granted_by::text, null, null, null,
    'consent.recorded', v_record.id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('consent_id', v_record.id, 'purpose_id', v_record.purpose_id,
      'principal_type', v_record.principal_type, 'principal_ref', v_record.principal_ref,
      'notice_version', v_record.notice_version, 'language', v_record.language,
      'channel', v_record.channel, 'expires_at', v_record.expires_at,
      'revived', v_revived, 'notice_snapshot_sha256', v_notice.snapshot_sha256));

  return jsonb_build_object('consent_id', v_record.id, 'status', v_record.status,
    'notice_version', v_record.notice_version, 'notice_snapshot_sha256', v_record.notice_snapshot_sha256);
end $$;

-- Recheck live authority for all existing consent mutation paths too.
create or replace function public.withdraw_consent(
  p_tenant_id uuid,
  p_consent_record_id uuid,
  p_reason text,
  p_language text,
  p_requested_by uuid,
  p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_record public.consent_records;
  v_withdrawal public.consent_withdrawals;
  v_withdrawal_id uuid;
  v_language text := coalesce(p_language, 'en');
begin
  if p_tenant_id is null or p_consent_record_id is null or p_correlation_id is null
     or p_requested_by is null
     or v_language not in ('en', 'hi')
     or (p_reason is not null and char_length(p_reason) > 500)
     or not exists (select 1 from public.tenants where id = p_tenant_id)
     or not exists (select 1 from public.users where id = p_requested_by) then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  if not public.consent_manager_allowed(p_tenant_id,p_requested_by) then
    return jsonb_build_object('error','forbidden');
  end if;

  select * into v_record from public.consent_records
   where tenant_id = p_tenant_id and id = p_consent_record_id for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_record.status <> 'granted' then
    return jsonb_build_object('error', 'already_withdrawn');
  end if;

  -- The artifact's identity is minted before the state change so the
  -- consent record can bind to it; the reference FK is deferred and is
  -- satisfied by the INSERT below, within this same transaction.
  v_withdrawal_id := gen_random_uuid();

  update public.consent_records
     set status = 'withdrawn',
         withdrawn_at = clock_timestamp(),
         withdrawn_via_consent_id = v_withdrawal_id
   where tenant_id = p_tenant_id
     and id = p_consent_record_id
     and status = 'granted'
  returning * into v_record;
  if v_record is null then
    return jsonb_build_object('error', 'already_withdrawn');
  end if;

  insert into public.consent_withdrawals(
      id, tenant_id, consent_record_id, purpose_id, principal_type, principal_ref,
      reason, language, requested_by, correlation_id)
  values (v_withdrawal_id, p_tenant_id, v_record.id, v_record.purpose_id,
          v_record.principal_type, v_record.principal_ref,
          p_reason, v_language, p_requested_by, p_correlation_id)
  returning * into v_withdrawal;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_requested_by::text, null, null, null,
    'consent.withdrawn', v_record.id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('withdrawal_id', v_withdrawal.id, 'consent_id', v_record.id,
      'purpose_id', v_record.purpose_id, 'principal_type', v_record.principal_type,
      'principal_ref', v_record.principal_ref, 'language', v_withdrawal.language,
      'withdrawn_at', v_record.withdrawn_at));

  return jsonb_build_object('withdrawal_id', v_withdrawal.id,
                            'consent_id', v_record.id,
                            'withdrawn_at', v_record.withdrawn_at);
end $$;

create or replace function public.set_consent_legal_hold(
  p_tenant_id uuid,
  p_consent_record_id uuid,
  p_hold boolean,
  p_held_by uuid,
  p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.consent_records;
begin
  if p_tenant_id is null or p_consent_record_id is null or p_hold is null
     or p_held_by is null or p_correlation_id is null
     or not exists (select 1 from public.tenants where id = p_tenant_id)
     or not exists (select 1 from public.users where id = p_held_by) then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  if not public.consent_manager_allowed(p_tenant_id,p_held_by) then
    return jsonb_build_object('error','forbidden');
  end if;

  update public.consent_records
     set legal_hold = p_hold
   where tenant_id = p_tenant_id and id = p_consent_record_id
  returning * into r;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_held_by::text, null, null, null,
    'consent.legal_hold.set', r.id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('consent_id', r.id, 'hold', p_hold));

  return jsonb_build_object('consent_id', r.id, 'legal_hold', r.legal_hold);
end $$;

create or replace function public.complete_withdrawal_downstream(
  p_tenant_id uuid,
  p_withdrawal_id uuid,
  p_completed_by uuid,
  p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.consent_withdrawals;
begin
  if p_tenant_id is null or p_withdrawal_id is null or p_completed_by is null
     or p_correlation_id is null
     or not exists (select 1 from public.tenants where id = p_tenant_id)
     or not exists (select 1 from public.users where id = p_completed_by) then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  if not public.consent_manager_allowed(p_tenant_id,p_completed_by) then
    return jsonb_build_object('error','forbidden');
  end if;

  update public.consent_withdrawals
     set downstream_completed_at = clock_timestamp()
   where tenant_id = p_tenant_id
     and id = p_withdrawal_id
     and downstream_completed_at is null
  returning * into r;
  if not found then
    if exists (select 1 from public.consent_withdrawals
                where tenant_id = p_tenant_id and id = p_withdrawal_id) then
      return jsonb_build_object('error', 'already_completed');
    end if;
    return jsonb_build_object('error', 'not_found');
  end if;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_completed_by::text, null, null, null,
    'consent.withdrawal.completed', r.id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('withdrawal_id', r.id, 'consent_record_id', r.consent_record_id,
      'completed_at', r.downstream_completed_at));

  return jsonb_build_object('withdrawal_id', r.id,
                            'completed_at', r.downstream_completed_at);
end $$;

create or replace function public.verify_dsar_identity(
  p_tenant_id uuid,
  p_dsar_id uuid,
  p_method text,
  p_verified_by uuid,
  p_correlation_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_status text;
begin
  if p_method is null or char_length(p_method) < 1 or char_length(p_method) > 120 then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if p_correlation_id is null then return jsonb_build_object('error','invalid_request'); end if;
  if not public.consent_manager_allowed(p_tenant_id,p_verified_by) then
    return jsonb_build_object('error','forbidden');
  end if;
  select status::text into v_status from public.dsars
    where id = p_dsar_id and tenant_id = p_tenant_id for update;
  if v_status is null then
    return jsonb_build_object('error', 'dsar_not_found');
  end if;
  if v_status not in ('received', 'identity_verification') then
    return jsonb_build_object('error', 'invalid_transition');
  end if;

  update public.dsars set
    identity_verified = true,
    identity_verification_method = p_method,
    status = greatest(status, 'identity_verification'::dsar_status),
    updated_at = now()
  where id = p_dsar_id and tenant_id = p_tenant_id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_verified_by::text, null, null, null,
    'dsar.verified', p_dsar_id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('method', p_method, 'from_status', v_status));

  return jsonb_build_object('dsarId', p_dsar_id, 'identityVerified', true);
end $$;

create or replace function public.advance_dsar(
  p_tenant_id uuid,
  p_dsar_id uuid,
  p_to_status text,
  p_note text,
  p_fulfilment_evidence_id uuid,
  p_advanced_by uuid,
  p_correlation_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_from text;
  v_identity_verified boolean;
  v_allowed boolean;
  v_action public.ledger_action_type;
begin
  if p_to_status is null or p_advanced_by is null or p_correlation_id is null then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if not public.consent_manager_allowed(p_tenant_id,p_advanced_by) then
    return jsonb_build_object('error','forbidden');
  end if;
  select status::text, identity_verified into v_from, v_identity_verified from public.dsars
    where id = p_dsar_id and tenant_id = p_tenant_id for update;
  if v_from is null then
    return jsonb_build_object('error', 'dsar_not_found');
  end if;

  -- The closed transition map. Fulfilment requires a verified identity;
  -- completion requires a fulfilment evidence artifact belonging to the
  -- tenant; rejection (FR-7.6) requires a captured reason.
  v_allowed :=
    (p_to_status = 'in_fulfilment' and v_from = 'identity_verification')
    or (p_to_status = 'completed' and v_from = 'in_fulfilment')
    or (p_to_status = 'rejected' and v_from in ('received', 'identity_verification', 'in_fulfilment'))
    or (p_to_status = 'escalated' and v_from in ('identity_verification', 'in_fulfilment'));
  if not v_allowed then
    return jsonb_build_object('error', 'invalid_transition');
  end if;

  if p_to_status in ('in_fulfilment', 'completed') and v_identity_verified is distinct from true then
    return jsonb_build_object('error', 'identity_verification_required');
  end if;

  if p_to_status = 'completed' then
    if p_fulfilment_evidence_id is null then
      return jsonb_build_object('error', 'fulfilment_evidence_required');
    end if;
    if not exists (
      select 1 from public.evidence
        where id = p_fulfilment_evidence_id and tenant_id = p_tenant_id
    ) then
      return jsonb_build_object('error', 'fulfilment_evidence_not_found');
    end if;
  end if;

  if p_to_status = 'rejected' and (p_note is null or char_length(p_note) = 0) then
    return jsonb_build_object('error', 'reason_required');
  end if;
  if p_note is not null and char_length(p_note) > 2000 then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  v_action := case p_to_status
    when 'completed' then 'dsar.fulfilled'::public.ledger_action_type
    when 'rejected' then 'dsar.rejected'::public.ledger_action_type
    when 'escalated' then 'dsar.escalated'::public.ledger_action_type
    else 'dsar.status.changed'::public.ledger_action_type
  end;

  update public.dsars set
    status = p_to_status::dsar_status,
    completed_at = case when p_to_status = 'completed' then clock_timestamp() else completed_at end,
    rejection_reason = case when p_to_status = 'rejected' then p_note else rejection_reason end,
    fulfillment_evidence_id = case when p_to_status = 'completed'
      then p_fulfilment_evidence_id else fulfillment_evidence_id end,
    updated_at = now()
  where id = p_dsar_id and tenant_id = p_tenant_id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_advanced_by::text, null, null, null,
    v_action, p_dsar_id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('from', v_from, 'to', p_to_status,
      'fulfilment_evidence_id', p_fulfilment_evidence_id));

  return jsonb_build_object('dsarId', p_dsar_id, 'status', p_to_status);
end $$;


revoke all on function
  public.register_consent_purpose(uuid,text,text,text,text,text,text,text,text,boolean,uuid,uuid),
  public.publish_consent_notice(uuid,uuid,integer,text,text,boolean,uuid,uuid),
  public.set_consent_purpose_active(uuid,uuid,boolean,uuid,uuid),
  public.record_consent(uuid,uuid,integer,text,text,text,text,timestamptz,uuid,uuid)
  from public,anon,authenticated;
grant execute on function
  public.register_consent_purpose(uuid,text,text,text,text,text,text,text,text,boolean,uuid,uuid),
  public.publish_consent_notice(uuid,uuid,integer,text,text,boolean,uuid,uuid),
  public.set_consent_purpose_active(uuid,uuid,boolean,uuid,uuid),
  public.record_consent(uuid,uuid,integer,text,text,text,text,timestamptz,uuid,uuid)
  to service_role;
