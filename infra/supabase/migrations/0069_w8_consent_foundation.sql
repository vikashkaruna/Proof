-- ─────────────────────────────────────────────────────────────────────
-- 0069_w8_consent_foundation.sql
--
-- W8.1 — the consent foundation (Revision 98).
--
-- DPDPA §6 makes notice-and-consent the entry door to every lawful
-- processing of a data principal's personal data. Until now the platform
-- could describe that story; nothing could RECORD it. This migration gives
-- consent its tables, its lifecycle and its proof:
--
--   consent_purposes     the per-tenant purpose/notice registry (EN/HI
--                        notice pairs under a versioned notice, DPDPA §5(2):
--                        a request must state the purpose). Managed through
--                        RPCs in a later slice; the row is registry metadata,
--                        not personal data.
--   consent_records      the current consent state per (purpose, principal).
--                        One row per pair — a re-grant revives a withdrawn
--                        row rather than stacking a second one, so the row a
--                        reader finds is the state, not an archaeology dig.
--   consent_withdrawals  the withdrawal artifact (append-only), carrying a
--                        denormalized snapshot so audit queries survive the
--                        record they point at.
--
--   record_consent                  the grant. The notice version is pinned
--                                   at capture; the principal reference is
--                                   validated to a bounded shape per type —
--                                   no free text enters the vault.
--   withdraw_consent                the off switch: an atomic conditional
--                                   UPDATE plus the withdrawal artifact, one
--                                   transaction, one ledger entry.
--   set_consent_legal_hold          the retention freeze (FR-4.5): holds a
--                                   granted or withdrawn record against any
--                                   future lifecycle hook. A hold is not a
--                                   status change.
--   complete_withdrawal_downstream  the closure: propagation of a withdrawal
--                                   to every downstream system is recorded
--                                   once, so "withdrawn" never quietly means
--                                   "withdrawn here only".
--
-- Three facts the schema itself must guarantee, because a promise enforced
-- only in application code is a wish:
--   · There is NO delete path. Consent data lives ≥ 7 years (FR-4.5): no
--     purge function, no deletable state, no CASCADE that can shorten
--     history — every cross-table reference to a consent row is ON DELETE
--     RESTRICT — and `legal_hold = true` freezes a record against any future
--     lifecycle hook. Withdrawals are append-only.
--   · The clocks are server-owned. Every statutory or audit timestamp is
--     clock_timestamp() inside the RPC; clients supply identity and intent,
--     never time.
--   · The writes are RPC-only. The RLS tables carry SELECT policies and
--     nothing else (deny by default), direct-write grants are revoked from
--     service_role, and every write path is a SECURITY DEFINER function that
--     ledgeres through append_ledger with a required correlation_id —
--     consent.recorded, consent.withdrawn, consent.legal_hold.set,
--     consent.withdrawal.completed — so the ledger, not a log line, is the
--     record a regulator reads.
-- ─────────────────────────────────────────────────────────────────────

alter type public.ledger_action_type add value if not exists 'consent.recorded';
alter type public.ledger_action_type add value if not exists 'consent.withdrawn';
alter type public.ledger_action_type add value if not exists 'consent.legal_hold.set';
alter type public.ledger_action_type add value if not exists 'consent.withdrawal.completed';

-- ─── consent_purposes — the per-tenant purpose/notice registry ────────
create table public.consent_purposes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- A bounded machine key, not prose: it is referenced by policies,
  -- connectors and reports.
  purpose_key text not null check (purpose_key ~ '^[a-z0-9_.-]{1,64}$'),
  -- EN/HI notice pair (FR-12.3): the language a principal consents in is the
  -- language they were shown.
  name_en text not null,
  name_hi text,
  description_en text,
  description_hi text,
  -- DPDPA §6/§7 closed set: consent, or the limited legitimate-uses list.
  lawful_basis text not null check (lawful_basis in ('consent', 'legitimate_uses')),
  notice_version integer not null default 1 check (notice_version > 0),
  notice_en text not null,
  notice_hi text,
  is_active boolean not null default true,
  created_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, purpose_key)
);
alter table public.consent_purposes enable row level security;
revoke all on public.consent_purposes from public, anon, authenticated, service_role;
grant select on public.consent_purposes to service_role, authenticated;
create policy bff_service_read on public.consent_purposes for select to service_role using (true);
create policy tenant_member_read on public.consent_purposes for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    or exists (select 1 from public.users where id = auth.uid() and is_axiom_internal)
  );

-- ─── consent_records — current consent state per (purpose, principal) ─
create table public.consent_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- RESTRICT, not CASCADE: a purpose cannot take its consent history with
  -- it, and nothing may shorten the ≥ 7-year retention (FR-4.5).
  purpose_id uuid not null references public.consent_purposes(id) on delete restrict,
  -- The principal is addressed by a bounded, typed reference — never free
  -- text. Shape is validated inside record_consent before anything is
  -- written; the length bound here is the backstop, not the validator.
  principal_type text not null check (principal_type in ('email', 'phone', 'cookie_id', 'user_id')),
  principal_ref text not null check (char_length(principal_ref) between 3 and 320),
  -- Pinned at capture from the purpose: the consent proves the notice it
  -- was given under, not whichever notice is current today.
  notice_version integer not null,
  language text not null default 'en' check (language in ('en', 'hi')),
  channel text not null check (channel in ('cookie', 'form', 'api', 'offline')),
  status text not null default 'granted' check (status in ('granted', 'withdrawn')),
  granted_at timestamptz not null default clock_timestamp(),
  granted_by uuid not null references public.users(id) on delete restrict,
  withdrawn_at timestamptz,
  -- Set by the withdraw RPC alongside the artifact. The FK itself is added
  -- after consent_withdrawals exists below (the reference is circular:
  -- withdrawals point back at the record they withdrew). DEFERRABLE so the
  -- UPDATE→INSERT pair inside one transaction satisfies it at commit; the
  -- delete action stays RESTRICT — a withdrawal cannot be buried while a
  -- consent record remembers it.
  withdrawn_via_consent_id uuid,
  -- A retention freeze, not a status change: set on granted or withdrawn
  -- rows alike, it bars any future lifecycle hook from touching the row.
  legal_hold boolean not null default false,
  -- Optional expiry (NULL = none); the sweeper that consumes it is a later
  -- slice, and expiry never deletes — it can only end a grant, and history
  -- stays.
  expires_at timestamptz,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, purpose_id, principal_type, principal_ref)
);
create index consent_records_tenant_purpose
  on public.consent_records(tenant_id, purpose_id);
create index consent_records_principal_ref
  on public.consent_records(principal_ref);
-- The expiry sweep's working set: only live grants, per tenant.
create index consent_records_granted_expiry
  on public.consent_records(tenant_id) where status = 'granted';
alter table public.consent_records enable row level security;
revoke all on public.consent_records from public, anon, authenticated, service_role;
grant select on public.consent_records to service_role, authenticated;
create policy bff_service_read on public.consent_records for select to service_role using (true);
create policy tenant_member_read on public.consent_records for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    or exists (select 1 from public.users where id = auth.uid() and is_axiom_internal)
  );

-- ─── consent_withdrawals — the withdrawal artifact (append-only) ──────
create table public.consent_withdrawals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- RESTRICT: the artifact outlives any attempt to remove the record it
  -- withdrew.
  consent_record_id uuid not null references public.consent_records(id) on delete restrict,
  -- Denormalized snapshot for audit queries: what was withdrawn, stated
  -- once, at the moment of withdrawal.
  purpose_id uuid not null,
  principal_type text not null,
  principal_ref text not null,
  reason text check (char_length(reason) <= 500),
  language text not null default 'en' check (language in ('en', 'hi')),
  -- Set once, by complete_withdrawal_downstream: the proof that the
  -- withdrawal propagated, not just that it was accepted.
  downstream_completed_at timestamptz,
  requested_by uuid not null references public.users(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now()
);
create index consent_withdrawals_consent_record
  on public.consent_withdrawals(consent_record_id);
-- The missing half of the circular reference (see consent_records above):
-- the record remembers the artifact that withdrew it, and the artifact
-- cannot be removed while the record remembers.
alter table public.consent_records
  add constraint consent_records_withdrawn_via
  foreign key (withdrawn_via_consent_id)
  references public.consent_withdrawals(id) on delete restrict
  deferrable initially deferred;
alter table public.consent_withdrawals enable row level security;
revoke all on public.consent_withdrawals from public, anon, authenticated, service_role;
grant select on public.consent_withdrawals to service_role, authenticated;
create policy bff_service_read on public.consent_withdrawals for select to service_role using (true);
create policy tenant_member_read on public.consent_withdrawals for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    or exists (select 1 from public.users where id = auth.uid() and is_axiom_internal)
  );

-- ─────────────────────────────────────────────────────────────────────
-- record_consent — the grant. The notice the principal saw is pinned
-- (version + language), the principal reference is validated to a bounded
-- shape per type, and expiry is strictly future if present. A withdrawn row
-- is revived, not duplicated: the ledger keeps the history, the row keeps
-- the current state. clock_timestamp(), not the client's word, for every
-- timestamp.
-- ─────────────────────────────────────────────────────────────────────
create function public.record_consent(
  p_tenant_id uuid,
  p_purpose_id uuid,
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
begin
  -- Shape first: every argument explicit, every value bounded. Each field
  -- is null-guarded before its set test — a NULL `not in` yields NULL, and
  -- a NULL that slipped through here would die on a NOT NULL constraint
  -- instead of returning a refusal.
  if p_tenant_id is null or p_purpose_id is null or p_correlation_id is null
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

  select * into v_purpose from public.consent_purposes
   where tenant_id = p_tenant_id and id = p_purpose_id;
  if not found then
    -- A purpose of another tenant is not found, not refused differently:
    -- existence across the tenant boundary is not ours to disclose.
    return jsonb_build_object('error', 'purpose_not_found');
  end if;
  if not v_purpose.is_active then
    return jsonb_build_object('error', 'purpose_inactive');
  end if;

  insert into public.consent_records(
      tenant_id, purpose_id, principal_type, principal_ref, notice_version,
      language, channel, status, granted_at, granted_by, expires_at, correlation_id)
  values (p_tenant_id, v_purpose.id, p_principal_type, p_principal_ref,
          v_purpose.notice_version, p_language, p_channel, 'granted',
          clock_timestamp(), p_granted_by, p_expires_at, p_correlation_id)
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
      'revived', v_revived));

  return jsonb_build_object('consent_id', v_record.id, 'status', v_record.status);
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- withdraw_consent — the off switch. The record is locked, the state change
-- is a conditional UPDATE (status must still be granted when the UPDATE
-- runs), the withdrawal artifact is written in the same transaction, and
-- the ledger entry ties them together. The artifact carries a snapshot of
-- what was withdrawn so audit queries do not depend on the future of the
-- referenced row.
-- ─────────────────────────────────────────────────────────────────────
create function public.withdraw_consent(
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

-- ─────────────────────────────────────────────────────────────────────
-- set_consent_legal_hold — the retention freeze (FR-4.5). A hold is not a
-- status change: it may land on granted or withdrawn records, and it bars
-- any future lifecycle hook (expiry sweeps included) from touching the row.
-- Setting the same value again is not an error — the ledger entry is the
-- point, because "who froze this consent, and when" is exactly what a
-- regulator asks.
-- ─────────────────────────────────────────────────────────────────────
create function public.set_consent_legal_hold(
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

-- ─────────────────────────────────────────────────────────────────────
-- complete_withdrawal_downstream — the closure. A withdrawal accepted here
-- is not a withdrawal honoured everywhere; this records, once, that the
-- propagation finished. A second call refuses: downstream completion is a
-- fact, not a retry.
-- ─────────────────────────────────────────────────────────────────────
create function public.complete_withdrawal_downstream(
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

revoke all on function
  public.record_consent(uuid,uuid,text,text,text,text,timestamptz,uuid,uuid),
  public.withdraw_consent(uuid,uuid,text,text,uuid,uuid),
  public.set_consent_legal_hold(uuid,uuid,boolean,uuid,uuid),
  public.complete_withdrawal_downstream(uuid,uuid,uuid,uuid)
  from public, anon, authenticated;
grant execute on function
  public.record_consent(uuid,uuid,text,text,text,text,timestamptz,uuid,uuid),
  public.withdraw_consent(uuid,uuid,text,text,uuid,uuid),
  public.set_consent_legal_hold(uuid,uuid,boolean,uuid,uuid),
  public.complete_withdrawal_downstream(uuid,uuid,uuid,uuid)
  to service_role;
