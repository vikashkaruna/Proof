-- W6 / migration 0067: the drift acknowledgement write path.
--
-- `acknowledge_drift_event` is the human's write path onto a detection:
-- one acknowledgement, bound to a real event and a real user, with both
-- columns committed together and the judgement ledgered.

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
  ('00000000-0000-0000-0000-0000000000a9', 'manager@test.invalid');
insert into public.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a9', 'manager@test.invalid');
insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-0000000000c1', 'ack-a', 'Acknowledge A');
insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-ack', now(), 'test', 'test', 0);
insert into public.engagements(id, tenant_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c1', 'test-ack', 'E');
insert into public.estates(id, tenant_id, slug, name)
  values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1',
          'india-production', 'India production');
insert into public.drift_events(id, tenant_id, estate_id, kind, severity, summary)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1',
        '00000000-0000-0000-0000-0000000000e1', 'system_added', 'medium', 'system added: New CRM');

-- ─── A judgement lands once, bound to event and user ─────────────────
select pg_temp.assert_eq(
  (select public.acknowledge_drift_event(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
     '00000000-0000-0000-0000-0000000000a9', gen_random_uuid())
   ->> 'acknowledged'),
  'true', 'the detection is acknowledged');

select pg_temp.assert_true(
  (select acknowledged_by = '00000000-0000-0000-0000-0000000000a9' and acknowledged_at is not null
     from public.drift_events where id = '00000000-0000-0000-0000-0000000000d1'),
  'the event carries who acknowledged and when');

select pg_temp.assert_true((select count(*) >= 1 from public.audit_ledger
  where action_type = 'monitoring.drift.acknowledged'
    and target_ref = '00000000-0000-0000-0000-0000000000d1'),
  'the judgement is in the ledger');

-- A second acknowledgement is refused: the judgement stands.
select pg_temp.assert_eq(
  (select public.acknowledge_drift_event(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
     '00000000-0000-0000-0000-0000000000a9', gen_random_uuid())
   ->> 'error'),
  'already_acknowledged', 'the first judgement is the record');

-- ─── The gate refusals ───────────────────────────────────────────────
select pg_temp.assert_eq(
  (select public.acknowledge_drift_event(
     '00000000-0000-0000-0000-0000000000c1', gen_random_uuid(),
     '00000000-0000-0000-0000-0000000000a9', gen_random_uuid())
   ->> 'error'),
  'event_not_found', 'an acknowledgement names a real event');

select pg_temp.assert_eq(
  (select public.acknowledge_drift_event(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
     gen_random_uuid(), gen_random_uuid())
   ->> 'error'),
  'invalid_record', 'an anonymous judgement is refused');

-- ─── Nobody writes acknowledgements except the SECURITY DEFINER ──────
insert into public.drift_events(id, tenant_id, estate_id, kind, severity, summary)
values ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1',
        '00000000-0000-0000-0000-0000000000e1', 'connection_lost', 'high', 'connection lost: Old Warehouse');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}';
select pg_temp.denied($q$select public.acknowledge_drift_event(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2',
  '00000000-0000-0000-0000-0000000000a9', gen_random_uuid())$q$);
select pg_temp.denied($q$update public.drift_events set acknowledged_at = now()$q$);
select pg_temp.denied($q$delete from public.drift_events$q$);
reset role;

set local role service_role;
select pg_temp.assert_true(
  (select count(*) >= 1 from public.drift_events), 'the BFF service reads drift events');
select pg_temp.denied($q$update public.drift_events set acknowledged_at = now()$q$);
select pg_temp.denied($q$delete from public.drift_events$q$);
reset role;

rollback;
