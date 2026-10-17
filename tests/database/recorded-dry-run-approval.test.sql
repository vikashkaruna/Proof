-- Migration 0157: BR-2 is enforced against the recorded dry run.
--
-- What these assertions protect: an action whose inline cache says
-- "dry_run_complete" but which has no recorded successful run cannot be
-- approved (the 2026-10-17 Kosha finding); a recorded, fresh run for the
-- stored content plus a validated rollback can; each missing requirement is
-- named by its own code; the readiness answer says why a plan in a closed
-- status cannot be approved; the list summary counts recorded runs only and
-- carries the decision times; and RLS still decides which rows a member sees.

begin;

create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
create function pg_temp.assert_eq(actual text, expected text, message text) returns void language plpgsql as $$
begin if actual is distinct from expected then
  raise exception 'ASSERTION FAILED: % (expected %, got %)', message, expected, actual; end if; end $$;
create function pg_temp.raises_like(statement text, pattern text, message text) returns void language plpgsql as $$
begin
  execute statement;
  raise exception 'ASSERTION FAILED: % (no raise)', message;
exception when others then
  if sqlerrm like 'ASSERTION FAILED%' then raise; end if;
  if sqlerrm not like pattern then
    raise exception 'ASSERTION FAILED: % (got %)', message, sqlerrm;
  end if;
end $$;
create function pg_temp.blockers(p_action uuid) returns text language sql as $$
  select array_to_string(public.action_approval_blockers('00000000-0000-0000-0000-000000057c01', p_action), ',')
$$;

-- ─── Fixture ─────────────────────────────────────────────────────────
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-000000057a01', 'approver@test.invalid'),
  ('00000000-0000-0000-0000-000000057a02', 'outsider@test.invalid');
insert into public.users(id, email) values
  ('00000000-0000-0000-0000-000000057a01', 'approver@test.invalid'),
  ('00000000-0000-0000-0000-000000057a02', 'outsider@test.invalid');
insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-000000057c01', 'br2-a', 'BR2 A'),
  ('00000000-0000-0000-0000-000000057c09', 'br2-b', 'BR2 B');
insert into public.tenant_users(tenant_id, user_id, role) values
  ('00000000-0000-0000-0000-000000057c01', '00000000-0000-0000-0000-000000057a01', 'approver'),
  ('00000000-0000-0000-0000-000000057c09', '00000000-0000-0000-0000-000000057a02', 'owner');
insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-br2', now(), 'test', 'test', 0);
insert into public.engagements(id, tenant_id, library_version, title)
  values ('00000000-0000-0000-0000-000000057c02', '00000000-0000-0000-0000-000000057c01', 'test-br2', 'E');
insert into public.remediation_plans(id, tenant_id, engagement_id, library_version, title, status)
  values ('00000000-0000-0000-0000-000000057c03', '00000000-0000-0000-0000-000000057c01',
          '00000000-0000-0000-0000-000000057c02', 'test-br2', 'Review plan', 'review'),
         ('00000000-0000-0000-0000-000000057c04', '00000000-0000-0000-0000-000000057c01',
          '00000000-0000-0000-0000-000000057c02', 'test-br2', 'Closed plan', 'partial_failure');

-- d1: cache says complete, nothing recorded (the seeded "round 4" shape).
-- d2: recorded through record_dry_run below.
-- d3: recorded, then its parameters change.
-- d4: recorded, rollback never validated.
-- d5: recorded as refused.
insert into public.remediation_actions(id, tenant_id, plan_id, sequence, action_type, description, risk_score,
  parameters, rollback_definition, rollback_validated, dry_run_status, dry_run_result,
  dry_run_completed_at, dry_run_expires_at, approval_status)
select ('00000000-0000-0000-0000-000000057d0' || n)::uuid, '00000000-0000-0000-0000-000000057c01',
       '00000000-0000-0000-0000-000000057c03', n, 'data.mask', 'Action ' || n, 10,
       jsonb_build_object('columns', jsonb_build_array('email'), 'n', n),
       '{"strategy": "drop_masking_policy"}'::jsonb,
       n <> 4,
       case when n = 1 then 'dry_run_complete' else 'awaiting_dry_run' end::public.action_status,
       case when n = 1 then '{"safety_checks_passed": true}'::jsonb end,
       case when n = 1 then now() end,
       case when n = 1 then now() + interval '60 days' end,
       'awaiting_approval'
  from generate_series(1, 5) n;

insert into public.remediation_actions(id, tenant_id, plan_id, sequence, action_type, description, risk_score,
  parameters, rollback_definition, rollback_validated, approval_status, execution_status)
values ('00000000-0000-0000-0000-000000057d06', '00000000-0000-0000-0000-000000057c01',
        '00000000-0000-0000-0000-000000057c04', 1, 'data.mask', 'Executed', 10,
        '{"columns": ["email"]}', '{"strategy": "drop_masking_policy"}', true, 'approved', 'succeeded');

create function pg_temp.record(p_action uuid, p_status text) returns void language plpgsql as $$
declare a public.remediation_actions;
begin
  select * into a from public.remediation_actions where id = p_action;
  perform pg_temp.assert_true(public.record_dry_run(a.tenant_id, a.id, p_status,
    case when p_status = 'succeeded' then '{"changes": [{"field": "email", "before": "cleartext", "after": "masked"}]}'::jsonb end,
    case when p_status = 'succeeded' then null else 'action_type_not_simulable' end,
    'sudhaar', a.parameters, a.rollback_definition, gen_random_uuid()) ? 'dryRun', 'record_dry_run recorded ' || p_action);
end $$;
select pg_temp.record('00000000-0000-0000-0000-000000057d02', 'succeeded');
select pg_temp.record('00000000-0000-0000-0000-000000057d03', 'succeeded');
select pg_temp.record('00000000-0000-0000-0000-000000057d04', 'succeeded');
select pg_temp.record('00000000-0000-0000-0000-000000057d05', 'refused');
update public.remediation_actions set parameters = '{"columns": ["email", "phone"]}'
 where id = '00000000-0000-0000-0000-000000057d03';

-- ─── Each requirement is named by its own code ───────────────────────
select pg_temp.assert_eq(pg_temp.blockers('00000000-0000-0000-0000-000000057d01'),
  'no_recorded_dry_run', 'a cache-only "dry_run_complete" is not a recorded dry run');
select pg_temp.assert_eq(pg_temp.blockers('00000000-0000-0000-0000-000000057d02'),
  '', 'a recorded fresh success with a validated rollback has no blocker');
select pg_temp.assert_eq(pg_temp.blockers('00000000-0000-0000-0000-000000057d03'),
  'dry_run_content_changed', 'a run no longer answers for edited parameters');
select pg_temp.assert_eq(pg_temp.blockers('00000000-0000-0000-0000-000000057d04'),
  'rollback_not_validated', 'an unvalidated rollback is its own blocker');
select pg_temp.assert_eq(pg_temp.blockers('00000000-0000-0000-0000-000000057d05'),
  'dry_run_refused', 'a refused run is named');
select pg_temp.assert_eq(pg_temp.blockers('00000000-0000-0000-0000-000000057d06'),
  'already_executed,no_recorded_dry_run,dry_run_not_complete', 'executed work is not approvable');
select pg_temp.assert_eq(pg_temp.blockers(gen_random_uuid()), 'action_not_found', 'unknown action');

-- Expiry: the action's window and the run's window are both honoured.
update public.remediation_actions set dry_run_expires_at = now() - interval '1 minute'
 where id = '00000000-0000-0000-0000-000000057d02';
select pg_temp.assert_eq(pg_temp.blockers('00000000-0000-0000-0000-000000057d02'),
  'dry_run_expired', 'an expired cache window blocks');
update public.remediation_actions set dry_run_expires_at = now() + interval '1 hour'
 where id = '00000000-0000-0000-0000-000000057d02';
update public.dry_runs set expires_at = now() - interval '1 minute'
 where action_id = '00000000-0000-0000-0000-000000057d02';
select pg_temp.assert_eq(pg_temp.blockers('00000000-0000-0000-0000-000000057d02'),
  'dry_run_expired', 'an expired recorded run blocks even if the cache was extended');
update public.dry_runs set expires_at = now() + interval '1 hour'
 where action_id = '00000000-0000-0000-0000-000000057d02';

-- The display cache must equal the recorded diff.
update public.remediation_actions set dry_run_result = '{"changes": []}'
 where id = '00000000-0000-0000-0000-000000057d02';
select pg_temp.assert_eq(pg_temp.blockers('00000000-0000-0000-0000-000000057d02'),
  'dry_run_content_changed', 'a rewritten diff cache is not the diff the run recorded');
update public.remediation_actions ra set dry_run_result = d.diff from public.dry_runs d
 where ra.id = '00000000-0000-0000-0000-000000057d02' and d.id = ra.latest_dry_run_id;

-- ─── The trigger refuses approval while any blocker stands ───────────
insert into public.approval_tokens(id, tenant_id, plan_id, action_ids, approver_id, mode, signature,
  signed_payload, nonce, expires_at, status)
values ('00000000-0000-0000-0000-000000057e01', '00000000-0000-0000-0000-000000057c01',
        '00000000-0000-0000-0000-000000057c03', array['00000000-0000-0000-0000-000000057d01']::uuid[],
        '00000000-0000-0000-0000-000000057a01', 'batch', 'sig', '{}', 'nonce-br2-1', now() + interval '1 hour', 'issued'),
       ('00000000-0000-0000-0000-000000057e02', '00000000-0000-0000-0000-000000057c01',
        '00000000-0000-0000-0000-000000057c03', array['00000000-0000-0000-0000-000000057d02']::uuid[],
        '00000000-0000-0000-0000-000000057a01', 'batch', 'sig', '{}', 'nonce-br2-2', now() + interval '1 hour', 'issued');

select pg_temp.raises_like($$update public.remediation_actions set approval_status = 'approved',
    approval_token_id = '00000000-0000-0000-0000-000000057e01'
  where id = '00000000-0000-0000-0000-000000057d01'$$,
  'approval_requires_recorded_dry_run%', 'a cache-only dry run cannot be approved');
select pg_temp.assert_eq((select approval_status::text from public.remediation_actions
  where id = '00000000-0000-0000-0000-000000057d01'), 'awaiting_approval', 'the refused approval did not land');
select pg_temp.raises_like($$update public.remediation_actions set approval_status = 'approved'
  where id = '00000000-0000-0000-0000-000000057d03'$$,
  'approval_requires_recorded_dry_run%', 'edited content cannot be approved on the old run');
select pg_temp.raises_like($$update public.remediation_actions set approval_status = 'approved'
  where id = '00000000-0000-0000-0000-000000057d04'$$,
  'approval_requires_recorded_dry_run%', 'an unvalidated rollback cannot be approved');

update public.remediation_actions set approval_status = 'approved',
    approval_token_id = '00000000-0000-0000-0000-000000057e02'
  where id = '00000000-0000-0000-0000-000000057d02';
select pg_temp.assert_eq((select approval_status::text from public.remediation_actions
  where id = '00000000-0000-0000-0000-000000057d02'), 'approved', 'a fully ready action is approvable');

-- Re-approval under a new token is judged again, not grandfathered.
update public.dry_runs set expires_at = now() - interval '1 minute'
 where action_id = '00000000-0000-0000-0000-000000057d02';
select pg_temp.raises_like($$update public.remediation_actions
    set approval_token_id = '00000000-0000-0000-0000-000000057e01'
  where id = '00000000-0000-0000-0000-000000057d02'$$,
  'approval_requires_recorded_dry_run%', 'a re-approval needs a fresh run too');
-- Writes that do not grant approval are not the trigger's business.
update public.remediation_actions set description = 'Still approved'
 where id = '00000000-0000-0000-0000-000000057d02';
update public.dry_runs set expires_at = now() + interval '1 hour'
 where action_id = '00000000-0000-0000-0000-000000057d02';

-- ─── Plan readiness ──────────────────────────────────────────────────
select pg_temp.assert_eq(
  (select public.plan_approval_readiness('00000000-0000-0000-0000-000000057c01',
     '00000000-0000-0000-0000-000000057c04') ->> 'planApprovable'),
  'false', 'a partial_failure plan is not approvable');
select pg_temp.assert_eq(
  (select public.plan_approval_readiness('00000000-0000-0000-0000-000000057c01',
     '00000000-0000-0000-0000-000000057c03') ->> 'planApprovable'),
  'true', 'a review plan is approvable');
select pg_temp.assert_eq(
  (select string_agg(a ->> 'sequence' || ':' || (a ->> 'ready') || ':' || (a -> 'blockers')::text, ' ' order by (a ->> 'sequence')::int)
     from jsonb_array_elements(public.plan_approval_readiness('00000000-0000-0000-0000-000000057c01',
       '00000000-0000-0000-0000-000000057c03') -> 'actions') a),
  '1:false:["no_recorded_dry_run"] 2:true:[] 3:false:["dry_run_content_changed"] 4:false:["rollback_not_validated"] 5:false:["dry_run_refused"]',
  'per-action readiness, in sequence');
select pg_temp.assert_true(
  (select (a -> 'dryRun') = 'null'::jsonb from jsonb_array_elements(public.plan_approval_readiness(
     '00000000-0000-0000-0000-000000057c01', '00000000-0000-0000-0000-000000057c03') -> 'actions') a
    where a ->> 'sequence' = '1'),
  'the cache-only action reports no recorded run');
select pg_temp.assert_true(
  public.plan_approval_readiness('00000000-0000-0000-0000-000000057c09',
    '00000000-0000-0000-0000-000000057c03') is null,
  'readiness is tenant-bound');

-- ─── List summary ────────────────────────────────────────────────────
select public.append_ledger('00000000-0000-0000-0000-000000057c01', gen_random_uuid(), 'human',
  '00000000-0000-0000-0000-000000057a01', null, null, null, 'plan.rejected',
  '00000000-0000-0000-0000-000000057c04', null, null, null, null, null, null, 'success', '{}'::jsonb);
select pg_temp.assert_eq(
  (select concat_ws(',', action_count, approved_actions, ready_actions, recorded_dry_runs, succeeded_dry_runs,
                    refused_or_failed_dry_runs, unrecorded_dry_runs, expired_dry_runs, rollbacks_validated,
                    last_approved_at is not null, last_rejected_at is not null)
     from public.plan_decision_summaries('00000000-0000-0000-0000-000000057c01')
    where plan_id = '00000000-0000-0000-0000-000000057c03'),
  '5,1,1,4,3,1,1,0,4,t,f', 'review plan summary counts recorded runs only');
select pg_temp.assert_eq(
  (select concat_ws(',', action_count, unrecorded_dry_runs, last_approved_at is null, last_rejected_at is not null)
     from public.plan_decision_summaries('00000000-0000-0000-0000-000000057c01')
    where plan_id = '00000000-0000-0000-0000-000000057c04'),
  '1,1,t,t', 'closed plan summary carries the rejection time');

-- ─── RLS still decides what a member sees ────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-000000057a02", "role": "authenticated"}', true);
select pg_temp.assert_true(
  public.plan_approval_readiness('00000000-0000-0000-0000-000000057c01', '00000000-0000-0000-0000-000000057c03') is null,
  'another tenant''s member reads no readiness');
select pg_temp.assert_eq(
  (select count(*)::text from public.plan_decision_summaries('00000000-0000-0000-0000-000000057c01')),
  '0', 'another tenant''s member reads no summaries');
select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-000000057a01", "role": "authenticated"}', true);
select pg_temp.assert_eq(
  (select count(*)::text from public.plan_decision_summaries('00000000-0000-0000-0000-000000057c01')),
  '2', 'a member reads their tenant''s summaries');
select pg_temp.assert_eq(
  (select jsonb_array_length(public.plan_approval_readiness('00000000-0000-0000-0000-000000057c01',
     '00000000-0000-0000-0000-000000057c03') -> 'actions')::text),
  '5', 'a member reads their plan''s readiness');
reset role;

rollback;
