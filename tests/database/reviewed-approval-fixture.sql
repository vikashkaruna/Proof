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

update public.remediation_actions
   set dry_run_status = 'dry_run_complete', rollback_validated = true,
       dry_run_expires_at = now() + interval '1 hour',
       dry_run_result = jsonb_build_object('recordsAffected', 12)
 where tenant_id='10000000-0000-0000-0000-0000000000c1';


insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted) values
 ('10000000-0000-0000-0000-0000000000e1','10000000-0000-0000-0000-0000000000a9','totp','active','fixture-only');
insert into public.mfa_challenges(id,user_id,tenant_id,factor_id,purpose,bound_resource_ref,bound_payload_sha256,expires_at,satisfied_at,consumed_at,consumed_for)
 values('10000000-0000-0000-0000-0000000000f1','10000000-0000-0000-0000-0000000000a9','10000000-0000-0000-0000-0000000000c1','10000000-0000-0000-0000-0000000000e1',
 'approval_issuance','10000000-0000-0000-0000-0000000000c3',repeat('a',64),clock_timestamp()+interval '5 minutes',clock_timestamp(),clock_timestamp(),'10000000-0000-0000-0000-0000000000c3');
