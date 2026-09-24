begin;
create function pg_temp.assert_true(v boolean,m text) returns void language plpgsql as $$ begin if v is distinct from true then raise exception 'ASSERTION FAILED: %',m;end if;end $$;
create function pg_temp.assert_fails(q text,m text) returns void language plpgsql as $$
begin
  begin execute q; exception when others then return; end;
  raise exception 'ASSERTION FAILED: % (statement succeeded)', m;
end $$;
grant execute on function pg_temp.assert_true(boolean,text) to service_role, anon, authenticated;
grant execute on function pg_temp.assert_fails(text,text) to service_role, anon, authenticated;

set local role service_role;
insert into public.contact_inquiries(id,name,email,message,delivery_status)
values('00000000-0000-4000-8000-0000000000c1','Ravi Sharma','ravi@example.invalid','Please call me back soon.','not_configured');
insert into public.contact_inquiries(id,name,email,company,message,delivery_status,delivery_attempted_at)
values('00000000-0000-4000-8000-0000000000c2','Asha Rao','asha@example.invalid','Acme','A delivered inquiry body.','pending',now());
select pg_temp.assert_true((select count(*)=2 from public.contact_inquiries),'service persists without BYPASSRLS');

-- Status claims must agree with their evidence.
select pg_temp.assert_fails($q$insert into public.contact_inquiries(name,email,message,delivery_status)
  values('Nope','n@example.invalid','Claims sent without receipt','sent')$q$,'sent needs a receipt');
select pg_temp.assert_fails($q$insert into public.contact_inquiries(name,email,message,delivery_status,delivery_attempted_at)
  values('Nope','n@example.invalid','Not configured but attempted','not_configured',now())$q$,'not_configured is never attempted');
select pg_temp.assert_fails($q$insert into public.contact_inquiries(name,email,message,delivery_status)
  values('Nope','n@example.invalid','short','not_configured')$q$,'message length bounded');

-- Settlement happens once, from pending only.
update public.contact_inquiries set delivery_status='sent',delivery_completed_at=now(),provider_message_id='re_123'
  where id='00000000-0000-4000-8000-0000000000c2';
select pg_temp.assert_true((select delivery_status='sent' from public.contact_inquiries where id='00000000-0000-4000-8000-0000000000c2'),'pending settles to sent');
update public.contact_inquiries set delivery_status='failed',provider_message_id=null,
  delivery_error_code='provider_refused' where id='00000000-0000-4000-8000-0000000000c2';
select pg_temp.assert_true((select delivery_status='sent' from public.contact_inquiries where id='00000000-0000-4000-8000-0000000000c2'),'settled outcome cannot be rewritten by the backend');
-- A never-attempted row cannot later be claimed as sent (RLS hides it from the settle policy).
update public.contact_inquiries set delivery_status='sent',delivery_attempted_at=now(),delivery_completed_at=now(),
  provider_message_id='re_forged' where id='00000000-0000-4000-8000-0000000000c1';
select pg_temp.assert_true((select delivery_status='not_configured' from public.contact_inquiries where id='00000000-0000-4000-8000-0000000000c1'),'not_configured cannot be upgraded to sent');
select pg_temp.assert_fails($q$delete from public.contact_inquiries where id='00000000-0000-4000-8000-0000000000c1'$q$,'service cannot delete');
reset role;

-- The guard also binds privileged sessions: content is immutable and outcomes settle once.
select pg_temp.assert_fails($q$update public.contact_inquiries set message='Rewritten message body' where id='00000000-0000-4000-8000-0000000000c2'$q$,'content immutable');
select pg_temp.assert_fails($q$update public.contact_inquiries set delivery_status='failed',provider_message_id=null,delivery_error_code='provider_refused'
  where id='00000000-0000-4000-8000-0000000000c2'$q$,'settled outcome immutable');
select pg_temp.assert_fails($q$delete from public.contact_inquiries$q$,'no delete even for owner');

set local role anon;
select pg_temp.assert_true(not has_table_privilege(current_user,'public.contact_inquiries','INSERT'),'anonymous cannot write inquiries directly');
select pg_temp.assert_true(not has_table_privilege(current_user,'public.contact_inquiries','SELECT'),'anonymous cannot read inquiries');
reset role;
set local role authenticated;
select pg_temp.assert_true(not has_table_privilege(current_user,'public.contact_inquiries','INSERT'),'authenticated cannot write inquiries');
select pg_temp.assert_true(not has_table_privilege(current_user,'public.contact_inquiries','UPDATE'),'authenticated cannot forge delivery');
select pg_temp.assert_true((select count(*)=0 from public.contact_inquiries),'non-internal users see no inquiries');
reset role;
rollback;
