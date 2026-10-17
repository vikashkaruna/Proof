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
       dry_run_result = jsonb_build_object('changes', '[]'::jsonb, 'recordsAffected', 12);

insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted) values
 ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000a9','totp','active','fixture-only');
insert into public.mfa_challenges(id, user_id, tenant_id, purpose, expires_at)
values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a9',
        '00000000-0000-0000-0000-0000000000c1', 'approval_issuance', now() + interval '5 minutes');
update public.mfa_challenges set factor_id='00000000-0000-0000-0000-0000000000e1',
 bound_resource_ref='00000000-0000-0000-0000-0000000000c3',bound_payload_sha256=repeat('a',64),
 satisfied_at=clock_timestamp(),consumed_at=clock_timestamp(),consumed_for='00000000-0000-0000-0000-0000000000c3';

create function pg_temp.previous_digest(
  p_tenant_id uuid,
  p_plan_id uuid,
  p_action_ids uuid[]
) returns text language sql stable security definer set search_path = '' as $$
  select pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', a.id,
            'action_type', a.action_type,
            'parameters', a.parameters,
            'rollback_definition', a.rollback_definition,
            -- A set: ordering carries no meaning and must not change the hash.
            'closes_finding_ids', (
              select coalesce(jsonb_agg(f order by f), '[]'::jsonb)
              from unnest(a.closes_finding_ids) f
            ),
            -- The dry-run diff the approver read. A re-run producing a
            -- different simulated outcome is a different thing to have agreed
            -- to, even when the definition is untouched.
            'dry_run_result', a.dry_run_result
          )
          order by a.id
        ),
        '[]'::jsonb
      )::text,
      'UTF8')
    ),
    'hex'
  )
  from public.remediation_actions a
  where a.tenant_id = p_tenant_id and a.plan_id = p_plan_id and a.id = any(p_action_ids);
$$;


-- Preserve 0026 token digests exactly, including nested JSON and sorted sets.
update public.remediation_actions set parameters = '{"unicode":"नमस्ते", "null":null,"array":[2,1],"nested":{"b":2,"a":1}}',
 closes_finding_ids = array['00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001']::uuid[];

-- 0157: approval needs a recorded run for the stored content (these
-- parameters); the inline cache alone is not one. Recorded here exactly as record_dry_run would.
insert into public.dry_runs(tenant_id, action_id, plan_id, status, diff, renderable,
  parameters_hash, rollback_definition_hash, correlation_id, expires_at)
select tenant_id, id, plan_id, 'succeeded', '{"changes": [], "recordsAffected": 12}'::jsonb, true,
  encode(sha256(convert_to(parameters::text, 'UTF8')), 'hex'),
  encode(sha256(convert_to(rollback_definition::text, 'UTF8')), 'hex'),
  gen_random_uuid(), now() + interval '1 hour'
  from public.remediation_actions
 where tenant_id in ('00000000-0000-0000-0000-0000000000c1') and latest_dry_run_id is null and rollback_definition is not null;
update public.remediation_actions a set latest_dry_run_id = d.id, dry_run_result = d.diff
  from public.dry_runs d
 where d.tenant_id = a.tenant_id and d.action_id = a.id and a.latest_dry_run_id is null
   and a.tenant_id in ('00000000-0000-0000-0000-0000000000c1');
create temporary table reviewed_snapshot as select jsonb_agg(to_jsonb(a)) as actions,
 public.action_set_content_digest('00000000-0000-0000-0000-0000000000c1',
 '00000000-0000-0000-0000-0000000000c3', array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[]) as digest
 from public.remediation_actions a;
-- This temporary snapshot belongs only to this rollback-scoped test session.
-- Let the explicit API-role assertion read its fixture input, without granting
-- access to any production table, function, schema or credential.
grant select on reviewed_snapshot to service_role;
select pg_temp.assert_eq((select digest from reviewed_snapshot),
 pg_temp.previous_digest('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c3',
 array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[]),
 'existing signed digests survive the migration');
select pg_temp.assert_eq(public.reviewed_action_content_digest((select actions from reviewed_snapshot)),
 (select digest from reviewed_snapshot), 'reviewed rows and live rows use identical canonicalization');
create function pg_temp.issue_reviewed(v integer default 1,c uuid default '00000000-0000-0000-0000-0000000000f1') returns text language sql as $$
 select public.issue_reviewed_plan_approval(
 '00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c3',
 array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
 '00000000-0000-0000-0000-0000000000a9','batch',1,true,'sig',
 jsonb_build_object('contentDigest',(select digest from reviewed_snapshot)), gen_random_uuid()::text,
 now() + interval '1 hour',null,'{}',c,(select digest from reviewed_snapshot),
 jsonb_build_object('mfa',jsonb_build_object('challengeId',c,'satisfiedAt',(select satisfied_at from public.mfa_challenges where id=c),'binding',repeat('a',64))),gen_random_uuid(),v)->>'decision';
$$;
update public.remediation_actions set parameters = '{"edited":true}';
select pg_temp.assert_eq(pg_temp.issue_reviewed(), 'content_changed', 'old reviewed rows cannot approve new live content');
update public.remediation_actions a set parameters = s.value->'parameters'
 from jsonb_array_elements((select actions from reviewed_snapshot)) s where a.id = (s.value->>'id')::uuid;
update public.remediation_plans set version = 2;
select pg_temp.assert_eq(pg_temp.issue_reviewed(), 'plan_changed', 'revision is checked under lock');
select pg_temp.assert_eq(pg_temp.issue_reviewed(null), 'plan_changed', 'missing revision fails closed');
update public.remediation_plans set version = 1, status = 'executing';
select pg_temp.assert_eq(pg_temp.issue_reviewed(), 'plan_not_approvable', 'plan eligibility is checked under lock');
select pg_temp.assert_true((select count(*) = 0 from public.approval_tokens), 'refusals leave no token');
update public.remediation_plans set status = 'review';
set local role service_role;
select pg_temp.assert_eq(pg_temp.issue_reviewed(1,null),'fresh_mfa_required','API has no NULL-challenge bypass');
reset role;
insert into auth.users(id,email) values('00000000-0000-0000-0000-0000000000a8','other-approval@test.invalid');
insert into public.users(id,email) values('00000000-0000-0000-0000-0000000000a8','other-approval@test.invalid');
update public.mfa_challenges set user_id='00000000-0000-0000-0000-0000000000a8';
select pg_temp.assert_eq(pg_temp.issue_reviewed(),'fresh_mfa_required','a challenge belongs to its original actor');
update public.mfa_challenges set user_id='00000000-0000-0000-0000-0000000000a9';
-- Interactive authority must still refer to the original live factor.
update public.user_mfa_factors set status='revoked';
insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted) values
 ('00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000a9','totp','active','replacement-only');
select pg_temp.assert_eq(pg_temp.issue_reviewed(),'fresh_mfa_required','replacement enrollment cannot revive the old challenge');
update public.user_mfa_factors set status='revoked' where id='00000000-0000-0000-0000-0000000000e2';
update public.user_mfa_factors set status='active' where id='00000000-0000-0000-0000-0000000000e1';
update public.mfa_challenges set bound_payload_sha256=repeat('b',64);
select pg_temp.assert_eq(pg_temp.issue_reviewed(),'fresh_mfa_required','retained binding must match the reviewed MFA detail');
update public.mfa_challenges set bound_payload_sha256=repeat('a',64),purpose='login';
select pg_temp.assert_eq(pg_temp.issue_reviewed(),'fresh_mfa_required','login challenge is not approval authority');
update public.mfa_challenges set purpose='approval_issuance',consumed_for='already-linked-token';
select pg_temp.assert_eq(pg_temp.issue_reviewed(),'fresh_mfa_required','a linked challenge cannot issue another token');
update public.mfa_challenges set consumed_for='00000000-0000-0000-0000-0000000000c3',bound_resource_ref='different-plan';
select pg_temp.assert_eq(pg_temp.issue_reviewed(),'fresh_mfa_required','challenge resource must be the exact plan');
update public.mfa_challenges set bound_resource_ref='00000000-0000-0000-0000-0000000000c3',tenant_id=null;
select pg_temp.assert_eq(pg_temp.issue_reviewed(),'fresh_mfa_required','challenge tenant must be the named tenant');
update public.mfa_challenges set tenant_id='00000000-0000-0000-0000-0000000000c1';
select pg_temp.assert_true((select count(*)=0 from public.approval_tokens),'MFA refusals leave zero authority');
select pg_temp.assert_eq(pg_temp.issue_reviewed(), 'issued', 'unchanged review issues successfully');
select pg_temp.assert_true((select count(*) = 1 from public.audit_ledger where action_type='approval.token.issued'), 'issuance retains atomic ledger');
select pg_temp.assert_true(not has_function_privilege('service_role',
 'public.issue_plan_approval(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid)', 'execute'), 'API cannot bypass the reviewed entrypoint');
select pg_temp.assert_true(not has_function_privilege('authenticated',
 'public.issue_reviewed_plan_approval(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid,integer)', 'execute'), 'clients cannot issue approvals');
select pg_temp.assert_eq(pg_temp.issue_reviewed(),'fresh_mfa_required','success links the challenge and prevents repeated issuance');
update public.user_mfa_factors set status='revoked';
select pg_temp.assert_true((select count(*)=1 from public.approval_tokens where status='issued' and expires_at>clock_timestamp()),'factor retirement does not revoke already-issued token authority');
select pg_temp.assert_true(not has_function_privilege('service_role','controller_security.issue_reviewed_plan_approval_0130(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid,integer)','execute'),'API cannot bypass the human guard through owner helper');
select pg_temp.assert_true(not has_function_privilege('human_action_writer','public.issue_reviewed_plan_approval(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid,integer)','execute'),'no new human writer issuance grant');
-- UUID identity is case-insensitive in PG and accepted by the existing HTTP
-- schemas. Preserve exact bound payload hashes while accepting equivalent UUID
-- resource spelling; whitespace and other non-UUID text remain refusals.
update public.user_mfa_factors set status='active',revoked_at=null where id='00000000-0000-0000-0000-0000000000e1';
insert into public.mfa_challenges(id,user_id,tenant_id,factor_id,purpose,bound_resource_ref,bound_payload_sha256,expires_at,satisfied_at,consumed_at,consumed_for)
 values('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000a9','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000e1','approval_issuance',
 '00000000-0000-0000-0000-0000000000C3',repeat('a',64),clock_timestamp()+interval '5 minutes',clock_timestamp(),clock_timestamp(),'00000000-0000-0000-0000-0000000000C3');
update public.mfa_challenges set bound_resource_ref='00000000-0000-0000-0000-0000000000C3 ' where id='00000000-0000-0000-0000-0000000000f2';
select pg_temp.assert_eq(pg_temp.issue_reviewed(1,'00000000-0000-0000-0000-0000000000f2'),'fresh_mfa_required','resource whitespace is not normalized');
update public.mfa_challenges set bound_resource_ref='00000000-0000-0000-0000-0000000000C3',bound_payload_sha256=repeat('b',64) where id='00000000-0000-0000-0000-0000000000f2';
select pg_temp.assert_eq(pg_temp.issue_reviewed(1,'00000000-0000-0000-0000-0000000000f2'),'fresh_mfa_required','UUID case compatibility never changes the exact reviewed digest');
update public.mfa_challenges set bound_payload_sha256=repeat('a',64) where id='00000000-0000-0000-0000-0000000000f2';
select pg_temp.assert_eq(pg_temp.issue_reviewed(1,'00000000-0000-0000-0000-0000000000f2'),'issued','accepted uppercase UUID resource and consumption references still issue');
rollback;
