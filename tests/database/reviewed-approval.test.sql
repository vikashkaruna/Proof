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
create temporary table reviewed_snapshot as select jsonb_agg(to_jsonb(a)) as actions,
 public.action_set_content_digest('00000000-0000-0000-0000-0000000000c1',
 '00000000-0000-0000-0000-0000000000c3', array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[]) as digest
 from public.remediation_actions a;
select pg_temp.assert_eq((select digest from reviewed_snapshot),
 pg_temp.previous_digest('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c3',
 array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[]),
 'existing signed digests survive the migration');
select pg_temp.assert_eq(public.reviewed_action_content_digest((select actions from reviewed_snapshot)),
 (select digest from reviewed_snapshot), 'reviewed rows and live rows use identical canonicalization');
create function pg_temp.issue_reviewed(v integer default 1) returns text language sql as $$
 select public.issue_reviewed_plan_approval(
 '00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c3',
 array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
 '00000000-0000-0000-0000-0000000000a9','batch',1,true,'sig',
 jsonb_build_object('contentDigest',(select digest from reviewed_snapshot)), gen_random_uuid()::text,
 now() + interval '1 hour',null,'{}',null,(select digest from reviewed_snapshot),null,gen_random_uuid(),v)->>'decision';
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
select pg_temp.assert_eq(pg_temp.issue_reviewed(), 'issued', 'unchanged review issues successfully');
select pg_temp.assert_true((select count(*) = 1 from public.audit_ledger where action_type='approval.token.issued'), 'issuance retains atomic ledger');
select pg_temp.assert_true(not has_function_privilege('service_role',
 'public.issue_plan_approval(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid)', 'execute'), 'API cannot bypass the reviewed entrypoint');
select pg_temp.assert_true(not has_function_privilege('authenticated',
 'public.issue_reviewed_plan_approval(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid,integer)', 'execute'), 'clients cannot issue approvals');
rollback;
