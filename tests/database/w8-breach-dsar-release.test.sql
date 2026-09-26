-- W8 · Revision 98 / migration 0071: the DSAR lifecycle, the breach
-- operations chain, and the founder release gate.
--
-- 0006 created the tables; these assertions protect the workflows that make
-- them real: a DSAR cannot reach fulfilment without a verified identity, or
-- complete without a fulfilment artifact, or die without a captured reason;
-- a breach state machine is strictly linear with a server-owned 72-hour
-- clock; a notification cannot be sent unless a second human reviewed it and
-- the sender is not the drafter, with every attempt recorded as evidence and
-- the statutory timestamp written only by a delivered send; and unreviewed
-- client output cannot be released — approve/reject/release is Axiom-internal
-- authority, rejection carries a reason, and the released content is hashed
-- into the row. No role but the SECURITY DEFINER paths writes any of it.

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
-- a1: tenant-1 owner (the drafter in maker-checker flows)
-- a2: tenant-1 admin (the second human: reviewer / sender)
-- a3: Axiom-internal (the founder authority for review/release)
-- a4: tenant-2 owner (foreign tenant, non-internal)
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'drafter@test.invalid'),
  ('00000000-0000-0000-0000-0000000000a2', 'checker@test.invalid'),
  ('00000000-0000-0000-0000-0000000000a3', 'founder@axiomminds.invalid'),
  ('00000000-0000-0000-0000-0000000000a4', 'foreign@test.invalid');
insert into public.users(id, email, is_axiom_internal) values
  ('00000000-0000-0000-0000-0000000000a1', 'drafter@test.invalid', false),
  ('00000000-0000-0000-0000-0000000000a2', 'checker@test.invalid', false),
  ('00000000-0000-0000-0000-0000000000a3', 'founder@axiomminds.invalid', true),
  ('00000000-0000-0000-0000-0000000000a4', 'foreign@test.invalid', false);
insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-0000000000c1', 'w8-a', 'W8 Tenant A'),
  ('00000000-0000-0000-0000-0000000000c9', 'w8-b', 'W8 Tenant B');
insert into public.tenant_users(tenant_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a2', 'admin'),
  ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000a4', 'owner');
insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-w8', now(), 'test', 'test', 0);

-- Fulfilment evidence for the completed-DSAR path.
insert into public.evidence(id, tenant_id, content_hash, storage_uri, evidence_type,
                            collected_by_agent)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1',
        repeat('f', 64), 's3://w8-test/fulfilment', 'report', 'test');

-- Draft reports: r1 approved→released, r2 rejected, r3 stays draft.
insert into public.reports(id, tenant_id, kind, title, storage_uri, content,
                           library_version, generated_by_agent)
values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000c1', 'board',
   'Board report', 's3://w8-test/r1', '{"blocks": [1, 2, 3]}'::jsonb, 'test-w8', 'parikshan'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000c1', 'dpb',
   'DPB submission', 's3://w8-test/r2', '{"blocks": [4]}'::jsonb, 'test-w8', 'parikshan'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000c1', 'auditor',
   'Auditor pack', 's3://w8-test/r3', '{"blocks": [5]}'::jsonb, 'test-w8', 'parikshan');

-- ─── W8.1 · DSAR intake, verification, the closed chain ──────────────

-- Intake starts the statutory clock (server-owned) and a calendar deadline.
select pg_temp.assert_true(
  (public.record_dsar(
     '00000000-0000-0000-0000-0000000000c1', 'access', 'Asha Rao',
     'asha@example.invalid', null, 30, null,
     '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) -> 'dsarId') is not null,
  'DSAR intake returns the request id');
select pg_temp.assert_true(
  (select due_by between clock_timestamp() + interval '29 days'
                        and clock_timestamp() + interval '31 days'
    from public.dsars where data_principal_email = 'asha@example.invalid'),
  'the 30-day clock is computed by the server, not the caller');
select pg_temp.assert_true(
  (select count(*) = 1 from public.compliance_events
    where dsar_id = (select id from public.dsars
                       where data_principal_email = 'asha@example.invalid')
      and due_at = (select due_by from public.dsars
                      where data_principal_email = 'asha@example.invalid')),
  'intake opens a deadline compliance event bound to the request');
select pg_temp.assert_true(
  (select count(*) = 1 from public.audit_ledger
    where action_type = 'dsar.received'
      and target_ref = (select id::text from public.dsars
                          where data_principal_email = 'asha@example.invalid')),
  'intake is ledgered as dsar.received');

-- Intake refusals: no contact channel, malformed email, bad kind, bad clock.
select pg_temp.assert_eq(
  (public.record_dsar('00000000-0000-0000-0000-0000000000c1', 'access', 'No contact',
    null, null, 30, null, '00000000-0000-0000-0000-0000000000a1', gen_random_uuid())
     ->> 'error'),
  'invalid_request', 'intake without any contact channel is refused');
select pg_temp.assert_eq(
  (public.record_dsar('00000000-0000-0000-0000-0000000000c1', 'access', null,
    'not-an-email', null, 30, null, '00000000-0000-0000-0000-0000000000a1',
    gen_random_uuid()) ->> 'error'),
  'invalid_request', 'a malformed principal email is refused');
select pg_temp.assert_eq(
  (public.record_dsar('00000000-0000-0000-0000-0000000000c1', 'opinion', null,
    'x@example.invalid', null, 30, null, '00000000-0000-0000-0000-0000000000a1',
    gen_random_uuid()) ->> 'error'),
  'invalid_request', 'a kind outside the closed set is refused');
select pg_temp.assert_eq(
  (public.record_dsar('00000000-0000-0000-0000-0000000000c1', 'access', null,
    'x@example.invalid', null, 0, null, '00000000-0000-0000-0000-0000000000a1',
    gen_random_uuid()) ->> 'error'),
  'invalid_request', 'a zero-day clock is refused');
select pg_temp.assert_eq(
  (public.record_dsar('00000000-0000-0000-0000-0000000000c1', 'access', null,
    'x@example.invalid', null, 91, null, '00000000-0000-0000-0000-0000000000a1',
    gen_random_uuid()) ->> 'error'),
  'invalid_request', 'a 91-day clock is refused');

-- The fulfilment chain on one DSAR; refusal paths on another.
select pg_temp.assert_true(
  (public.verify_dsar_identity('00000000-0000-0000-0000-0000000000c1',
    (select id from public.dsars where data_principal_email = 'asha@example.invalid'),
    'government_id + live match', '00000000-0000-0000-0000-0000000000a2',
    gen_random_uuid()) ->> 'identityVerified') = 'true',
  'identity verification binds who verified and how');
select pg_temp.assert_eq(
  (public.advance_dsar('00000000-0000-0000-0000-0000000000c1',
    (select id from public.dsars where data_principal_email = 'asha@example.invalid'),
    'in_fulfilment', null, null, '00000000-0000-0000-0000-0000000000a1',
    gen_random_uuid()) ->> 'status'),
  'in_fulfilment', 'a verified DSAR enters fulfilment');

insert into public.dsars(id, tenant_id, kind, status, data_principal_email, due_by)
values ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1',
        'erasure', 'identity_verification', 'skip@example.invalid',
        clock_timestamp() + interval '20 days');
select pg_temp.assert_eq(
  (public.advance_dsar('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000d2', 'in_fulfilment', null, null,
    '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'status'),
  'in_fulfilment', 'a verified DSAR enters fulfilment');
select pg_temp.assert_eq(
  (public.advance_dsar('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000d2', 'completed', null, null,
    '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'fulfilment_evidence_required', 'completion without a fulfilment artifact is refused');
select pg_temp.assert_eq(
  (public.advance_dsar('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000d2', 'completed', null,
    '00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000a1',
    gen_random_uuid()) ->> 'error'),
  'fulfilment_evidence_not_found', 'a fulfilment artifact from another tenant is refused');
select pg_temp.assert_eq(
  (public.advance_dsar('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000d2', 'rejected', null, null,
    '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'reason_required', 'rejection without a captured reason is refused (FR-7.6)');
select pg_temp.assert_eq(
  (public.advance_dsar('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000d2', 'rejected',
    'Request conflicts with the legal retention duty.', null,
    '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'status'),
  'rejected', 'a reasoned rejection is the sanctioned death of a DSAR');
select pg_temp.assert_true(
  (select rejection_reason = 'Request conflicts with the legal retention duty.'
    from public.dsars where id = '00000000-0000-0000-0000-0000000000d2'),
  'the rejection reason is preserved on the row');

-- A foreign tenant cannot advance what it does not own.
select pg_temp.assert_eq(
  (public.advance_dsar('00000000-0000-0000-0000-0000000000c9',
    '00000000-0000-0000-0000-0000000000d2', 'escalated', null, null,
    '00000000-0000-0000-0000-0000000000a4', gen_random_uuid()) ->> 'error'),
  'dsar_not_found', 'a foreign tenant cannot touch another tenant''s DSAR');

-- Completion requires everything the chain built.
select pg_temp.assert_eq(
  (public.advance_dsar('00000000-0000-0000-0000-0000000000c1',
    (select id from public.dsars where data_principal_email = 'asha@example.invalid'),
    'completed', null, '00000000-0000-0000-0000-0000000000e1',
    '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'status'),
  'completed', 'a verified, evidenced DSAR completes');
select pg_temp.assert_true(
  (select completed_at is not null
    and fulfillment_evidence_id = '00000000-0000-0000-0000-0000000000e1'
    from public.dsars where data_principal_email = 'asha@example.invalid'),
  'completion binds the server clock and the fulfilment artifact');
select pg_temp.assert_true(
  (select count(*) = 1 from public.audit_ledger
    where action_type = 'dsar.fulfilled'
      and target_ref = (select id::text from public.dsars
                          where data_principal_email = 'asha@example.invalid')),
  'completion is ledgered as dsar.fulfilled');

-- Escalation is its own recorded decision, on its own request: a completed
-- DSAR is terminal, and escalation is for the ones still in flight.
insert into public.dsars(id, tenant_id, kind, status, data_principal_email, due_by)
values ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000c1',
        'portability', 'in_fulfilment', 'slow@example.invalid',
        clock_timestamp() + interval '25 days');
select pg_temp.assert_eq(
  (public.advance_dsar('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000d3', 'escalated',
    'Ownership dispute on the exporting system.', null,
    '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'status'),
  'escalated', 'an in-fulfilment DSAR can be escalated');
select pg_temp.assert_true(
  (select count(*) = 1 from public.audit_ledger
    where action_type = 'dsar.escalated'
      and target_ref = '00000000-0000-0000-0000-0000000000d3'),
  'escalation is ledgered as dsar.escalated');

-- ─── W8.2 · Breach intake, the linear state machine, notifications ───

select pg_temp.assert_true(
  (public.record_breach('00000000-0000-0000-0000-0000000000c1', 'CRM export exposed',
    'A misconfigured export exposed contact records to a vendor subprocessor.',
    'high', clock_timestamp() - interval '2 hours',
    ARRAY['contact', 'email'], 120,
    '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) -> 'breachId') is not null,
  'breach intake returns the incident id');
select pg_temp.assert_true(
  (select dpb_notification_due_by between clock_timestamp() + interval '71 hours'
                                        and clock_timestamp() + interval '73 hours'
    from public.breaches where title = 'CRM export exposed'),
  'the 72-hour DPB clock is server-owned');
select pg_temp.assert_true(
  (select count(*) = 1 from public.compliance_events
    where breach_id = (select id from public.breaches where title = 'CRM export exposed')
      and due_at = (select dpb_notification_due_by from public.breaches
                      where title = 'CRM export exposed')),
  'intake opens the 72-hour deadline compliance event');
select pg_temp.assert_true(
  (select count(*) = 1 from public.audit_ledger
    where action_type = 'breach.detected'
      and target_ref = (select id::text from public.breaches
                          where title = 'CRM export exposed')),
  'breach intake is ledgered as breach.detected');

select pg_temp.assert_eq(
  (public.record_breach('00000000-0000-0000-0000-0000000000c1', 'Future breach',
    'Cannot have happened yet.', 'low', clock_timestamp() + interval '1 hour', '{}', null,
    '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'invalid_request', 'a future occurred_at is refused');
select pg_temp.assert_eq(
  (public.record_breach('00000000-0000-0000-0000-0000000000c1', 'Bad severity',
    'Severity outside the closed set.', 'catastrophic', null, '{}', null,
    '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'invalid_request', 'a severity outside the closed set is refused');

-- The strictly linear state machine.
select pg_temp.assert_eq(
  (public.advance_breach('00000000-0000-0000-0000-0000000000c1',
    (select id from public.breaches where title = 'CRM export exposed'),
    'contained', null, '00000000-0000-0000-0000-0000000000a1', gen_random_uuid())
     ->> 'error'),
  'invalid_transition', 'detection cannot skip triage');

-- ─── The notification authority chain on its own breach ──────────────
insert into public.breaches(id, tenant_id, title, description, severity, status,
                            detected_at, dpb_notification_due_by, owner_id)
values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
        'Chain breach', 'Drives through the whole chain.', 'critical', 'contained',
        clock_timestamp(), clock_timestamp() + interval '70 hours',
        '00000000-0000-0000-0000-0000000000a1');
select pg_temp.assert_eq(
  (public.advance_breach('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000b1', 'notifying_dpb', null,
    '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'status'),
  'notifying_dpb', 'containment hands over to the DPB notification stage');

select pg_temp.assert_eq(
  (public.draft_breach_notification('00000000-0000-0000-0000-0000000000c9',
    '00000000-0000-0000-0000-0000000000b1', 'dpb', 'en', 'Subject', 'Body',
    '00000000-0000-0000-0000-0000000000a4', gen_random_uuid()) ->> 'error'),
  'breach_not_found', 'a foreign tenant cannot draft against another''s breach');

select pg_temp.assert_true(
  (public.draft_breach_notification('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000b1', 'dpb', 'en',
    'Notification under section 8(6)', 'Initial draft.',
    '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) -> 'notificationId')
    is not null,
  'the first DPB draft exists');
select pg_temp.assert_true(
  (public.draft_breach_notification('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000b1', 'dpb', 'hi',
    'धारा 8(6) के अंतर्गत सूचना', 'Revised draft.',
    '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) -> 'notificationId')
    is not null,
  'the revised DPB draft exists (Hindi, FR-12.3)');
select pg_temp.assert_true(
  (select count(*) = 1 and bool_and(status = 'superseded')
    from public.breach_notifications
    where breach_id = '00000000-0000-0000-0000-0000000000b1' and kind = 'dpb'
      and superseded_by is not null),
  'the superseded draft is pointed at its replacement, not deleted');

select pg_temp.assert_eq(
  (public.review_breach_notification('00000000-0000-0000-0000-0000000000c1',
    (select id from public.breach_notifications
      where breach_id = '00000000-0000-0000-0000-0000000000b1' and status = 'reviewed'
      limit 0), '00000000-0000-0000-0000-0000000000a2', gen_random_uuid()) ->> 'error'),
  'notification_not_found', 'reviewing an unknown notification is refused');
select pg_temp.assert_eq(
  (public.review_breach_notification('00000000-0000-0000-0000-0000000000c1',
    (select id from public.breach_notifications
      where breach_id = '00000000-0000-0000-0000-0000000000b1' and status = 'draft'
      limit 1), '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'self_review_forbidden', 'the drafter cannot review their own draft');

-- The live draft is reviewed by the second human; sending has the same rule.
select pg_temp.assert_eq(
  (public.review_breach_notification('00000000-0000-0000-0000-0000000000c1',
    (select id from public.breach_notifications
      where breach_id = '00000000-0000-0000-0000-0000000000b1' and status = 'draft'
      limit 1), '00000000-0000-0000-0000-0000000000a2', gen_random_uuid()) ->> 'status'),
  'reviewed', 'the second human''s review moves the draft to reviewed');
select pg_temp.assert_eq(
  (public.send_breach_notification('00000000-0000-0000-0000-0000000000c1',
    (select id from public.breach_notifications
      where breach_id = '00000000-0000-0000-0000-0000000000b1' and status = 'reviewed'
      limit 1), 'delivered', '{}', '00000000-0000-0000-0000-0000000000a1',
    gen_random_uuid()) ->> 'error'),
  'self_send_forbidden', 'the drafter cannot send, even after review');

-- A failed attempt is evidence, not a statutory fact.
select pg_temp.assert_eq(
  (public.send_breach_notification('00000000-0000-0000-0000-0000000000c1',
    (select id from public.breach_notifications
      where breach_id = '00000000-0000-0000-0000-0000000000b1' and status = 'reviewed'
      limit 1), 'failed', '{"reason": "portal down"}'::jsonb,
    '00000000-0000-0000-0000-0000000000a2', gen_random_uuid()) ->> 'deliveryAttempts'),
  '1', 'a failed send records the attempt and stays reviewed');
select pg_temp.assert_true(
  (select dpb_notified_at is null from public.breaches
    where id = '00000000-0000-0000-0000-0000000000b1'),
  'a failed attempt does not start the statutory fact');
select pg_temp.assert_true(
  (select count(*) = 1 from public.audit_ledger
    where action_type = 'breach.notification.attempt'
      and target_ref = (select id::text from public.breach_notifications
                          where breach_id = '00000000-0000-0000-0000-0000000000b1'
                            and status = 'reviewed')),
  'the attempt is ledgered as evidence');

select pg_temp.assert_eq(
  (public.send_breach_notification('00000000-0000-0000-0000-0000000000c1',
    (select id from public.breach_notifications
      where breach_id = '00000000-0000-0000-0000-0000000000b1' and status = 'reviewed'
      limit 1), 'delivered', '{"reference": "DPB-2026-000123"}'::jsonb,
    '00000000-0000-0000-0000-0000000000a2', gen_random_uuid()) ->> 'status'),
  'sent', 'a delivered send completes the notification');
select pg_temp.assert_true(
  (select dpb_notified_at is not null from public.breaches
    where id = '00000000-0000-0000-0000-0000000000b1'),
  'only a delivered send writes the statutory DPB timestamp');
select pg_temp.assert_true(
  (select count(*) = 1 from public.audit_ledger
    where action_type = 'breach.notified.dpb'
      and target_ref = (select id::text from public.breach_notifications
                          where breach_id = '00000000-0000-0000-0000-0000000000b1'
                            and status = 'sent')),
  'the delivered send is ledgered as breach.notified.dpb');

-- The chain continues: principals, post-mortem, closed — then no more.
select pg_temp.assert_eq(
  (public.advance_breach('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000b1', 'notifying_principals', null,
    '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'status'),
  'notifying_principals', 'the state machine advances past the DPB send');
select pg_temp.assert_true(
  (public.draft_breach_notification('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000b1', 'affected_principal', 'en',
    'Notice of a data breach', 'Principal notice body.',
    '00000000-0000-0000-0000-0000000000a2', gen_random_uuid()) -> 'notificationId')
    is not null,
  'the principal notice is drafted');
select pg_temp.assert_eq(
  (public.review_breach_notification('00000000-0000-0000-0000-0000000000c1',
    (select id from public.breach_notifications
      where breach_id = '00000000-0000-0000-0000-0000000000b1'
        and kind = 'affected_principal'), '00000000-0000-0000-0000-0000000000a1',
    gen_random_uuid()) ->> 'status'),
  'reviewed', 'the principal notice is reviewed');
select pg_temp.assert_eq(
  (public.send_breach_notification('00000000-0000-0000-0000-0000000000c1',
    (select id from public.breach_notifications
      where breach_id = '00000000-0000-0000-0000-0000000000b1'
        and kind = 'affected_principal'), 'delivered', '{"channel": "email"}'::jsonb,
    '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'status'),
  'sent', 'the principal notice is sent');
select pg_temp.assert_true(
  (select principals_notified_at is not null from public.breaches
    where id = '00000000-0000-0000-0000-0000000000b1'),
  'the principal statutory timestamp is written by the delivered send');
select pg_temp.assert_eq(
  (public.advance_breach('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000b1', 'post_mortem', null,
    '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'status'),
  'post_mortem', 'the chain reaches post-mortem');
select pg_temp.assert_eq(
  (public.advance_breach('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000b1', 'closed', null,
    '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'status'),
  'closed', 'the chain closes');
select pg_temp.assert_eq(
  (public.advance_breach('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000b1', 'triaging', null,
    '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'invalid_transition', 'a closed breach stays closed');
select pg_temp.assert_eq(
  (public.draft_breach_notification('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000b1', 'dpb', 'en', 'Late', 'Too late.',
    '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'breach_closed', 'no drafts against a closed breach');

-- The attempt cap is a decision, not a constraint violation.
insert into public.breaches(id, tenant_id, title, description, severity, status,
                            detected_at, dpb_notification_due_by, owner_id)
values ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000c1',
        'Cap breach', 'Exercises the attempt cap.', 'medium', 'contained',
        clock_timestamp(), clock_timestamp() + interval '70 hours',
        '00000000-0000-0000-0000-0000000000a1');
select pg_temp.assert_true(
  (public.draft_breach_notification('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000b2', 'dpb', 'en', 'S', 'B',
    '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) -> 'notificationId')
    is not null, 'the cap-fixture draft exists');
select pg_temp.assert_eq(
  (public.review_breach_notification('00000000-0000-0000-0000-0000000000c1',
    (select id from public.breach_notifications
      where breach_id = '00000000-0000-0000-0000-0000000000b2'),
    '00000000-0000-0000-0000-0000000000a2', gen_random_uuid()) ->> 'status'),
  'reviewed', 'the cap-fixture draft is reviewed');
select pg_temp.assert_eq(
  (public.send_breach_notification('00000000-0000-0000-0000-0000000000c1',
    (select id from public.breach_notifications
      where breach_id = '00000000-0000-0000-0000-0000000000b2'),
    'failed', '{"i": 1}'::jsonb, '00000000-0000-0000-0000-0000000000a2',
    gen_random_uuid()) ->> 'deliveryAttempts'),
  '1', 'attempt 1 recorded');
select pg_temp.assert_eq(
  (public.send_breach_notification('00000000-0000-0000-0000-0000000000c1',
    (select id from public.breach_notifications
      where breach_id = '00000000-0000-0000-0000-0000000000b2'),
    'failed', '{"i": 2}'::jsonb, '00000000-0000-0000-0000-0000000000a2',
    gen_random_uuid()) ->> 'deliveryAttempts'),
  '2', 'attempt 2 recorded');
select pg_temp.assert_eq(
  (public.send_breach_notification('00000000-0000-0000-0000-0000000000c1',
    (select id from public.breach_notifications
      where breach_id = '00000000-0000-0000-0000-0000000000b2'),
    'failed', '{"i": 3}'::jsonb, '00000000-0000-0000-0000-0000000000a2',
    gen_random_uuid()) ->> 'deliveryAttempts'),
  '3', 'attempt 3 recorded');
select pg_temp.assert_eq(
  (public.send_breach_notification('00000000-0000-0000-0000-0000000000c1',
    (select id from public.breach_notifications
      where breach_id = '00000000-0000-0000-0000-0000000000b2'),
    'failed', '{"i": 4}'::jsonb, '00000000-0000-0000-0000-0000000000a2',
    gen_random_uuid()) ->> 'deliveryAttempts'),
  '4', 'attempt 4 recorded');
select pg_temp.assert_eq(
  (public.send_breach_notification('00000000-0000-0000-0000-0000000000c1',
    (select id from public.breach_notifications
      where breach_id = '00000000-0000-0000-0000-0000000000b2'),
    'failed', '{"i": 5}'::jsonb, '00000000-0000-0000-0000-0000000000a2',
    gen_random_uuid()) ->> 'deliveryAttempts'),
  '5', 'attempt 5 recorded');
select pg_temp.assert_eq(
  (public.send_breach_notification('00000000-0000-0000-0000-0000000000c1',
    (select id from public.breach_notifications
      where breach_id = '00000000-0000-0000-0000-0000000000b2'),
    'failed', '{"i": 6}'::jsonb, '00000000-0000-0000-0000-0000000000a2',
    gen_random_uuid()) ->> 'error'),
  'too_many_attempts', 'the sixth attempt is refused as a decision');

-- ─── W8.3 · The founder review and release gate ──────────────────────

select pg_temp.assert_eq(
  (public.review_report('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000f1', 'approved', null,
    '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'founder_authority_required', 'a tenant user cannot review a report (BR-4)');
select pg_temp.assert_eq(
  (public.release_report('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000f3',
    '00000000-0000-0000-0000-0000000000a3', gen_random_uuid()) ->> 'error'),
  'not_approved', 'a draft report cannot be released');
select pg_temp.assert_eq(
  (public.review_report('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000f1', 'approved', null,
    '00000000-0000-0000-0000-0000000000a3', gen_random_uuid()) ->> 'status'),
  'approved', 'the founder approves the board report');
select pg_temp.assert_true(
  (select count(*) = 1 from public.audit_ledger
    where action_type = 'report.approved' and target_ref like '%f1%'),
  'the approval is ledgered');
select pg_temp.assert_eq(
  (public.review_report('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000f1', 'rejected', 'Second thoughts',
    '00000000-0000-0000-0000-0000000000a3', gen_random_uuid()) ->> 'error'),
  'not_reviewable', 'a decided report cannot be re-decided');
select pg_temp.assert_eq(
  (public.review_report('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000f2', 'rejected', null,
    '00000000-0000-0000-0000-0000000000a3', gen_random_uuid()) ->> 'error'),
  'reason_required', 'rejection without a captured reason is refused');
select pg_temp.assert_eq(
  (public.review_report('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000f2', 'rejected', 'Numbers do not match the ledger.',
    '00000000-0000-0000-0000-0000000000a3', gen_random_uuid()) ->> 'status'),
  'rejected', 'a reasoned rejection is recorded');
select pg_temp.assert_true(
  (select rejected_by = '00000000-0000-0000-0000-0000000000a3'
    and rejection_reason = 'Numbers do not match the ledger.'
    from public.reports where id = '00000000-0000-0000-0000-0000000000f2'),
  'the rejection preserves who rejected and why');
select pg_temp.assert_eq(
  (public.release_report('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000f2',
    '00000000-0000-0000-0000-0000000000a3', gen_random_uuid()) ->> 'error'),
  'not_approved', 'a rejected report cannot be released');
select pg_temp.assert_eq(
  (public.release_report('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000f1',
    '00000000-0000-0000-0000-0000000000a1', gen_random_uuid()) ->> 'error'),
  'founder_authority_required', 'release is founder authority too');
select pg_temp.assert_eq(
  (public.release_report('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000f1',
    '00000000-0000-0000-0000-0000000000a3', gen_random_uuid()) ->> 'status'),
  'published', 'the founder releases the approved report');
select pg_temp.assert_true(
  (select released_content_hash = encode(digest(content::text, 'sha256'), 'hex')
    from public.reports where id = '00000000-0000-0000-0000-0000000000f1'),
  'the released content hash is computed over the actual content');
select pg_temp.assert_true(
  (select count(*) = 1 from public.audit_ledger
    where action_type = 'report.released' and target_ref like '%f1%'),
  'the release is ledgered');

-- ─── RLS and the privilege wall ──────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select pg_temp.assert_true(
  (select count(*) >= 1 from public.breach_notifications where tenant_id = '00000000-0000-0000-0000-0000000000c1'),
  'a tenant member reads their breach notifications');
select pg_temp.assert_true(
  (select count(*) = 0 from public.breach_notifications where tenant_id = '00000000-0000-0000-0000-0000000000c9'),
  'a member of one tenant reads none of another''s notifications');
select pg_temp.denied($q$insert into public.breaches (tenant_id, title, description, severity, dpb_notification_due_by)
  values ('00000000-0000-0000-0000-0000000000c1', 'side door', 'x', 'low', now())$q$);
select pg_temp.denied($q$update public.dsars set status = 'completed'$q$);
select pg_temp.denied($q$update public.reports set status = 'published'$q$);
select pg_temp.denied($q$insert into public.breach_notifications (tenant_id, breach_id, kind, subject, body, correlation_id, created_by)
  values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', 'dpb', 's', 'b', gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1')$q$);
select pg_temp.denied($q$delete from public.dsars where data_principal_email = 'asha@example.invalid'$q$);
reset role;

set local role service_role;
select pg_temp.denied($q$insert into public.breaches (tenant_id, title, description, severity, dpb_notification_due_by)
  values ('00000000-0000-0000-0000-0000000000c1', 'service door', 'x', 'low', now())$q$);
select pg_temp.denied($q$update public.reports set status = 'published'$q$);
select pg_temp.denied($q$delete from public.breach_notifications where true$q$);
select pg_temp.assert_eq(
  (public.review_report('00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000f3', 'approved', 'Foundry pass',
    '00000000-0000-0000-0000-0000000000a3', gen_random_uuid()) ->> 'status'),
  'approved', 'the BFF service role can call the review path');
reset role;

rollback;
