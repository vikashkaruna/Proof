-- W6.2 · M4.1 / migration 0068: the standing-policy engine.
--
-- A standing policy is pre-human-approved authority, which makes it the most
-- dangerous row in the database if it is wrong. What these assertions
-- protect: a policy cannot exist without two different humans behind it; a
-- lapsed policy retires itself instead of lingering active; a scope miss or
-- an oversize batch escalates (and the escalation is ledgered); and a
-- within-scope request is issued through the SAME gate as an interactive
-- approval — plan version, dry-run/rollback freshness, digest, atomic ledger
-- — with the policy's named approver on the token. The gate refusing for an
-- operational reason (stale dry-run, drifted content) records no evaluation
-- and mints no token, and no role but the SECURITY DEFINER path writes any
-- of it.

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
  ('00000000-0000-0000-0000-0000000000a1', 'author@test.invalid'),
  ('00000000-0000-0000-0000-0000000000a2', 'approver@test.invalid');
insert into public.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'author@test.invalid'),
  ('00000000-0000-0000-0000-0000000000a2', 'approver@test.invalid');
insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-0000000000c1', 'sp-a', 'Standing A'),
  ('00000000-0000-0000-0000-0000000000c9', 'sp-b', 'Standing B');
insert into public.tenant_users(tenant_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'owner');
insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-sp', now(), 'test', 'test', 0);
insert into public.engagements(id, tenant_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c1', 'test-sp', 'E');
insert into public.remediation_plans(id, tenant_id, engagement_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-0000000000c2', 'test-sp', 'Standing plan'),
         ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-0000000000c2', 'test-sp', 'Fresh plan');
insert into public.remediation_actions(id, tenant_id, plan_id, sequence, action_type, description, risk_score, parameters, rollback_definition)
values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 1,
   'data.mask', 'Mask contact fields', 10,
   '{"system": "crm", "fields": ["phone", "email"]}'::jsonb,
   '{"steps": [{"op": "restore_from_backup"}]}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 2,
   'data.mask', 'Mask salary fields', 10,
   '{"system": "hr", "fields": ["salary"]}'::jsonb,
   '{"steps": [{"op": "restore_from_backup"}]}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 3,
   'data.delete', 'Delete expired records', 10,
   '{"system": "crm", "older_than_days": 365}'::jsonb,
   '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 4,
   'data.mask', 'Mask third system', 10,
   '{"system": "billing", "fields": ["card"]}'::jsonb,
   '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000000d6', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c5', 1,
   'data.mask', 'Not yet simulated', 10,
   '{"system": "crm", "fields": ["phone"]}'::jsonb,
   '{"steps": [{"op": "restore_from_backup"}]}'::jsonb);

-- ─── Creation: dual control and scope shape ──────────────────────────
select pg_temp.assert_eq(
  (select public.create_standing_policy(
     '00000000-0000-0000-0000-0000000000c1', 'Small masking batch',
     '{"action_types": ["data.mask"], "max_actions": 2}'::jsonb,
     now() + interval '30 days',
     '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
     gen_random_uuid()) -> 'policy' ->> 'status'),
  'active', 'a dual-controlled policy is created active');

select pg_temp.assert_eq(
  (select public.create_standing_policy(
     '00000000-0000-0000-0000-0000000000c1', 'Self-approved',
     '{"action_types": ["data.mask"]}'::jsonb,
     now() + interval '30 days',
     '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1',
     gen_random_uuid()) ->> 'error'),
  'dual_control_required', 'the author and the approver must be different people');

select pg_temp.assert_eq(
  (select public.create_standing_policy(
     '00000000-0000-0000-0000-0000000000c1', 'Ghost approver',
     '{"action_types": ["data.mask"]}'::jsonb,
     now() + interval '30 days',
     '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a9',
     gen_random_uuid()) ->> 'error'),
  'approver_not_found', 'the approving human must exist');

select pg_temp.assert_eq(
  (select public.create_standing_policy(
     '00000000-0000-0000-0000-0000000000c1', 'Eternal delegation',
     '{"action_types": ["data.mask"]}'::jsonb,
     now() + interval '400 days',
     '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
     gen_random_uuid()) ->> 'error'),
  'invalid_request', 'a standing delegation expires within a year');

select pg_temp.assert_eq(
  (select public.create_standing_policy(
     '00000000-0000-0000-0000-0000000000c1', 'Vague scope',
     '{"action_types": []}'::jsonb,
     now() + interval '30 days',
     '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
     gen_random_uuid()) ->> 'error'),
  'invalid_request', 'an empty scope approves nothing');

select pg_temp.assert_eq(
  (select public.create_standing_policy(
     '00000000-0000-0000-0000-0000000000c1', 'Foreign key',
     '{"action_types": ["data.mask"], "max_records": 100}'::jsonb,
     now() + interval '30 days',
     '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
     gen_random_uuid()) ->> 'error'),
  'invalid_request', 'a scope key the engine does not read is refused, not ignored');

select pg_temp.assert_eq(
  (select public.create_standing_policy(
     '00000000-0000-0000-0000-0000000000c1', 'Zero cap',
     '{"action_types": ["data.mask"], "max_actions": 0}'::jsonb,
     now() + interval '30 days',
     '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
     gen_random_uuid()) ->> 'error'),
  'invalid_request', 'a zero action cap is not a cap');

select pg_temp.assert_true(
  (select count(*) = 1 from public.audit_ledger
    where action_type = 'monitoring.policy.registered'
      and actor_id = '00000000-0000-0000-0000-0000000000a1'),
  'the registration is ledgered against its author');

-- ─── Within policy: the gate runs, the approver is the policy's ──────
do $$
declare
  v_policy uuid;
  v_digest text;
  v_issued jsonb;
begin
  select id into v_policy from public.standing_approval_policies
    where name = 'Small masking batch';

  perform public.record_dry_run(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
    'succeeded',
    '{"renderable": true, "changes": [{"field": "phone", "before": "value_as_stored", "after": "masked"}]}'::jsonb,
    null, 'sudhaar',
    '{"system": "crm", "fields": ["phone", "email"]}'::jsonb,
    '{"steps": [{"op": "restore_from_backup"}]}'::jsonb, gen_random_uuid());
  perform public.record_dry_run(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2',
    'succeeded',
    '{"renderable": true, "changes": [{"field": "salary", "before": "value_as_stored", "after": "masked"}]}'::jsonb,
    null, 'sudhaar',
    '{"system": "hr", "fields": ["salary"]}'::jsonb,
    '{"steps": [{"op": "restore_from_backup"}]}'::jsonb, gen_random_uuid());
  update public.remediation_actions
     set rollback_validated = true
   where id in ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2');

  v_digest := public.action_set_content_digest(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    array['00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2']::uuid[]);

  v_issued := public.evaluate_standing_policy(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    array['00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2']::uuid[],
    v_policy, 'batch', 3, true,
    'test-signature',
    jsonb_build_object('contentDigest', v_digest, 'nonce', 'nonce-sp-1'),
    'nonce-sp-1', now() + interval '1 hour',
    v_digest,
    (select version from public.remediation_plans where id = '00000000-0000-0000-0000-0000000000c3'),
    '00000000-0000-0000-0000-0000000000b1');

  if v_issued ->> 'decision' is distinct from 'issued' then
    raise exception 'ASSERTION FAILED: an in-scope batch is issued (got %)', v_issued ->> 'decision';
  end if;

  if (select approver_id from public.approval_tokens
       where id = (v_issued ->> 'token_id')::uuid)
     is distinct from '00000000-0000-0000-0000-0000000000a2' then
    raise exception 'ASSERTION FAILED: the token names the policy''s approver';
  end if;

  if (select conditions ->> 'standing_policy_id' from public.approval_tokens
       where id = (v_issued ->> 'token_id')::uuid)
     is distinct from v_policy::text then
    raise exception 'ASSERTION FAILED: the token records the policy that authorised it';
  end if;

  if (select approval_status from public.remediation_actions
       where id = '00000000-0000-0000-0000-0000000000d1') is distinct from 'approved'
     or (select status from public.remediation_plans
          where id = '00000000-0000-0000-0000-0000000000c3') is distinct from 'approved' then
    raise exception 'ASSERTION FAILED: the issuance moved the actions and the plan';
  end if;

  if (select decision from public.policy_evaluations
       where correlation_id = '00000000-0000-0000-0000-0000000000b1') is distinct from 'within_policy' then
    raise exception 'ASSERTION FAILED: the within-scope decision is recorded';
  end if;

  if (select count(*) from public.audit_ledger
       where action_type = 'monitoring.policy.within_policy'
         and correlation_id = '00000000-0000-0000-0000-0000000000b1') <> 1
     or (select count(*) from public.audit_ledger
          where action_type = 'approval.token.issued'
            and correlation_id = '00000000-0000-0000-0000-0000000000b1'
            and actor_id = '00000000-0000-0000-0000-0000000000a2') <> 1 then
    raise exception 'ASSERTION FAILED: both the policy decision and the issuance are ledgered';
  end if;
end $$;

-- ─── Escalation: a type outside the scope, or a batch over the cap ───
do $$
declare
  v_policy uuid;
  v_out jsonb;
begin
  select id into v_policy from public.standing_approval_policies
    where name = 'Small masking batch';

  v_out := public.evaluate_standing_policy(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    array['00000000-0000-0000-0000-0000000000d3']::uuid[],
    v_policy, 'batch', 3, true,
    'test-signature', '{"contentDigest": "x"}'::jsonb, 'nonce-sp-esc',
    now() + interval '1 hour', 'x',
    (select version from public.remediation_plans where id = '00000000-0000-0000-0000-0000000000c3'),
    '00000000-0000-0000-0000-0000000000b2');
  if v_out ->> 'decision' is distinct from 'escalated' then
    raise exception 'ASSERTION FAILED: an out-of-scope type escalates (got %)', v_out ->> 'decision';
  end if;
  if v_out -> 'uncovered_action_types' is distinct from '["data.delete"]'::jsonb then
    raise exception 'ASSERTION FAILED: the escalation names the uncovered type';
  end if;

  v_out := public.evaluate_standing_policy(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    array['00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2',
          '00000000-0000-0000-0000-0000000000d4']::uuid[],
    v_policy, 'batch', 3, true,
    'test-signature', '{"contentDigest": "x"}'::jsonb, 'nonce-sp-cap',
    now() + interval '1 hour', 'x',
    (select version from public.remediation_plans where id = '00000000-0000-0000-0000-0000000000c3'),
    '00000000-0000-0000-0000-0000000000b3');
  if v_out ->> 'decision' is distinct from 'escalated' then
    raise exception 'ASSERTION FAILED: a batch over the action cap escalates (got %)', v_out ->> 'decision';
  end if;

  if (select count(*) from public.policy_evaluations
       where correlation_id in ('00000000-0000-0000-0000-0000000000b2',
                                '00000000-0000-0000-0000-0000000000b3')
         and decision = 'escalated') <> 2 then
    raise exception 'ASSERTION FAILED: both escalations are recorded';
  end if;
  if (select count(*) from public.audit_ledger
       where action_type = 'monitoring.policy.escalated'
         and correlation_id in ('00000000-0000-0000-0000-0000000000b2',
                                '00000000-0000-0000-0000-0000000000b3')) <> 2 then
    raise exception 'ASSERTION FAILED: escalations are ledgered — a human must look';
  end if;
end $$;

-- ─── Expiry and revocation: a dead policy answers, then retires ──────
select pg_temp.assert_eq(
  (select public.create_standing_policy(
     '00000000-0000-0000-0000-0000000000c1', 'Dying delegation',
     '{"action_types": ["data.mask"]}'::jsonb,
     now() + interval '1 second',
     '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
     gen_random_uuid()) -> 'policy' ->> 'status'),
  'active', 'the dying policy starts active');
select pg_sleep(1.2);

do $$
declare
  v_dying uuid; v_revoked uuid; v_out jsonb;
begin
  select id into v_dying from public.standing_approval_policies where name = 'Dying delegation';
  v_out := public.evaluate_standing_policy(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    array['00000000-0000-0000-0000-0000000000d3']::uuid[],
    v_dying, 'batch', 3, true,
    'test-signature', '{"contentDigest": "x"}'::jsonb, 'nonce-sp-exp',
    now() + interval '1 hour', 'x', 1,
    '00000000-0000-0000-0000-0000000000b4');
  if v_out ->> 'decision' is distinct from 'policy_expired' then
    raise exception 'ASSERTION FAILED: a lapsed policy refuses (got %)', v_out ->> 'decision';
  end if;
  if (select status from public.standing_approval_policies where id = v_dying)
     is distinct from 'expired' then
    raise exception 'ASSERTION FAILED: a lapsed policy retires itself';
  end if;
  if (select decision from public.policy_evaluations
       where correlation_id = '00000000-0000-0000-0000-0000000000b4') is distinct from 'expired' then
    raise exception 'ASSERTION FAILED: the expiry is recorded as an evaluation';
  end if;

  select id into v_revoked from public.standing_approval_policies where name = 'Small masking batch';
  v_out := public.revoke_standing_policy(
    '00000000-0000-0000-0000-0000000000c1', v_revoked,
    '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b5');
  if v_out -> 'policy' ->> 'status' is distinct from 'revoked' then
    raise exception 'ASSERTION FAILED: revocation lands (got %)', v_out ->> 'error';
  end if;
  if (select count(*) from public.audit_ledger
       where action_type = 'monitoring.policy.revoked'
         and correlation_id = '00000000-0000-0000-0000-0000000000b5') <> 1 then
    raise exception 'ASSERTION FAILED: the revocation is ledgered';
  end if;

  v_out := public.evaluate_standing_policy(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    array['00000000-0000-0000-0000-0000000000d3']::uuid[],
    v_revoked, 'batch', 3, true,
    'test-signature', '{"contentDigest": "x"}'::jsonb, 'nonce-sp-rev',
    now() + interval '1 hour', 'x', 1,
    '00000000-0000-0000-0000-0000000000b6');
  if v_out ->> 'decision' is distinct from 'policy_revoked' then
    raise exception 'ASSERTION FAILED: a revoked policy refuses (got %)', v_out ->> 'decision';
  end if;
  if (select decision from public.policy_evaluations
       where correlation_id = '00000000-0000-0000-0000-0000000000b6') is distinct from 'revoked' then
    raise exception 'ASSERTION FAILED: the refusal of a revoked policy is recorded';
  end if;
end $$;

select pg_temp.assert_eq(
  (select public.revoke_standing_policy(
     '00000000-0000-0000-0000-0000000000c1',
     (select id from public.standing_approval_policies where name = 'Small masking batch'),
     '00000000-0000-0000-0000-0000000000a2', gen_random_uuid()) ->> 'error'),
  'policy_not_active', 'a policy revokes once');

-- ─── The gate still refuses: another tenant, no dry-run, drift, version ──
do $$
declare v_other uuid; v_out jsonb;
begin
  -- Cross-tenant: a policy of another tenant is not a policy at all.
  select (public.create_standing_policy(
      '00000000-0000-0000-0000-0000000000c9', 'Other tenant',
      '{"action_types": ["data.mask"]}'::jsonb, now() + interval '30 days',
      '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a1',
      gen_random_uuid()) -> 'policy' ->> 'id')::uuid
    into v_other;
  v_out := public.evaluate_standing_policy(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    array['00000000-0000-0000-0000-0000000000d1']::uuid[],
    v_other,
    'batch', 3, true, 'test-signature', '{"contentDigest": "x"}'::jsonb, 'nonce-sp-x',
    now() + interval '1 hour', 'x', 1, gen_random_uuid());
  if v_out ->> 'decision' is distinct from 'policy_not_found' then
    raise exception 'ASSERTION FAILED: another tenant''s policy is not found (got %)', v_out ->> 'decision';
  end if;
end $$;

do $$
declare
  v_policy uuid; v_digest text; v_version integer; v_out jsonb;
begin
  -- The main policy was revoked above; create a live one for the gate tests.
  v_policy := (public.create_standing_policy(
      '00000000-0000-0000-0000-0000000000c1', 'Gate test policy',
      '{"action_types": ["data.mask"]}'::jsonb, now() + interval '30 days',
      '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
      gen_random_uuid()) -> 'policy' ->> 'id')::uuid;

  v_version := (select p.version from public.remediation_plans p
                 where p.id = '00000000-0000-0000-0000-0000000000c5');

  -- A stale dry-run: the policy path refuses exactly like the approve route.
  v_digest := public.action_set_content_digest(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c5',
    array['00000000-0000-0000-0000-0000000000d6']::uuid[]);
  v_out := public.evaluate_standing_policy(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c5',
    array['00000000-0000-0000-0000-0000000000d6']::uuid[],
    v_policy, 'batch', 3, true,
    'test-signature',
    jsonb_build_object('contentDigest', v_digest, 'nonce', 'nonce-sp-nr'),
    'nonce-sp-nr', now() + interval '1 hour', v_digest, v_version,
    '00000000-0000-0000-0000-0000000000b7');
  if v_out ->> 'decision' is distinct from 'actions_not_ready' then
    raise exception 'ASSERTION FAILED: an unsimulated action is not policy-approvable (got %)', v_out ->> 'decision';
  end if;
  if (select count(*) from public.policy_evaluations
       where correlation_id = '00000000-0000-0000-0000-0000000000b7') <> 0 then
    raise exception 'ASSERTION FAILED: a gate refusal records no evaluation';
  end if;
  if (select count(*) from public.approval_tokens
       where plan_id = '00000000-0000-0000-0000-0000000000c5') <> 0 then
    raise exception 'ASSERTION FAILED: a gate refusal mints no token';
  end if;

  -- Make the action eligible, then drift the digest.
  perform public.record_dry_run(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d6',
    'succeeded',
    '{"renderable": true, "changes": [{"field": "phone", "before": "value_as_stored", "after": "masked"}]}'::jsonb,
    null, 'sudhaar',
    '{"system": "crm", "fields": ["phone"]}'::jsonb,
    '{"steps": [{"op": "restore_from_backup"}]}'::jsonb, gen_random_uuid());
  update public.remediation_actions
     set rollback_validated = true
   where id = '00000000-0000-0000-0000-0000000000d6';

  v_out := public.evaluate_standing_policy(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c5',
    array['00000000-0000-0000-0000-0000000000d6']::uuid[],
    v_policy, 'batch', 3, true,
    'test-signature',
    jsonb_build_object('contentDigest', v_digest, 'nonce', 'nonce-sp-dg'),
    'nonce-sp-dg', now() + interval '1 hour', v_digest, v_version,
    '00000000-0000-0000-0000-0000000000b8');
  if v_out ->> 'decision' is distinct from 'content_changed' then
    raise exception 'ASSERTION FAILED: a digest the DB recomputes differently is refused (got %)', v_out ->> 'decision';
  end if;

  v_digest := public.action_set_content_digest(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c5',
    array['00000000-0000-0000-0000-0000000000d6']::uuid[]);
  v_out := public.evaluate_standing_policy(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c5',
    array['00000000-0000-0000-0000-0000000000d6']::uuid[],
    v_policy, 'batch', 3, true,
    'test-signature',
    jsonb_build_object('contentDigest', v_digest, 'nonce', 'nonce-sp-pv'),
    'nonce-sp-pv', now() + interval '1 hour', v_digest, v_version + 1,
    '00000000-0000-0000-0000-0000000000b9');
  if v_out ->> 'decision' is distinct from 'plan_changed' then
    raise exception 'ASSERTION FAILED: a stale plan version is refused (got %)', v_out ->> 'decision';
  end if;
end $$;

-- Shape refusals before any lock: empty, null-laden and duplicated ids.
select pg_temp.assert_eq(
  (select public.evaluate_standing_policy(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c5',
     array[]::uuid[], '00000000-0000-0000-0000-0000000000e9', 'batch', 3, true,
     's', '{}'::jsonb, 'n', now() + interval '1 hour', 'x', 1, gen_random_uuid())
   ->> 'decision'),
  'invalid_actions', 'an empty request evaluates nothing');

select pg_temp.assert_eq(
  (select public.evaluate_standing_policy(
     '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c5',
     array['00000000-0000-0000-0000-0000000000d6', '00000000-0000-0000-0000-0000000000d6']::uuid[],
     '00000000-0000-0000-0000-0000000000e9', 'batch', 3, true,
     's', '{}'::jsonb, 'n', now() + interval '1 hour', 'x', 1, gen_random_uuid())
   ->> 'decision'),
  'invalid_actions', 'a duplicated id is a malformed request');

-- ─── Nobody writes these except the SECURITY DEFINER paths ───────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select pg_temp.assert_true(
  (select count(*) >= 1 from public.standing_approval_policies
    where tenant_id = '00000000-0000-0000-0000-0000000000c1'),
  'a tenant member reads the policies');
select pg_temp.assert_true(
  (select count(*) = 0 from public.standing_approval_policies
    where tenant_id = '00000000-0000-0000-0000-0000000000c9'),
  'a member of one tenant reads none of another''s');
select pg_temp.denied($q$select public.evaluate_standing_policy(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c5',
  array['00000000-0000-0000-0000-0000000000d6']::uuid[], gen_random_uuid(),
  'batch', 3, true, 's', '{}'::jsonb, 'n', now() + interval '1 hour', 'x', 1,
  gen_random_uuid())$q$);
select pg_temp.denied($q$select public.create_standing_policy(
  '00000000-0000-0000-0000-0000000000c1', 'Browser-made',
  '{"action_types": ["data.mask"]}'::jsonb, now() + interval '30 days',
  '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
  gen_random_uuid())$q$);
select pg_temp.denied($q$update public.standing_approval_policies set scope = '{}'::jsonb$q$);
select pg_temp.denied($q$insert into public.policy_evaluations(tenant_id, policy_id, decision, correlation_id)
  values ('00000000-0000-0000-0000-0000000000c1', gen_random_uuid(), 'within_policy', gen_random_uuid())$q$);
reset role;

set local role service_role;
select pg_temp.denied($q$insert into public.standing_approval_policies(
  tenant_id, name, scope, created_by, approved_by, expires_at)
  values ('00000000-0000-0000-0000-0000000000c1', 'Direct', '{"action_types": ["data.mask"]}'::jsonb,
          '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
          now() + interval '30 days')$q$);
select pg_temp.denied($q$update public.standing_approval_policies set status = 'revoked'$q$);
select pg_temp.denied($q$delete from public.policy_evaluations$q$);
-- execute stays with the BFF service role:
select pg_temp.assert_eq(
  (select public.create_standing_policy(
     '00000000-0000-0000-0000-0000000000c1', 'Nope',
     '{"action_types": []}'::jsonb, now() + interval '30 days',
     '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
     gen_random_uuid()) ->> 'error'),
  'invalid_request', 'the BFF service role can call the write path');
reset role;

rollback;
