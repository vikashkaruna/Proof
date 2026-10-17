insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a9', 'approver@test.invalid');
insert into public.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a9', 'approver@test.invalid');
insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-0000000000c1', 'exec-a', 'Exec A'),
  ('00000000-0000-0000-0000-0000000000c9', 'exec-b', 'Exec B');
insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-exec', now(), 'test', 'test', 0);
insert into public.engagements(id, tenant_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c1', 'test-exec', 'E');
insert into public.remediation_plans(id, tenant_id, engagement_id, library_version, title)
  values ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-0000000000c2', 'test-exec', 'Batch plan');

insert into public.remediation_actions(id, tenant_id, plan_id, sequence, action_type, description, risk_score, rollback_definition)
values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 1, 'data.mask', 'A', 10, '{}'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 2, 'data.mask', 'B', 10, '{}'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 3, 'data.mask', 'C', 10, '{}');

-- 0157: approval needs a recorded run for the stored content; the inline
-- cache alone is not one. Recorded here exactly as record_dry_run would.
insert into public.dry_runs(tenant_id, action_id, plan_id, status, diff, renderable,
  parameters_hash, rollback_definition_hash, correlation_id, expires_at)
select tenant_id, id, plan_id, 'succeeded', '{"changes": [], "recordsAffected": 12}'::jsonb, true,
  encode(sha256(convert_to(parameters::text, 'UTF8')), 'hex'),
  encode(sha256(convert_to(rollback_definition::text, 'UTF8')), 'hex'),
  gen_random_uuid(), now() + interval '1 hour'
  from public.remediation_actions
 where tenant_id in ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c9') and latest_dry_run_id is null and rollback_definition is not null;
update public.remediation_actions a set latest_dry_run_id = d.id, dry_run_result = d.diff
  from public.dry_runs d
 where d.tenant_id = a.tenant_id and d.action_id = a.id and a.latest_dry_run_id is null
   and a.tenant_id in ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c9');

insert into public.approval_tokens(id, tenant_id, plan_id, action_ids, approver_id, mode, signature, signed_payload, nonce, expires_at, status)
values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
   array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[],
   '00000000-0000-0000-0000-0000000000a9', 'batch', 'sig-1', '{}'::jsonb, 'nonce-1', now() + interval '1 hour', 'issued'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3',
   array['00000000-0000-0000-0000-0000000000d3']::uuid[],
   '00000000-0000-0000-0000-0000000000a9', 'batch', 'sig-2', '{}'::jsonb, 'nonce-2', now() + interval '1 hour', 'issued');

-- Every token carries the snapshot of what it approves (0026/0027). Issued by
-- `issue_plan_approval` in production; set here from the same SQL function, so
-- the fixture cannot drift from what the claim recomputes. A token without one
-- is refused — that is asserted separately.
update public.approval_tokens t
   set signed_payload = coalesce(t.signed_payload, '{}'::jsonb)
     || jsonb_build_object('contentDigest',
          public.action_set_content_digest(t.tenant_id, t.plan_id, t.action_ids));

update public.remediation_actions set approval_status = 'approved', dry_run_status = 'dry_run_complete', rollback_validated = true, dry_run_expires_at = now() + interval '1 hour';
