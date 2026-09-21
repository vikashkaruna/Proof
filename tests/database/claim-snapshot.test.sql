-- W1 / 0027: the claim enforces the snapshot the approver authorised.
--
-- `trg_actions_approved_immutable` (0004) freezes an approved action's type,
-- parameters, rollback definition and findings. It does NOT freeze
-- `dry_run_result`, and the simulated outcome is precisely what the approver
-- read before agreeing. The first assertions here establish that gap on the
-- live schema rather than asserting it from the trigger's source, because if
-- the trigger ever widens, this suite should say so.
begin;

create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
create function pg_temp.assert_eq(actual text, expected text, message text) returns void language plpgsql as $$
begin if actual is distinct from expected then
  raise exception 'ASSERTION FAILED: % (expected %, got %)', message, expected, actual; end if; end $$;

insert into auth.users(id, email) values ('00000000-0000-0000-0000-0000000000a9', 'a@test.invalid');
insert into public.users(id, email) values ('00000000-0000-0000-0000-0000000000a9', 'a@test.invalid');
insert into public.tenants(id, slug, name) values ('00000000-0000-0000-0000-0000000000c1', 'snap', 'Snap');
insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-snap', now(), 'test', 'test', 0);
insert into public.engagements(id, tenant_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c1', 'test-snap', 'E');
insert into public.remediation_plans(id, tenant_id, engagement_id, library_version, title, status)
  values ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-0000000000c2', 'test-snap', 'Snapshot plan', 'approved');

insert into public.remediation_actions(id, tenant_id, plan_id, sequence, action_type, description, risk_score, rollback_definition, parameters)
values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 1, 'data.mask', 'A', 10, '{"restore":"s1"}', '{"columns":["email"]}'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 2, 'data.mask', 'B', 10, '{"restore":"s2"}', '{"columns":["phone"]}');

update public.remediation_actions
   set approval_status = 'approved', dry_run_status = 'dry_run_complete',
       rollback_validated = true, dry_run_expires_at = now() + interval '1 hour',
       dry_run_result = jsonb_build_object('recordsAffected', 12);

-- Two tokens over the same actions: one carrying the snapshot, one not.
insert into public.approval_tokens(id, tenant_id, plan_id, action_ids, approver_id, mode, signature, signed_payload, nonce, expires_at, status)
values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
   array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
   '00000000-0000-0000-0000-0000000000a9', 'batch', 'sig-1', '{}'::jsonb, 'nonce-1', now() + interval '1 hour', 'issued'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
   array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
   '00000000-0000-0000-0000-0000000000a9', 'batch', 'sig-2', '{}'::jsonb, 'nonce-2', now() + interval '1 hour', 'issued');

update public.approval_tokens
   set signed_payload = jsonb_build_object('contentDigest',
         public.action_set_content_digest('00000000-0000-0000-0000-0000000000c1',
           '00000000-0000-0000-0000-0000000000c3',
           array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[]))
 where id = '00000000-0000-0000-0000-0000000000e1';

-- ─── What the immutability trigger does and does not cover ───────────
do $$ begin
  update public.remediation_actions set parameters = '{"columns":["aadhaar"]}'
   where id = '00000000-0000-0000-0000-0000000000d1';
  raise exception 'ASSERTION FAILED: parameters were mutable after approval';
exception when others then
  if position('immutable once approved' in sqlerrm) = 0 then raise; end if;
end $$;

-- And the one it misses. This is why 0027 exists: the approver agreed on the
-- strength of a simulated outcome that can be replaced afterwards.
update public.remediation_actions
   set dry_run_result = jsonb_build_object('recordsAffected', 4000000)
 where id = '00000000-0000-0000-0000-0000000000d1';
select pg_temp.assert_true(
  (select dry_run_result->>'recordsAffected' = '4000000' from public.remediation_actions
    where id = '00000000-0000-0000-0000-0000000000d1'),
  'dry_run_result is NOT frozen by the approval trigger — the gap 0027 closes');

-- ─── A claim against the changed diff is refused ─────────────────────
select pg_temp.assert_eq(
  public.claim_plan_execution(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    '00000000-0000-0000-0000-0000000000e1',
    array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
    'req-changed')->>'decision',
  'content_changed', 'a dry-run diff replaced after approval refuses the claim');

select pg_temp.assert_eq(
  (select status::text from public.approval_tokens where id = '00000000-0000-0000-0000-0000000000e1'),
  'issued', 'a refused claim does not spend the token');
select pg_temp.assert_true(
  (select count(*) = 0 from public.remediation_actions where execution_status = 'executing'),
  'a refused claim starts nothing');
select pg_temp.assert_true(
  (select count(*) = 0 from public.execution_dispatch_outbox),
  'a refused claim promises nothing');

-- ─── Restored content claims again ───────────────────────────────────
update public.remediation_actions
   set dry_run_result = jsonb_build_object('recordsAffected', 12)
 where id = '00000000-0000-0000-0000-0000000000d1';
select pg_temp.assert_eq(
  public.claim_plan_execution(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    '00000000-0000-0000-0000-0000000000e1',
    array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
    'req-ok')->>'decision',
  'claimed', 'the content the token approved claims normally');

-- The runtime is told which snapshot it was dispatched for.
select pg_temp.assert_true(
  (select payload->>'content_digest' = (select signed_payload->>'contentDigest'
     from public.approval_tokens where id = '00000000-0000-0000-0000-0000000000e1')
     from public.execution_dispatch_outbox where request_key = 'req-ok'),
  'the dispatch intent carries the snapshot it was authorised for');

-- ─── A token that names only rows authorises nothing ─────────────────
update public.remediation_actions
   set execution_status = 'draft', execution_request_key = null, dispatch_status = null;
select pg_temp.assert_eq(
  public.claim_plan_execution(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    '00000000-0000-0000-0000-0000000000e2',
    array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
    'req-nodigest')->>'decision',
  'token_without_snapshot', 'a token carrying no snapshot cannot claim');
select pg_temp.assert_eq(
  (select status::text from public.approval_tokens where id = '00000000-0000-0000-0000-0000000000e2'),
  'issued', 'the refusal leaves that token issued too');

-- An empty string is not a snapshot either.
update public.approval_tokens set signed_payload = jsonb_build_object('contentDigest', '')
 where id = '00000000-0000-0000-0000-0000000000e2';
select pg_temp.assert_eq(
  public.claim_plan_execution(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
    '00000000-0000-0000-0000-0000000000e2',
    array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
    'req-empty')->>'decision',
  'token_without_snapshot', 'an empty digest is not a snapshot');

-- ─── The caller cannot name its own expectation ──────────────────────
-- The digest is read from the token row, so a caller that would like a
-- different answer has nowhere to put one: `claim_plan_execution` takes no
-- digest parameter at all.
select pg_temp.assert_true(
  (select count(*) = 0 from information_schema.parameters
    where specific_schema = 'public'
      and specific_name in (select specific_name from information_schema.routines
                            where routine_schema = 'public' and routine_name = 'claim_plan_execution')
      and parameter_name ilike '%digest%'),
  'the claim accepts no digest from its caller');

rollback;
