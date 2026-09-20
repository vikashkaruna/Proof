-- W1 / R-02: the `axiom_analyst` persona is assigned tenants, not a master key.
--
-- The independent review asked for this explicitly: "Test `axiom_analyst`
-- without granting a blanket internal bypass." The role is new (migration
-- 0015) and its holders carry `users.is_axiom_internal = true`, which before
-- migration 0016 was itself a cross-tenant RLS exemption. These assertions
-- prove the analyst reaches a client the same way anyone else does — by
-- holding a `tenant_users` row — and reaches nothing else.
begin;

create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
create function pg_temp.denied(statement text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when insufficient_privilege then return; end;
  raise exception 'Statement was not denied: %', statement;
end $$;

insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'analyst@axiomminds.invalid'),
  ('00000000-0000-0000-0000-0000000000a2', 'client-owner@test.invalid');
insert into public.users(id, email, is_axiom_internal) values
  ('00000000-0000-0000-0000-0000000000a1', 'analyst@axiomminds.invalid', true),
  ('00000000-0000-0000-0000-0000000000a2', 'client-owner@test.invalid', false);

insert into public.tenants(id, slug, name) values
  ('00000000-0000-0000-0000-0000000000b1', 'analyst-assigned', 'Assigned client'),
  ('00000000-0000-0000-0000-0000000000b2', 'analyst-unassigned', 'Unassigned client');

-- The enum value itself has to be usable as a membership role. If migration
-- 0015 were missing, this insert is where it would fail.
insert into public.tenant_users(tenant_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'axiom_analyst'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', 'owner');

insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-analyst', now(), 'test', 'test', 0);
insert into public.engagements(tenant_id, library_version, title) values
  ('00000000-0000-0000-0000-0000000000b1', 'test-analyst', 'Assigned engagement'),
  ('00000000-0000-0000-0000-0000000000b2', 'test-analyst', 'Unassigned engagement');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

-- Assigned: the analyst can do the job.
select pg_temp.assert_true(
  (select count(*) = 1 from tenants where slug = 'analyst-assigned'),
  'analyst sees the tenant they are assigned to');
select pg_temp.assert_true(
  (select count(*) = 1 from engagements),
  'analyst sees exactly the assigned engagement and no other');
select pg_temp.assert_true(
  public.has_tenant_role('00000000-0000-0000-0000-0000000000b1', array['axiom_analyst']::user_role[]),
  'row-bound analyst role resolves in the assigned tenant');

-- Unassigned: the employee flag buys nothing.
select pg_temp.assert_true(
  (select count(*) = 0 from tenants where slug = 'analyst-unassigned'),
  'is_axiom_internal does not reveal an unassigned tenant');
select pg_temp.assert_true(
  not public.has_tenant_role('00000000-0000-0000-0000-0000000000b2', array['axiom_analyst']::user_role[]),
  'analyst role does not resolve in a tenant they are not assigned to');

-- A forged selected-tenant claim is not a membership, for staff either.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","tenant_id":"00000000-0000-0000-0000-0000000000b2"}';
select pg_temp.assert_true(
  (select count(*) = 0 from engagements where title = 'Unassigned engagement'),
  'a tenant_id claim cannot manufacture an assignment');

-- The analyst is a browser client like any other: reads only. Everything that
-- changes a client estate goes through the BFF and an approval token.
select pg_temp.denied($q$insert into tenant_users(tenant_id,user_id,role) values ('00000000-0000-0000-0000-0000000000b2',auth.uid(),'axiom_analyst')$q$);
select pg_temp.denied($q$update remediation_actions set rollback_validated = true$q$);
select pg_temp.denied($q$update public.approval_tokens set status = 'issued'$q$);
select pg_temp.denied($q$update public.users set is_axiom_internal = true where id = auth.uid()$q$);
select pg_temp.denied($q$insert into public.agent_runs(tenant_id, agent, status, correlation_id) values ('00000000-0000-0000-0000-0000000000b1','karya','running',gen_random_uuid())$q$);

rollback;
