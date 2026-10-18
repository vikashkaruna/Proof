-- 0158: an owner or admin changes an existing approver's approval scopes
-- through one audited RPC. Refusals: a non-manager actor, a non-approver
-- target, another tenant's member, self-change, oversized/blank scopes, and
-- direct calls by the authenticated role.
begin;
create function pg_temp.ok(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
create function pg_temp.err(result jsonb) returns text language sql as $$ select result->>'error' $$;

insert into auth.users(id,email,email_confirmed_at) values
 ('00000000-0000-4000-8158-00000000a001','owner@d158.invalid',now()),
 ('00000000-0000-4000-8158-00000000a002','admin@d158.invalid',now()),
 ('00000000-0000-4000-8158-00000000a003','approver@d158.invalid',now()),
 ('00000000-0000-4000-8158-00000000a004','viewer@d158.invalid',now()),
 ('00000000-0000-4000-8158-00000000a005','other@d158.invalid',now());
insert into public.users(id,email) select id,email from auth.users where email like '%@d158.invalid';
insert into public.tenants(id,slug,name) values
 ('00000000-0000-4000-8158-00000000b001','scopes-a','Scopes A'),
 ('00000000-0000-4000-8158-00000000b002','scopes-b','Scopes B');
insert into public.tenant_users(tenant_id,user_id,role,approval_scopes) values
 ('00000000-0000-4000-8158-00000000b001','00000000-0000-4000-8158-00000000a001','owner','{}'),
 ('00000000-0000-4000-8158-00000000b001','00000000-0000-4000-8158-00000000a002','admin','{}'),
 ('00000000-0000-4000-8158-00000000b001','00000000-0000-4000-8158-00000000a003','approver','{execute}'),
 ('00000000-0000-4000-8158-00000000b001','00000000-0000-4000-8158-00000000a004','viewer','{}'),
 ('00000000-0000-4000-8158-00000000b002','00000000-0000-4000-8158-00000000a005','approver','{}');

-- Owner narrows, admin widens, both ledgered with previous and new scopes.
select pg_temp.ok((public.update_member_approval_scopes('00000000-0000-4000-8158-00000000b001',
  '00000000-0000-4000-8158-00000000a001','00000000-0000-4000-8158-00000000a003',
  array[' rollback ','execute','execute'], gen_random_uuid())->>'changed')::boolean, 'owner changes scopes');
select pg_temp.ok((select approval_scopes from public.tenant_users where user_id='00000000-0000-4000-8158-00000000a003')
  = array['execute','rollback'], 'scopes trimmed, deduplicated and sorted');
select pg_temp.ok((public.update_member_approval_scopes('00000000-0000-4000-8158-00000000b001',
  '00000000-0000-4000-8158-00000000a002','00000000-0000-4000-8158-00000000a003',
  '{}', gen_random_uuid())->>'changed')::boolean, 'admin clears scopes (unrestricted)');
select pg_temp.ok((public.update_member_approval_scopes('00000000-0000-4000-8158-00000000b001',
  '00000000-0000-4000-8158-00000000a002','00000000-0000-4000-8158-00000000a003',
  '{}', gen_random_uuid())->>'changed')::boolean is false, 'unchanged scopes are a no-op');
select pg_temp.ok((select count(*) from public.audit_ledger
  where tenant_id='00000000-0000-4000-8158-00000000b001'
    and action_type='tenant.member.approval_scopes_changed') = 2, 'two changes ledgered, no-op not');
select pg_temp.ok((select detail->'previous_scopes' from public.audit_ledger
  where tenant_id='00000000-0000-4000-8158-00000000b001'
    and action_type='tenant.member.approval_scopes_changed' order by id desc limit 1)
  = '["execute","rollback"]'::jsonb, 'ledger records the previous scopes');

-- Refusals.
select pg_temp.ok(pg_temp.err(public.update_member_approval_scopes('00000000-0000-4000-8158-00000000b001',
  '00000000-0000-4000-8158-00000000a004','00000000-0000-4000-8158-00000000a003','{execute}',gen_random_uuid()))
  = 'forbidden', 'viewer cannot change scopes');
select pg_temp.ok(pg_temp.err(public.update_member_approval_scopes('00000000-0000-4000-8158-00000000b001',
  '00000000-0000-4000-8158-00000000a001','00000000-0000-4000-8158-00000000a004','{execute}',gen_random_uuid()))
  = 'scopes_require_approver', 'scopes only on approvers');
select pg_temp.ok(pg_temp.err(public.update_member_approval_scopes('00000000-0000-4000-8158-00000000b001',
  '00000000-0000-4000-8158-00000000a001','00000000-0000-4000-8158-00000000a005','{execute}',gen_random_uuid()))
  = 'not_found', 'another tenant''s approver is not reachable');
select pg_temp.ok(pg_temp.err(public.update_member_approval_scopes('00000000-0000-4000-8158-00000000b001',
  '00000000-0000-4000-8158-00000000a001','00000000-0000-4000-8158-00000000a001','{}',gen_random_uuid()))
  = 'self_change', 'no self-change');
select pg_temp.ok(pg_temp.err(public.update_member_approval_scopes('00000000-0000-4000-8158-00000000b001',
  '00000000-0000-4000-8158-00000000a001','00000000-0000-4000-8158-00000000a003',array['  '],gen_random_uuid()))
  = 'invalid_request', 'blank scope refused');
select pg_temp.ok(pg_temp.err(public.update_member_approval_scopes('00000000-0000-4000-8158-00000000b001',
  '00000000-0000-4000-8158-00000000a001','00000000-0000-4000-8158-00000000a003',
  array[repeat('x',65)],gen_random_uuid())) = 'invalid_request', 'over-long scope refused');
select pg_temp.ok(pg_temp.err(public.update_member_approval_scopes('00000000-0000-4000-8158-00000000b001',
  '00000000-0000-4000-8158-00000000a001','00000000-0000-4000-8158-00000000a003',
  (select array_agg('s'||i) from generate_series(1,33) i),gen_random_uuid())) = 'invalid_request', 'over 32 scopes refused');
select pg_temp.ok(not has_function_privilege('authenticated',
  'public.update_member_approval_scopes(uuid,uuid,uuid,text[],uuid)', 'execute'), 'authenticated cannot call');
select pg_temp.ok(not has_function_privilege('service_role',
  'public.update_member_approval_scopes(uuid,uuid,uuid,text[],uuid)', 'execute'), 'service key cannot call');
select pg_temp.ok(has_function_privilege('human_action_writer',
  'public.update_member_approval_scopes(uuid,uuid,uuid,text[],uuid)', 'execute'), 'human action writer can call');
select pg_temp.ok(not has_function_privilege('anon',
  'public.update_member_approval_scopes(uuid,uuid,uuid,text[],uuid)', 'execute'), 'anon cannot call');
rollback;
