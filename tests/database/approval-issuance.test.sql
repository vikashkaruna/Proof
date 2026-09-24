-- W1 / 0026: issuing an approval is one transaction, or it is nothing.
--
-- The route did this in seven round trips, each committing on its own. The
-- assertions here are mostly about the states that are no longer reachable:
-- a token with no ledger entry, actions approved with no token, a token whose
-- challenge was never linked to it.
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

insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a9', 'approver@test.invalid');
insert into public.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a9', 'approver@test.invalid');
insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-0000000000c1', 'appr-a', 'Approval A');
insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-appr', now(), 'test', 'test', 0);
insert into public.engagements(id, tenant_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c1', 'test-appr', 'E');
insert into public.remediation_plans(id, tenant_id, engagement_id, library_version, title, status)
  values ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-0000000000c2', 'test-appr', 'Approval plan', 'review');

insert into public.remediation_actions(id, tenant_id, plan_id, sequence, action_type, description, risk_score, rollback_definition, parameters)
values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 1, 'data.mask', 'A', 10, '{"restore":"snap-1"}', '{"columns":["email"]}'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 2, 'data.mask', 'B', 10, '{"restore":"snap-2"}', '{"columns":["phone"]}');

update public.remediation_actions
   set dry_run_status = 'dry_run_complete', rollback_validated = true,
       dry_run_expires_at = now() + interval '1 hour',
       dry_run_result = jsonb_build_object('recordsAffected', 12);

insert into public.mfa_challenges(id, user_id, tenant_id, purpose, expires_at)
values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a9',
        '00000000-0000-0000-0000-0000000000c1', 'approval_issuance', now() + interval '10 minutes');

-- ─── The digest the database computes for itself ─────────────────────
-- Both ends of the comparison use this function, so they agree by
-- construction rather than by two languages canonicalising JSON the same way.
-- R-05 is what happens when that agreement is assumed.
create temporary table digest_snapshot as
select public.action_set_content_digest(
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
  array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[]) as d;

select pg_temp.assert_true((select d is not null and length(d) = 64 from digest_snapshot),
  'the content digest is a sha256 hex string');

-- Order of the id array must not change it: approving {A,B} and {B,A} is the
-- same act.
select pg_temp.assert_eq(
  public.action_set_content_digest('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    array['00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000d1']::uuid[]),
  (select d from digest_snapshot), 'the digest does not depend on the order of the id array');

-- ─── Refusals leave nothing behind ───────────────────────────────────
select pg_temp.assert_eq(
  public.issue_plan_approval(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    '{}'::uuid[], '00000000-0000-0000-0000-0000000000a9', 'batch', 1, true,
    'sig', '{}'::jsonb, 'nonce-empty', now() + interval '1 hour', null, '{}'::jsonb,
    null, (select d from digest_snapshot), null, gen_random_uuid())->>'decision',
  'invalid_actions', 'an empty action set approves nothing');

select pg_temp.assert_eq(
  public.issue_plan_approval(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c9',
    array['00000000-0000-0000-0000-0000000000d1']::uuid[], '00000000-0000-0000-0000-0000000000a9',
    'batch', 1, true, 'sig', '{}'::jsonb, 'nonce-noplan', now() + interval '1 hour', null, '{}'::jsonb,
    null, (select d from digest_snapshot), null, gen_random_uuid())->>'decision',
  'plan_not_found', 'a plan in another tenant is not approvable');

-- THE check this migration exists for alongside atomicity: content that moved
-- between the route's read and the write is refused under the row locks.
select pg_temp.assert_eq(
  public.issue_plan_approval(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
    '00000000-0000-0000-0000-0000000000a9', 'batch', 1, true,
    'sig', '{}'::jsonb, 'nonce-stale', now() + interval '1 hour', null, '{}'::jsonb,
    '00000000-0000-0000-0000-0000000000f1', 'not-the-digest-that-was-verified', null, gen_random_uuid())->>'decision',
  'content_changed', 'a digest that no longer matches refuses the approval');

select pg_temp.assert_true((select count(*) = 0 from public.approval_tokens),
  'no refusal persisted a token');

-- ─── A ledger outage rolls the whole issuance back ───────────────────
-- The serious state this migration removes: actions approved and a signed
-- token live, with no tamper-evident record of who granted it.
create function pg_temp.reject_approval_ledger() returns trigger language plpgsql as $$
begin
  if new.action_type = 'approval.token.issued' then raise exception 'test ledger unavailable'; end if;
  return new;
end $$;
create trigger fail_approval_ledger before insert on public.audit_ledger
  for each row execute function pg_temp.reject_approval_ledger();

do $$ begin
  perform public.issue_plan_approval(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
    '00000000-0000-0000-0000-0000000000a9', 'batch', 1, true,
    'sig-ledger', '{}'::jsonb, 'nonce-ledger', now() + interval '1 hour', null, '{}'::jsonb,
    '00000000-0000-0000-0000-0000000000f1',
    public.action_set_content_digest('00000000-0000-0000-0000-0000000000c1',
      '00000000-0000-0000-0000-0000000000c3',
      array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[]),
    jsonb_build_object('mfa', jsonb_build_object('challengeId', '00000000-0000-0000-0000-0000000000f1')),
    gen_random_uuid());
  raise exception 'ASSERTION FAILED: an approval was issued without a ledger entry';
exception when others then
  if sqlerrm <> 'test ledger unavailable' then raise; end if;
end $$;
drop trigger fail_approval_ledger on public.audit_ledger;

select pg_temp.assert_true((select count(*) = 0 from public.approval_tokens),
  'a ledger outage leaves no signed token behind');
select pg_temp.assert_true(
  (select count(*) = 0 from public.remediation_actions where approval_status = 'approved'),
  'a ledger outage leaves no action approved');
select pg_temp.assert_eq(
  (select status::text from public.remediation_plans where id = '00000000-0000-0000-0000-0000000000c3'),
  'review', 'a ledger outage leaves the plan where it was');
select pg_temp.assert_true(
  (select consumed_for is null from public.mfa_challenges where id = '00000000-0000-0000-0000-0000000000f1'),
  'a ledger outage leaves the challenge unlinked');

-- ─── The happy path, all of it or none of it ─────────────────────────
select pg_temp.assert_eq(
  public.issue_plan_approval(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
    '00000000-0000-0000-0000-0000000000a9', 'batch', 2, true,
    'sig-ok', jsonb_build_object('nonce','nonce-ok'), 'nonce-ok', now() + interval '1 hour',
    'quarterly remediation', '{}'::jsonb,
    '00000000-0000-0000-0000-0000000000f1', (select d from digest_snapshot),
    jsonb_build_object('mfa', jsonb_build_object(
      'challengeId', '00000000-0000-0000-0000-0000000000f1',
      'satisfiedAt', '2026-09-21T00:00:00Z', 'binding', 'binding-sha')),
    gen_random_uuid())->>'decision',
  'issued', 'a complete, eligible, unchanged approval is issued');

select pg_temp.assert_true((select count(*) = 1 from public.approval_tokens where status = 'issued'),
  'exactly one token exists');
select pg_temp.assert_true(
  (select count(*) = 2 from public.remediation_actions
    where approval_status = 'approved' and approved_by = '00000000-0000-0000-0000-0000000000a9'
      and approval_token_id = (select id from public.approval_tokens limit 1)),
  'both actions are approved and point at that token');
select pg_temp.assert_eq(
  (select status::text from public.remediation_plans where id = '00000000-0000-0000-0000-0000000000c3'),
  'approved', 'the plan moved with them');
select pg_temp.assert_true(
  (select consumed_for = (select id::text from public.approval_tokens limit 1)
     from public.mfa_challenges where id = '00000000-0000-0000-0000-0000000000f1'),
  'the challenge points at the token it authorised — the trail FR-7.3 needs');
select pg_temp.assert_true(
  (select count(*) = 1 from public.audit_ledger
    where action_type = 'approval.token.issued'
      and approval_token_id = (select id from public.approval_tokens limit 1)
      and detail->>'contentDigest' = (select d from digest_snapshot)
      and detail->'mfa'->>'binding' = 'binding-sha'),
  'the ledger records the token, the exact content, and the step-up that authorised it');

-- ─── Work already in flight is not approvable again ──────────────────
update public.remediation_actions set execution_status = 'executing'
 where id = '00000000-0000-0000-0000-0000000000d1';
select pg_temp.assert_eq(
  public.issue_plan_approval(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
    '00000000-0000-0000-0000-0000000000a9', 'batch', 1, true,
    'sig-2', '{}'::jsonb, 'nonce-2', now() + interval '1 hour', null, '{}'::jsonb,
    null, (select d from digest_snapshot), null, gen_random_uuid())->>'decision',
  'actions_in_flight', 'a second approval cannot be issued over running work');
update public.remediation_actions set execution_status = 'draft'
 where id = '00000000-0000-0000-0000-0000000000d1';

-- ─── A stale dry-run is refused under the lock ───────────────────────
update public.remediation_actions set dry_run_expires_at = now() - interval '1 minute';
select pg_temp.assert_eq(
  public.issue_plan_approval(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
    '00000000-0000-0000-0000-0000000000a9', 'batch', 1, true,
    'sig-3', '{}'::jsonb, 'nonce-3', now() + interval '1 hour', null, '{}'::jsonb,
    null, (select d from digest_snapshot), null, gen_random_uuid())->>'decision',
  'actions_not_ready', 'an expired dry-run is caught under the lock, not only in the route');

-- ─── Browser clients cannot issue approvals ──────────────────────────
set local role authenticated;
select pg_temp.denied($q$select public.issue_plan_approval('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c3',array['00000000-0000-0000-0000-0000000000d1']::uuid[],'00000000-0000-0000-0000-0000000000a9','batch',1,true,'s','{}'::jsonb,'n',now(),null,'{}'::jsonb,null,'d',null,gen_random_uuid())$q$);
select pg_temp.denied($q$select public.action_set_content_digest('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c3',array['00000000-0000-0000-0000-0000000000d1']::uuid[])$q$);
reset role;

rollback;
