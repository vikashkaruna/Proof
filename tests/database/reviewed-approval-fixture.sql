insert into auth.users(id, email) values
  ('10000000-0000-0000-0000-0000000000a9', 'reviewed-race@test.invalid');
insert into public.users(id, email) values
  ('10000000-0000-0000-0000-0000000000a9', 'reviewed-race@test.invalid');
insert into public.tenants(id, slug, name) values
  ('10000000-0000-0000-0000-0000000000c1', 'appr-a', 'Approval A');
insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-appr', now(), 'test', 'test', 0);
insert into public.engagements(id, tenant_id, library_version, title)
  values ('10000000-0000-0000-0000-0000000000c2', '10000000-0000-0000-0000-0000000000c1', 'test-appr', 'E');
insert into public.remediation_plans(id, tenant_id, engagement_id, library_version, title, status)
  values ('10000000-0000-0000-0000-0000000000c3', '10000000-0000-0000-0000-0000000000c1',
          '10000000-0000-0000-0000-0000000000c2', 'test-appr', 'Approval plan', 'review');

insert into public.remediation_actions(id, tenant_id, plan_id, sequence, action_type, description, risk_score, rollback_definition, parameters)
values
  ('10000000-0000-0000-0000-0000000000d1', '10000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c3', 1, 'data.mask', 'A', 10, '{"restore":"snap-1"}', '{"columns":["email"]}'),
  ('10000000-0000-0000-0000-0000000000d2', '10000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c3', 2, 'data.mask', 'B', 10, '{"restore":"snap-2"}', '{"columns":["phone"]}');

-- 0157: approval needs a recorded run for the stored content; the inline
-- cache alone is not one. Recorded here exactly as record_dry_run would.
insert into public.dry_runs(tenant_id, action_id, plan_id, status, diff, renderable,
  parameters_hash, rollback_definition_hash, correlation_id, expires_at)
select tenant_id, id, plan_id, 'succeeded', '{"changes": [], "recordsAffected": 12}'::jsonb, true,
  encode(sha256(convert_to(parameters::text, 'UTF8')), 'hex'),
  encode(sha256(convert_to(rollback_definition::text, 'UTF8')), 'hex'),
  gen_random_uuid(), now() + interval '1 hour'
  from public.remediation_actions
 where tenant_id in ('10000000-0000-0000-0000-0000000000c1') and latest_dry_run_id is null and rollback_definition is not null;
update public.remediation_actions a set latest_dry_run_id = d.id, dry_run_result = d.diff
  from public.dry_runs d
 where d.tenant_id = a.tenant_id and d.action_id = a.id and a.latest_dry_run_id is null
   and a.tenant_id in ('10000000-0000-0000-0000-0000000000c1');

update public.remediation_actions
   set dry_run_status = 'dry_run_complete', rollback_validated = true,
       dry_run_expires_at = now() + interval '1 hour',
       dry_run_result = jsonb_build_object('changes', '[]'::jsonb, 'recordsAffected', 12)
 where tenant_id='10000000-0000-0000-0000-0000000000c1';


insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted) values
 ('10000000-0000-0000-0000-0000000000e1','10000000-0000-0000-0000-0000000000a9','totp','active','fixture-only');
insert into public.mfa_challenges(id,user_id,tenant_id,factor_id,purpose,bound_resource_ref,bound_payload_sha256,expires_at,satisfied_at,consumed_at,consumed_for)
 values('10000000-0000-0000-0000-0000000000f1','10000000-0000-0000-0000-0000000000a9','10000000-0000-0000-0000-0000000000c1','10000000-0000-0000-0000-0000000000e1',
 'approval_issuance','10000000-0000-0000-0000-0000000000c3',repeat('a',64),clock_timestamp()+interval '5 minutes',clock_timestamp(),clock_timestamp(),'10000000-0000-0000-0000-0000000000c3');
