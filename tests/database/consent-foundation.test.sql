-- W8.1 / migration 0069: the consent foundation.
--
-- Consent is the legal basis for everything else the platform does with a
-- data principal's personal data, so the failure modes these assertions
-- protect against are legal ones: a grant that does not pin the notice it
-- was given under; a withdrawal that exists only in the API response but
-- not as an artifact; a "revival" that stacks a second row instead of
-- restoring one; a downstream completion that can be claimed twice; and —
-- the one that would end the product in court — any path that deletes
-- consent history inside the 7-year retention window. The tables accept
-- SELECT policies and nothing else, the direct-write grants are revoked
-- even from the BFF's own service role, and the only writes left run
-- through SECURITY DEFINER RPCs that refuse malformed principals and
-- ledger every state change they do accept.

begin;

create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
create function pg_temp.assert_eq(actual text, expected text, message text) returns void language plpgsql as $$
begin if actual is distinct from expected then
  raise exception 'ASSERTION FAILED: % (expected %, got %)', message, expected, actual; end if; end $$;
create function pg_temp.denied(statement text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when insufficient_privilege then return; end;
  raise exception 'Statement was not denied: %', statement;
end $$;

-- ─── Fixture ─────────────────────────────────────────────────────────
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@test.invalid'),
  ('00000000-0000-0000-0000-0000000000a2', 'other@test.invalid'),
  ('00000000-0000-0000-0000-0000000000a3', 'internal@test.invalid');
insert into public.users(id, email, is_axiom_internal) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@test.invalid', false),
  ('00000000-0000-0000-0000-0000000000a2', 'other@test.invalid', false),
  ('00000000-0000-0000-0000-0000000000a3', 'internal@test.invalid', true);
insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-0000000000c1', 'consent-a', 'Consent A'),
  ('00000000-0000-0000-0000-0000000000c9', 'consent-b', 'Consent B');
insert into public.tenant_users(tenant_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000a2', 'owner');
-- The registry has no write RPC yet (a later slice), so fixtures insert
-- directly; the RLS tables still deny writes to every non-definer role.
insert into public.consent_purposes(id, tenant_id, purpose_key, name_en, lawful_basis,
                                    notice_version, notice_en, created_by) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1',
   'marketing_emails', 'Marketing emails', 'consent', 3,
   'We will email you about offers.', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1',
   'analytics_cookies', 'Analytics cookies', 'consent', 1,
   'We will measure your visit.', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000c1',
   'retired_purpose', 'Retired purpose', 'consent', 1,
   'This purpose is inactive.', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000d9', '00000000-0000-0000-0000-0000000000c9',
   'other_tenant_purpose', 'Other tenant', 'consent', 1,
   'Not your tenant.', '00000000-0000-0000-0000-0000000000a2');
update public.consent_purposes set is_active = false
 where id = '00000000-0000-0000-0000-0000000000d3';

-- ─── Happy path: grant, withdraw, complete, revive ───────────────────
do $$
declare
  v_purpose uuid := '00000000-0000-0000-0000-0000000000d1';
  v_owner uuid := '00000000-0000-0000-0000-0000000000a1';
  v_consent uuid;
  v_withdrawal uuid;
  v_out jsonb;
  v_first_grant timestamptz;
begin
  v_out := public.record_consent(
    '00000000-0000-0000-0000-0000000000c1', v_purpose,
    'email', 'data.subject@example.invalid', 'en', 'form', null,
    v_owner, '00000000-0000-0000-0000-0000000000b1');
  if v_out ->> 'status' is distinct from 'granted' then
    raise exception 'ASSERTION FAILED: the grant is recorded (got %)', v_out ->> 'error';
  end if;
  v_consent := (v_out ->> 'consent_id')::uuid;

  select * into v_first_grant, v_out from (
    select granted_at,
           jsonb_build_object('notice_version', notice_version, 'granted_by', granted_by,
             'correlation_id', correlation_id, 'status', status, 'legal_hold', legal_hold,
             'expires_at', expires_at)
      from public.consent_records where id = v_consent) t;

  -- The notice is pinned at capture, with the server's clock and the
  -- tenant user as the granter.
  if v_out ->> 'notice_version' is distinct from '3'
     or v_out ->> 'granted_by' is distinct from v_owner::text
     or v_out ->> 'correlation_id' is distinct from '00000000-0000-0000-0000-0000000000b1'
     or v_out ->> 'status' is distinct from 'granted'
     or (v_out ->> 'legal_hold')::boolean
     or v_out ->> 'expires_at' is distinct from null then
    raise exception 'ASSERTION FAILED: the record pins the capture (got %)', v_out;
  end if;

  v_out := public.withdraw_consent(
    '00000000-0000-0000-0000-0000000000c1', v_consent, 'No longer wishes marketing', 'hi',
    v_owner, '00000000-0000-0000-0000-0000000000b2');
  if v_out ->> 'withdrawal_id' is null or v_out ->> 'withdrawn_at' is null
     or (v_out ->> 'consent_id')::uuid is distinct from v_consent then
    raise exception 'ASSERTION FAILED: the withdrawal is recorded (got %)', v_out ->> 'error';
  end if;
  v_withdrawal := (v_out ->> 'withdrawal_id')::uuid;

  if (select status from public.consent_records where id = v_consent)
     is distinct from 'withdrawn'
     or (select withdrawn_at is not null from public.consent_records where id = v_consent)
     is distinct from true
     or (select withdrawn_via_consent_id from public.consent_records where id = v_consent)
     is distinct from v_withdrawal then
    raise exception 'ASSERTION FAILED: the record carries the withdrawal';
  end if;

  -- The artifact is the audit copy: snapshot, reason, language, requester.
  if (select consent_record_id from public.consent_withdrawals where id = v_withdrawal)
     is distinct from v_consent
     or (select principal_ref from public.consent_withdrawals where id = v_withdrawal)
     is distinct from 'data.subject@example.invalid'
     or (select purpose_id from public.consent_withdrawals where id = v_withdrawal)
     is distinct from v_purpose
     or (select language from public.consent_withdrawals where id = v_withdrawal)
     is distinct from 'hi'
     or (select reason from public.consent_withdrawals where id = v_withdrawal)
     is distinct from 'No longer wishes marketing'
     or (select requested_by from public.consent_withdrawals where id = v_withdrawal)
     is distinct from v_owner then
    raise exception 'ASSERTION FAILED: the withdrawal artifact snapshots the request';
  end if;

  v_out := public.complete_withdrawal_downstream(
    '00000000-0000-0000-0000-0000000000c1', v_withdrawal,
    v_owner, '00000000-0000-0000-0000-0000000000b3');
  if v_out ->> 'completed_at' is null
     or (v_out ->> 'withdrawal_id')::uuid is distinct from v_withdrawal then
    raise exception 'ASSERTION FAILED: downstream completion is recorded (got %)', v_out ->> 'error';
  end if;
  if (select downstream_completed_at is null from public.consent_withdrawals where id = v_withdrawal)
     is distinct from false then
    raise exception 'ASSERTION FAILED: downstream completion lands on the artifact';
  end if;

  -- Downstream completion is a fact, not a retry.
  if (public.complete_withdrawal_downstream(
        '00000000-0000-0000-0000-0000000000c1', v_withdrawal,
        v_owner, '00000000-0000-0000-0000-0000000000b4') ->> 'error')
     is distinct from 'already_completed' then
    raise exception 'ASSERTION FAILED: downstream completion happens once';
  end if;

  -- A re-grant revives the row as a fresh capture: the CURRENT notice
  -- version is pinned, the withdrawal references clear, the clock restarts,
  -- and the row count stays at one.
  update public.consent_purposes set notice_version = 4 where id = v_purpose;
  v_out := public.record_consent(
    '00000000-0000-0000-0000-0000000000c1', v_purpose,
    'email', 'data.subject@example.invalid', 'en', 'form', now() + interval '30 days',
    v_owner, '00000000-0000-0000-0000-0000000000b5');
  if v_out ->> 'status' is distinct from 'granted' then
    raise exception 'ASSERTION FAILED: a withdrawn consent is re-grantable (got %)', v_out ->> 'error';
  end if;
  if (select notice_version from public.consent_records where id = v_consent)
     is distinct from 4
     or (select status from public.consent_records where id = v_consent)
     is distinct from 'granted'
     or (select withdrawn_at is null from public.consent_records where id = v_consent)
     is distinct from true
     or (select withdrawn_via_consent_id is null from public.consent_records where id = v_consent)
     is distinct from true
     or (select granted_at > v_first_grant from public.consent_records where id = v_consent)
     is distinct from true
     or (select expires_at is not null from public.consent_records where id = v_consent)
     is distinct from true then
    raise exception 'ASSERTION FAILED: the revival re-captures, it does not resurrect the old state';
  end if;
  if (select count(*) from public.consent_records
       where tenant_id = '00000000-0000-0000-0000-0000000000c1' and purpose_id = v_purpose
         and principal_type = 'email' and principal_ref = 'data.subject@example.invalid') <> 1 then
    raise exception 'ASSERTION FAILED: a revival stacks no second row';
  end if;
end $$;

-- ─── Refusals ─────────────────────────────────────────────────────────
select pg_temp.assert_eq(
  (select public.record_consent(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
     'email', 'data.subject@example.invalid', 'en', 'form', null,
     '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b6')
   ->> 'error'),
  'already_granted', 'a live consent is not re-granted');

select pg_temp.assert_eq(
  (select public.record_consent(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d3',
     'email', 'other.subject@example.invalid', 'en', 'form', null,
     '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'purpose_inactive', 'an inactive purpose takes no new consent');

select pg_temp.assert_eq(
  (select public.record_consent(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d9',
     'email', 'cross.tenant@example.invalid', 'en', 'form', null,
     '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'purpose_not_found', 'another tenant''s purpose is not found, not refused differently');

select pg_temp.assert_eq(
  (select public.record_consent(
     '00000000-0000-0000-0000-0000000000c1', gen_random_uuid(),
     'email', 'unknown.purpose@example.invalid', 'en', 'form', null,
     '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'purpose_not_found', 'a purpose that exists nowhere is not found');

-- Bounded principal shapes: every type, several ways to be malformed.
select pg_temp.assert_eq(
  (select public.record_consent(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
     'email', 'not-an-email', 'en', 'form', null,
     '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'invalid_request', 'an email principal must be an address');

select pg_temp.assert_eq(
  (select public.record_consent(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
     'phone', '1234567', 'en', 'form', null,
     '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'invalid_request', 'a phone principal carries 8 to 15 digits');

select pg_temp.assert_eq(
  (select public.record_consent(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
     'phone', 'abcdefghij', 'en', 'form', null,
     '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'invalid_request', 'a phone principal is digits, not prose');

select pg_temp.assert_eq(
  (select public.record_consent(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2',
     'cookie_id', 'has a space', 'en', 'cookie', null,
     '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'invalid_request', 'a cookie_id principal is identifier-shaped');

select pg_temp.assert_eq(
  (select public.record_consent(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2',
     'user_id', 'not-a-uuid', 'en', 'form', null,
     '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'invalid_request', 'a user_id principal is a uuid');

select pg_temp.assert_eq(
  (select public.record_consent(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2',
     'user_id', '00000000-0000-0000-0000-0000000000a2', 'en', 'form', null,
     '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'invalid_request', 'a user_id principal is a member of THIS tenant');

select pg_temp.assert_eq(
  (select public.record_consent(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
     'email', 'future.subject@example.invalid', 'en', 'form', now() - interval '1 day',
     '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'invalid_request', 'an expiry in the past is not an offer anyone made');

select pg_temp.assert_eq(
  (select public.record_consent(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
     'email', 'channel.subject@example.invalid', 'en', 'in_person', null,
     '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'invalid_request', 'the capture channel is a closed set');

select pg_temp.assert_eq(
  (select public.record_consent(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
     'email', 'language.subject@example.invalid', 'fr', 'form', null,
     '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'invalid_request', 'the notice language is EN or HI');

select pg_temp.assert_eq(
  (select public.withdraw_consent(
     '00000000-0000-0000-0000-0000000000c1', gen_random_uuid(), null, 'en',
     '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'not_found', 'a withdrawal of a record that exists nowhere is not found');

select pg_temp.assert_eq(
  (select public.withdraw_consent(
     '00000000-0000-0000-0000-0000000000c9',
     (select id from public.consent_records
       where tenant_id = '00000000-0000-0000-0000-0000000000c1' limit 1),
     null, 'en', '00000000-0000-0000-0000-0000000000a2', gen_random_uuid()) ->> 'error'),
  'not_found', 'another tenant''s consent record is not found');

-- A withdrawable record, then the second withdrawal refuses.
do $$
declare v_consent uuid; v_out jsonb;
begin
  v_out := public.record_consent(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2',
    'cookie_id', 'tracker-001', 'en', 'cookie', null,
    '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b7');
  v_consent := (v_out ->> 'consent_id')::uuid;
  v_out := public.withdraw_consent(
    '00000000-0000-0000-0000-0000000000c1', v_consent, 'Browser wiped', 'en',
    '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b8');
  if v_out ->> 'withdrawal_id' is null then
    raise exception 'ASSERTION FAILED: the cookie withdrawal is recorded (got %)', v_out ->> 'error';
  end if;
  if (public.withdraw_consent(
        '00000000-0000-0000-0000-0000000000c1', v_consent, 'Again', 'en',
        '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b9')
      ->> 'error') is distinct from 'already_withdrawn' then
    raise exception 'ASSERTION FAILED: a consent withdraws once';
  end if;
  if (public.complete_withdrawal_downstream(
        '00000000-0000-0000-0000-0000000000c1', gen_random_uuid(),
        '00000000-0000-0000-0000-0000000000a1', gen_random_uuid())
      ->> 'error') is distinct from 'not_found' then
    raise exception 'ASSERTION FAILED: downstream completion needs a real withdrawal';
  end if;
end $$;

-- ─── Legal hold: a retention freeze, not a status change ──────────────
do $$
declare v_consent uuid; v_out jsonb;
begin
  select id into v_consent from public.consent_records
   where principal_ref = 'tracker-001';

  -- Allowed on a WITHDRAWN record: the hold protects history, not liveness.
  v_out := public.set_consent_legal_hold(
    '00000000-0000-0000-0000-0000000000c1', v_consent, true,
    '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b10');
  if v_out ->> 'legal_hold' is distinct from 'true' then
    raise exception 'ASSERTION FAILED: the hold lands (got %)', v_out ->> 'error';
  end if;
  if (select legal_hold from public.consent_records where id = v_consent)
     is distinct from true then
    raise exception 'ASSERTION FAILED: the hold persists on the record';
  end if;
  if (select status from public.consent_records where id = v_consent)
     is distinct from 'withdrawn' then
    raise exception 'ASSERTION FAILED: a hold does not resurrect a withdrawn consent';
  end if;

  -- A no-op hold is not a refusal: the ledger entry is the point.
  if (public.set_consent_legal_hold(
        '00000000-0000-0000-0000-0000000000c1', v_consent, true,
        '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b11')
      ->> 'legal_hold') is distinct from 'true' then
    raise exception 'ASSERTION FAILED: re-asserting a hold is allowed';
  end if;

  if (public.set_consent_legal_hold(
        '00000000-0000-0000-0000-0000000000c1', v_consent, false,
        '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b12')
      ->> 'legal_hold') is distinct from 'false' then
    raise exception 'ASSERTION FAILED: the hold releases';
  end if;

  if (public.set_consent_legal_hold(
        '00000000-0000-0000-0000-0000000000c1', gen_random_uuid(), true,
        '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b13')
      ->> 'error') is distinct from 'not_found' then
    raise exception 'ASSERTION FAILED: a hold needs a real record';
  end if;
end $$;

-- ─── The ledger is the record: every accepted write, nothing refused ──
select pg_temp.assert_true(
  (select count(*) = 3 from public.audit_ledger
    where action_type = 'consent.recorded'
      and correlation_id in ('00000000-0000-0000-0000-0000000000b1',
                             '00000000-0000-0000-0000-0000000000b5',
                             '00000000-0000-0000-0000-0000000000b7')),
  'every accepted grant is ledgered under its correlation id');

select pg_temp.assert_true(
  (select count(*) = 2 from public.audit_ledger
    where action_type = 'consent.withdrawn'
      and correlation_id in ('00000000-0000-0000-0000-0000000000b2',
                             '00000000-0000-0000-0000-0000000000b8')),
  'every accepted withdrawal is ledgered');

select pg_temp.assert_true(
  (select count(*) = 1 from public.audit_ledger
    where action_type = 'consent.withdrawal.completed'
      and correlation_id = '00000000-0000-0000-0000-0000000000b3'),
  'the downstream completion is ledgered');

select pg_temp.assert_true(
  (select count(*) = 3 from public.audit_ledger
    where action_type = 'consent.legal_hold.set'
      and correlation_id in ('00000000-0000-0000-0000-000000000b10',
                             '00000000-0000-0000-0000-000000000b11',
                             '00000000-0000-0000-0000-000000000b12')),
  'every hold change is ledgered');

select pg_temp.assert_true(
  (select bool_and(actor_type = 'human'
                   and actor_id = '00000000-0000-0000-0000-0000000000a1')
     from public.audit_ledger
    where action_type in ('consent.recorded', 'consent.withdrawn',
                          'consent.legal_hold.set', 'consent.withdrawal.completed')),
  'the tenant user, a human, is the actor on every consent entry');

select pg_temp.assert_true(
  (select detail ->> 'revived' = 'true' from public.audit_ledger
    where action_type = 'consent.recorded'
      and correlation_id = '00000000-0000-0000-0000-0000000000b5'),
  'the revival is distinguished from a first grant in the ledger');

select pg_temp.assert_true(
  (select (select detail ->> 'hold' from public.audit_ledger
            where action_type = 'consent.legal_hold.set'
              and correlation_id = '00000000-0000-0000-0000-000000000b10') = 'true'
      and (select detail ->> 'hold' from public.audit_ledger
            where action_type = 'consent.legal_hold.set'
              and correlation_id = '00000000-0000-0000-0000-000000000b12') = 'false'),
  'the hold ledger entry carries the hold value');

select pg_temp.assert_true(
  (select count(*) = 0 from public.audit_ledger
    where correlation_id in ('00000000-0000-0000-0000-0000000000b4',
                             '00000000-0000-0000-0000-0000000000b6',
                             '00000000-0000-0000-0000-0000000000b9',
                             '00000000-0000-0000-0000-000000000b13')),
  'a refused write ledgeres nothing');

-- ─── RLS and privilege walls ──────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select pg_temp.assert_true(
  (select count(*) >= 1 from public.consent_records
    where tenant_id = '00000000-0000-0000-0000-0000000000c1'),
  'a tenant member reads the consent records');
select pg_temp.assert_true(
  (select count(*) = 0 from public.consent_records
    where tenant_id = '00000000-0000-0000-0000-0000000000c9'),
  'a member of one tenant reads none of another''s consents');
select pg_temp.assert_true(
  (select count(*) >= 1 from public.consent_purposes
    where tenant_id = '00000000-0000-0000-0000-0000000000c1'),
  'a tenant member reads the purpose registry');
select pg_temp.assert_true(
  (select count(*) = 0 from public.consent_purposes
    where tenant_id = '00000000-0000-0000-0000-0000000000c9'),
  'a member of one tenant reads none of another''s purposes');
select pg_temp.assert_true(
  (select count(*) >= 1 from public.consent_withdrawals
    where tenant_id = '00000000-0000-0000-0000-0000000000c1'),
  'a tenant member reads the withdrawal artifacts');
-- No INSERT/UPDATE/DELETE policies exist: writes are RPC-only.
select pg_temp.denied($q$insert into public.consent_records(
  tenant_id, purpose_id, principal_type, principal_ref, notice_version, granted_by, correlation_id)
  values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
          'email', 'forged@example.invalid', 1, '00000000-0000-0000-0000-0000000000a1',
          gen_random_uuid())$q$);
select pg_temp.denied($q$update public.consent_records set status = 'granted'$q$);
select pg_temp.denied($q$delete from public.consent_records$q$);
select pg_temp.denied($q$insert into public.consent_withdrawals(
  tenant_id, consent_record_id, purpose_id, principal_type, principal_ref, requested_by, correlation_id)
  values ('00000000-0000-0000-0000-0000000000c1', gen_random_uuid(),
          '00000000-0000-0000-0000-0000000000d1', 'email', 'forged@example.invalid',
          '00000000-0000-0000-0000-0000000000a1', gen_random_uuid())$q$);
select pg_temp.denied($q$delete from public.consent_withdrawals$q$);
select pg_temp.denied($q$delete from public.consent_purposes$q$);
select pg_temp.denied($q$insert into public.consent_purposes(
  tenant_id, purpose_key, name_en, lawful_basis, notice_en, created_by)
  values ('00000000-0000-0000-0000-0000000000c1', 'forged', 'Forged', 'consent',
          'Forged notice', '00000000-0000-0000-0000-0000000000a1')$q$);
-- The write paths are RPC-only in the other direction too: no EXECUTE
-- outside the BFF service role.
select pg_temp.denied($q$select public.record_consent(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
  'email', 'browser@example.invalid', 'en', 'form', null,
  '00000000-0000-0000-0000-0000000000a1', gen_random_uuid())$q$);
select pg_temp.denied($q$select public.withdraw_consent(
  '00000000-0000-0000-0000-0000000000c1', gen_random_uuid(), null, 'en',
  '00000000-0000-0000-0000-0000000000a1', gen_random_uuid())$q$);
reset role;

-- The Axiom-internal read: staff can see a tenant's consent state without
-- being a member of it.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}';
select pg_temp.assert_true(
  (select count(*) >= 1 from public.consent_records
    where tenant_id = '00000000-0000-0000-0000-0000000000c1'),
  'Axiom-internal staff read across tenants');
reset role;

-- The BFF's service role has no direct writes either — only the RPCs.
set local role service_role;
select pg_temp.denied($q$insert into public.consent_records(
  tenant_id, purpose_id, principal_type, principal_ref, notice_version, granted_by, correlation_id)
  values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
          'email', 'bff@example.invalid', 1, '00000000-0000-0000-0000-0000000000a1',
          gen_random_uuid())$q$);
select pg_temp.denied($q$update public.consent_records set status = 'withdrawn'$q$);
select pg_temp.denied($q$delete from public.consent_records$q$);
select pg_temp.denied($q$delete from public.consent_withdrawals$q$);
select pg_temp.denied($q$delete from public.consent_purposes$q$);
-- And the EXECUTE proof: the full consent lifecycle runs through the RPCs
-- as the BFF service role, and the row is only reachable that way.
do $$
declare
  v_consent uuid; v_withdrawal uuid; v_out jsonb;
begin
  v_out := public.record_consent(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
    'email', 'bff.subject@example.invalid', 'en', 'api', null,
    '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b14');
  if v_out ->> 'status' is distinct from 'granted' then
    raise exception 'ASSERTION FAILED: the service role calls the grant path (got %)', v_out ->> 'error';
  end if;
  v_consent := (v_out ->> 'consent_id')::uuid;

  v_out := public.withdraw_consent(
    '00000000-0000-0000-0000-0000000000c1', v_consent, 'BFF-driven withdrawal', 'en',
    '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b15');
  if v_out ->> 'withdrawal_id' is null then
    raise exception 'ASSERTION FAILED: the service role calls the withdraw path (got %)', v_out ->> 'error';
  end if;
  v_withdrawal := (v_out ->> 'withdrawal_id')::uuid;

  v_out := public.complete_withdrawal_downstream(
    '00000000-0000-0000-0000-0000000000c1', v_withdrawal,
    '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b16');
  if v_out ->> 'completed_at' is null then
    raise exception 'ASSERTION FAILED: the service role calls the completion path (got %)', v_out ->> 'error';
  end if;

  v_out := public.set_consent_legal_hold(
    '00000000-0000-0000-0000-0000000000c1', v_consent, true,
    '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b17');
  if v_out ->> 'legal_hold' is distinct from 'true' then
    raise exception 'ASSERTION FAILED: the service role calls the hold path (got %)', v_out ->> 'error';
  end if;
end $$;
reset role;

-- ─── Retention: nothing can shorten the history ───────────────────────
create function pg_temp.fk_delete_action(p_table text, p_column text) returns text language sql as $$
  select con.confdeltype::text
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class c on c.oid = con.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join unnest(con.conkey) with ordinality k(attnum, ord) on k.ord = 1
    join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
   where con.contype = 'f' and c.relname = p_table and a.attname = p_column
   limit 1
$$;
select pg_temp.assert_eq(
  pg_temp.fk_delete_action('consent_records', 'purpose_id'),
  'r', 'a purpose cannot take its consent history with it');
select pg_temp.assert_eq(
  pg_temp.fk_delete_action('consent_withdrawals', 'consent_record_id'),
  'r', 'a withdrawal cannot be separated from its record');
select pg_temp.assert_eq(
  pg_temp.fk_delete_action('consent_records', 'withdrawn_via_consent_id'),
  'r', 'the withdrawal reference is delete-restricted');
select pg_temp.assert_eq(
  pg_temp.fk_delete_action('consent_records', 'granted_by'),
  'r', 'a granter cannot take their grants along');
select pg_temp.assert_eq(
  pg_temp.fk_delete_action('consent_records', 'tenant_id'),
  'c', 'the only cascade is tenant teardown, which the design specifies');
select pg_temp.assert_true(
  (select count(*) = 0 from pg_catalog.pg_class
    where oid in ('public.consent_purposes'::regclass,
                  'public.consent_records'::regclass,
                  'public.consent_withdrawals'::regclass)
      and not relrowsecurity),
  'row level security is on for every consent table');
select pg_temp.assert_true(
  (select not exists (
     select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      cross join lateral pg_catalog.aclexplode(
        coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
      where c.relname in ('consent_purposes', 'consent_records', 'consent_withdrawals')
        and a.privilege_type = 'DELETE'
        and a.grantee <> c.relowner)),
  'no DELETE grant exists anywhere on the consent tables');

rollback;
