begin;
create function pg_temp.ok(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
create function pg_temp.fails(q text, message text) returns void language plpgsql as $$
begin begin execute q; exception when others then return; end;
raise exception 'ASSERTION FAILED: % (statement succeeded)', message; end $$;
create function pg_temp.h(t text) returns text language sql as $$ select encode(sha256(convert_to(t,'UTF8')),'hex') $$;
grant execute on function pg_temp.ok(boolean,text) to service_role, authenticated;
grant execute on function pg_temp.fails(text,text) to service_role, authenticated;
grant execute on function pg_temp.h(text) to service_role;

insert into auth.users(id,email,email_confirmed_at) values
 ('00000000-0000-4000-8000-00000000a001','owner@inv.invalid',now()),
 ('00000000-0000-4000-8000-00000000a002','admin@inv.invalid',now()),
 ('00000000-0000-4000-8000-00000000a003','viewer@inv.invalid',now()),
 ('00000000-0000-4000-8000-00000000a004','new.approver@inv.invalid',now()),
 ('00000000-0000-4000-8000-00000000a005','unconfirmed@inv.invalid',null),
 ('00000000-0000-4000-8000-00000000a006','someone.else@inv.invalid',now());
insert into public.users(id,email) values
 ('00000000-0000-4000-8000-00000000a001','owner@inv.invalid'),
 ('00000000-0000-4000-8000-00000000a002','admin@inv.invalid'),
 ('00000000-0000-4000-8000-00000000a003','viewer@inv.invalid');
insert into public.tenants(id,slug,name) values
 ('00000000-0000-4000-8000-00000000b001','inv-a','Invite A'),
 ('00000000-0000-4000-8000-00000000b002','inv-b','Invite B');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-00000000a001','owner'),
 ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-00000000a002','admin'),
 ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-00000000a003','viewer');

create function pg_temp.invite(actor uuid, email text, r public.user_role, scopes text[], token text, ttl int default 72)
returns jsonb language sql as $$
 select public.create_tenant_invitation('00000000-0000-4000-8000-00000000b001',actor,email,r,scopes,pg_temp.h(token),ttl,false,gen_random_uuid());
$$;
grant execute on function pg_temp.invite(uuid,text,public.user_role,text[],text,int) to service_role;
set local role service_role;
do $$
declare r jsonb; inv uuid; events bigint;
begin
 -- Authority: only owner/admin, and admins cannot mint owners/admins.
 r:=pg_temp.invite('00000000-0000-4000-8000-00000000a003','x@inv.invalid','viewer','{}','t-viewer');
 perform pg_temp.ok(r->>'error'='forbidden','viewer cannot invite');
 r:=pg_temp.invite('00000000-0000-4000-8000-00000000a002','x@inv.invalid','owner','{}','t-adm-owner');
 perform pg_temp.ok(r->>'error'='role_not_grantable','admin cannot invite an owner');
 r:=pg_temp.invite('00000000-0000-4000-8000-00000000a002','x@inv.invalid','admin','{}','t-adm-admin');
 perform pg_temp.ok(r->>'error'='role_not_grantable','admin cannot invite an admin');
 r:=pg_temp.invite('00000000-0000-4000-8000-00000000a001','x@inv.invalid','founder','{}','t-founder');
 perform pg_temp.ok(r->>'error'='role_not_grantable','internal roles are never invitable');
 r:=pg_temp.invite('00000000-0000-4000-8000-00000000a001','x@inv.invalid','viewer','{"high"}','t-scoped');
 perform pg_temp.ok(r->>'error'='scopes_require_approver','scopes only for approvers');
 r:=pg_temp.invite('00000000-0000-4000-8000-00000000a001','Viewer@inv.invalid','viewer','{}','t-member');
 perform pg_temp.ok(r->>'error'='already_member','existing member cannot be re-invited');
 r:=public.create_tenant_invitation('00000000-0000-4000-8000-00000000b002','00000000-0000-4000-8000-00000000a001','x@inv.invalid','viewer','{}',pg_temp.h('t-other'),72,false,gen_random_uuid());
 perform pg_temp.ok(r->>'error'='forbidden','membership in another tenant is not authority');
 perform pg_temp.ok((select count(*)=0 from public.tenant_invitations),'refusals persist nothing');

 -- Creation is atomic with its audit event and never stores the raw token or plain email in the ledger.
 r:=pg_temp.invite('00000000-0000-4000-8000-00000000a002',' New.Approver@INV.invalid ','approver','{"low","medium"}','secret-token-1');
 inv:=(r#>>'{invitation,id}')::uuid;
 perform pg_temp.ok(inv is not null and r#>>'{invitation,email}'='new.approver@inv.invalid','admin invites approver; email normalized');
 perform pg_temp.ok(not (r->'invitation' ? 'token_hash'),'token hash not returned');
 perform pg_temp.ok((select count(*)=1 from public.audit_ledger where action_type='tenant.invitation.created' and target_ref=inv::text),'creation audited');
 perform pg_temp.ok((select detail::text not like '%new.approver%' and detail::text not like '%secret-token%' from public.audit_ledger where target_ref=inv::text),'ledger holds no address or token');
 r:=pg_temp.invite('00000000-0000-4000-8000-00000000a001','new.approver@inv.invalid','viewer','{}','secret-token-2');
 perform pg_temp.ok(r->>'error'='invitation_open','one open invitation per address');

 -- Acceptance binds to the invited, confirmed email.
 select count(*) into events from public.audit_ledger;
 r:=public.accept_tenant_invitation(pg_temp.h('secret-token-1'),'00000000-0000-4000-8000-00000000a006',gen_random_uuid());
 perform pg_temp.ok(r->>'error'='email_mismatch','another account cannot accept');
 r:=public.accept_tenant_invitation(pg_temp.h('wrong-token'),'00000000-0000-4000-8000-00000000a004',gen_random_uuid());
 perform pg_temp.ok(r->>'error'='not_found','unknown token refused');
 r:=public.accept_tenant_invitation('not-a-hash','00000000-0000-4000-8000-00000000a004',gen_random_uuid());
 perform pg_temp.ok(r->>'error'='not_found','malformed token refused');
 perform pg_temp.ok((select count(*)=events from public.audit_ledger),'refused accepts are not audited as success');
 r:=public.accept_tenant_invitation(pg_temp.h('secret-token-1'),'00000000-0000-4000-8000-00000000a004',gen_random_uuid());
 perform pg_temp.ok(r->>'role'='approver' and (r->>'replayed')::boolean=false,'invitee accepts');
 perform pg_temp.ok((select role='approver' and approval_scopes='{low,medium}' and accepted_at is not null from public.tenant_users
   where tenant_id='00000000-0000-4000-8000-00000000b001' and user_id='00000000-0000-4000-8000-00000000a004'),'membership carries role and scopes');
 perform pg_temp.ok((select count(*)=1 from public.users where id='00000000-0000-4000-8000-00000000a004'),'profile mirrored from auth');
 perform pg_temp.ok((select count(*)=1 from public.audit_ledger where action_type='tenant.invitation.accepted' and target_ref=inv::text),'acceptance audited');
 r:=public.accept_tenant_invitation(pg_temp.h('secret-token-1'),'00000000-0000-4000-8000-00000000a004',gen_random_uuid());
 perform pg_temp.ok((r->>'replayed')::boolean,'same user replay is idempotent');
 perform pg_temp.ok((select count(*)=1 from public.audit_ledger where action_type='tenant.invitation.accepted'),'replay adds no event');
 r:=public.revoke_tenant_invitation('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-00000000a001',inv,gen_random_uuid());
 perform pg_temp.ok(r->>'error'='already_accepted','accepted invitation cannot be revoked');

 -- Unconfirmed email, revocation, expiry.
 r:=pg_temp.invite('00000000-0000-4000-8000-00000000a001','unconfirmed@inv.invalid','viewer','{}','tok-unconfirmed');
 r:=public.accept_tenant_invitation(pg_temp.h('tok-unconfirmed'),'00000000-0000-4000-8000-00000000a005',gen_random_uuid());
 perform pg_temp.ok(r->>'error'='email_unconfirmed','unconfirmed account cannot accept');
 r:=pg_temp.invite('00000000-0000-4000-8000-00000000a001','someone.else@inv.invalid','owner','{}','tok-owner');
 inv:=(r#>>'{invitation,id}')::uuid;
 r:=public.revoke_tenant_invitation('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-00000000a002',inv,gen_random_uuid());
 perform pg_temp.ok(r->>'error'='role_not_grantable','admin cannot revoke an owner invitation');
 r:=public.revoke_tenant_invitation('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-00000000a001',inv,gen_random_uuid());
 perform pg_temp.ok(r#>>'{invitation,revoked_at}' is not null,'owner revokes');
 perform pg_temp.ok((select count(*)=1 from public.audit_ledger where action_type='tenant.invitation.revoked' and target_ref=inv::text),'revocation audited');
 r:=public.accept_tenant_invitation(pg_temp.h('tok-owner'),'00000000-0000-4000-8000-00000000a006',gen_random_uuid());
 perform pg_temp.ok(r->>'error'='revoked','revoked invitation cannot be accepted');
 perform pg_temp.ok((select count(*)=0 from public.tenant_users where user_id='00000000-0000-4000-8000-00000000a006'),'no membership from revoked invite');
 -- A replacement after revocation is allowed.
 r:=pg_temp.invite('00000000-0000-4000-8000-00000000a001','someone.else@inv.invalid','viewer','{}','tok-again');
 perform pg_temp.ok(r->'invitation' is not null,'reinvite after revocation');
 r:=pg_temp.invite('00000000-0000-4000-8000-00000000a001','x@inv.invalid','viewer','{}','t-ttl',500);
 perform pg_temp.ok(r->>'error'='invalid_request','lifetime bounded to 14 days');
end $$;

-- Expiry: backdate through the owner session (content columns are immutable, so rebuild the row).
reset role;
alter table public.tenant_invitations disable trigger tenant_invitation_guard;
update public.tenant_invitations set created_at=now()-interval '4 days', expires_at=now()-interval '1 day'
 where email='someone.else@inv.invalid' and revoked_at is null;
alter table public.tenant_invitations enable trigger tenant_invitation_guard;
set local role service_role;
do $$ declare r jsonb; begin
 r:=public.accept_tenant_invitation(pg_temp.h('tok-again'),'00000000-0000-4000-8000-00000000a006',gen_random_uuid());
 perform pg_temp.ok(r->>'error'='expired','expired invitation refused');
 r:=pg_temp.invite('00000000-0000-4000-8000-00000000a001','someone.else@inv.invalid','viewer','{}','tok-fresh');
 perform pg_temp.ok(r->'invitation' is not null,'expired open invitation is closed and replaced');
 perform pg_temp.ok((select count(*)=1 from public.tenant_invitations where email='someone.else@inv.invalid' and accepted_at is null and revoked_at is null),'still one open invitation');
end $$;

-- Direct writes are refused; settlement moves once.
select pg_temp.fails($q$insert into public.tenant_invitations(tenant_id,email,role,token_hash,invited_by,expires_at)
  values('00000000-0000-4000-8000-00000000b001','z@inv.invalid','owner',repeat('a',64),'00000000-0000-4000-8000-00000000a001',now()+interval '1 day')$q$,'backend cannot insert directly');
select pg_temp.fails($q$update public.tenant_invitations set role='owner'$q$,'backend cannot change role');
select pg_temp.fails($q$delete from public.tenant_invitations$q$,'backend cannot delete');
reset role;
select pg_temp.fails($q$update public.tenant_invitations set role='owner' where email='someone.else@inv.invalid'$q$,'content immutable even for owner');
select pg_temp.fails($q$update public.tenant_invitations set accepted_at=null,accepted_by=null where accepted_at is not null$q$,'acceptance cannot be undone');

-- Session reads: owners/admins see their tenant's invitations without token hashes; others see none.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-00000000a003","role":"authenticated"}';
select pg_temp.ok((select count(*)=0 from public.tenant_invitations),'viewer sees no invitations');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-00000000a002","role":"authenticated"}';
select pg_temp.ok((select count(*)>0 from public.tenant_invitations),'admin reads invitations');
select pg_temp.fails($q$select token_hash from public.tenant_invitations$q$,'token hash never readable in session');
select pg_temp.ok(not has_function_privilege('public.accept_tenant_invitation(text,uuid,uuid)','execute'),'sessions cannot call accept directly');
reset role;
rollback;
