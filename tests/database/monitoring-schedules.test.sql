-- W6 / migration 0065: monitoring schedules and the continuous-compliance
-- foundation tables.
--
-- `register_monitoring_schedule` is the estate manager's write path. What
-- the assertions protect: one ACTIVE schedule per estate+kind (a
-- re-registration retires the previous one, audited), a future first fire,
-- bounded names and shaped cadences, and no direct writes from any role.

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
create function pg_temp.raises(expected_sqlstate text, statement text, message text) returns void language plpgsql as $$
begin
  execute statement;
  raise exception 'ASSERTION FAILED: % (no raise, expected sqlstate %)', message, expected_sqlstate;
exception when others then
  if sqlstate <> expected_sqlstate then
    raise exception 'ASSERTION FAILED: % (sqlstate %, wanted %)', message, sqlstate, expected_sqlstate;
  end if;
end $$;

-- ─── Fixture ─────────────────────────────────────────────────────────
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a9', 'manager@test.invalid'),
  ('00000000-0000-0000-0000-0000000000a8', 'checker@test.invalid');
insert into public.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a9', 'manager@test.invalid'),
  ('00000000-0000-0000-0000-0000000000a8', 'checker@test.invalid');
insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-0000000000c1', 'w6-a', 'Compliance A');
insert into public.tenant_users(tenant_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a9', 'owner');
insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-w6', now(), 'test', 'test', 0);
insert into public.engagements(id, tenant_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c1', 'test-w6', 'E');
insert into public.estates(id, tenant_id, slug, name)
  values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1',
          'india-production', 'India production');

-- ─── Registration retires the previous schedule of its kind ──────────
select pg_temp.assert_eq(
  (select public.register_monitoring_schedule(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1',
     'Fortnightly drift check', 'drift_check', '*/15 * * * *',
     now() + interval '1 hour', '00000000-0000-0000-0000-0000000000a9')
   -> 'schedule' ->> 'status'),
  'active', 'the schedule registers active');

select pg_temp.assert_eq(
  (select public.register_monitoring_schedule(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1',
     'Fortnightly drift check v2', 'drift_check', '0 3 * * *',
     now() + interval '2 hours', '00000000-0000-0000-0000-0000000000a9')
   -> 'schedule' ->> 'status'),
  'active', 'a re-registration also lands active');

select pg_temp.assert_true(
  (select count(*) = 1 from public.monitoring_schedules
    where estate_id = '00000000-0000-0000-0000-0000000000e1' and status = 'active'),
  'only one active schedule of a kind per estate');

select pg_temp.assert_true(
  (select count(*) = 1 from public.monitoring_schedules
    where estate_id = '00000000-0000-0000-0000-0000000000e1' and status = 'retired'),
  'the replaced schedule is retired, not deleted');

select pg_temp.assert_true((select count(*) >= 2 from public.audit_ledger
  where action_type = 'monitoring.schedule.registered'
    and target_ref in (select id::text from public.monitoring_schedules
                        where estate_id = '00000000-0000-0000-0000-0000000000e1')),
  'both registrations are in the ledger');

-- Different kinds coexist.
select pg_temp.assert_eq(
  (select public.register_monitoring_schedule(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1',
     'Quarterly reassessment', 'reassessment', '0 4 1 * *',
     now() + interval '3 hours', '00000000-0000-0000-0000-0000000000a9')
   -> 'schedule' ->> 'status'),
  'active', 'a different kind coexists');

-- ─── The gate refusals ───────────────────────────────────────────────
select pg_temp.assert_eq(
  (select public.register_monitoring_schedule(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1',
     'Past fire', 'drift_check', '*/15 * * * *',
     now() - interval '1 minute', '00000000-0000-0000-0000-0000000000a9')
   ->> 'error'),
  'invalid_request', 'a first fire in the past is refused');

select pg_temp.assert_eq(
  (select public.register_monitoring_schedule(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1',
     'Free; text <cadence>', 'drift_check', 'every 15 minutes',
     now() + interval '1 hour', '00000000-0000-0000-0000-0000000000a9')
   ->> 'error'),
  'invalid_request', 'an unshaped cadence is refused');

select pg_temp.assert_eq(
  (select public.register_monitoring_schedule(
     '00000000-0000-0000-0000-0000000000c1', gen_random_uuid(),
     'Nowhere', 'drift_check', '*/15 * * * *',
     now() + interval '1 hour', '00000000-0000-0000-0000-0000000000a9')
   ->> 'error'),
  'estate_not_found', 'a schedule names a real estate');

-- ─── Standing policies and evaluations: shape guards ─────────────────
insert into public.standing_approval_policies(id, tenant_id, name, scope, created_by, approved_by, expires_at)
values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000c1',
        'Auto-remediate small retention purges',
        '{"action_types": ["data.retention_purge"], "max_records": 1000, "environments": ["non-production"]}'::jsonb,
        '00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-0000000000a8',
        now() + interval '90 days');

insert into public.policy_evaluations(tenant_id, policy_id, plan_id, decision, matched_scope, correlation_id)
values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1', null,
        'escalated', '{"reason": "records above cap"}'::jsonb, gen_random_uuid());

select pg_temp.raises('23503',
  $q$insert into public.policy_evaluations(tenant_id, policy_id, decision, correlation_id)
    values ('00000000-0000-0000-0000-0000000000c1', gen_random_uuid(), 'within_policy', gen_random_uuid())$q$,
  'an evaluation names a real policy');

select pg_temp.raises('23514',
  $q$insert into public.standing_approval_policies(id, tenant_id, name, scope, created_by, approved_by, expires_at)
    values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000c1',
            'No action types', '{"max_records": 10}'::jsonb,
            '00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-0000000000a8',
            now() + interval '90 days')$q$,
  'a policy without an action_types scope cannot exist');

-- ─── Nobody writes these except the SECURITY DEFINER path ────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}';
select pg_temp.assert_true(
  (select count(*) >= 1 from public.monitoring_schedules
    where tenant_id = '00000000-0000-0000-0000-0000000000c1'),
  'a tenant member reads the schedules');
select pg_temp.denied($q$select public.register_monitoring_schedule(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1',
  'Browser-made', 'drift_check', '*/15 * * * *',
  now() + interval '1 hour', '00000000-0000-0000-0000-0000000000a9')$q$);
select pg_temp.denied($q$insert into public.drift_events(tenant_id, estate_id, kind, severity, summary)
  values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1',
          'system_added', 'low', 'x')$q$);
select pg_temp.denied($q$update public.monitoring_schedules set cadence = '0 0 0 0 0'$q$);
select pg_temp.denied($q$update public.standing_approval_policies set scope = '{}'::jsonb$q$);
reset role;

set local role service_role;
select pg_temp.assert_true(
  (select count(*) >= 1 from public.monitoring_schedules), 'the BFF service reads schedules');
select pg_temp.denied($q$update public.monitoring_schedules set status = 'paused'$q$);
select pg_temp.denied($q$delete from public.monitoring_schedules$q$);
select pg_temp.denied($q$delete from public.drift_events$q$);
select pg_temp.denied($q$update public.policy_evaluations set decision = 'within_policy'$q$);
reset role;

rollback;
