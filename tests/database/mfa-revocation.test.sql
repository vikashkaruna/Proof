begin;
create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000000c1','revoke@test.invalid'),('00000000-0000-4000-8000-0000000000c2','other@test.invalid');
insert into public.users(id,email) select id,email from auth.users where email in ('revoke@test.invalid','other@test.invalid');
insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted) values
 ('00000000-0000-4000-8000-0000000000d1','00000000-0000-4000-8000-0000000000c1','totp','active','sealed'),
 ('00000000-0000-4000-8000-0000000000d2','00000000-0000-4000-8000-0000000000c1','totp','pending','sealed'),
 ('00000000-0000-4000-8000-0000000000d3','00000000-0000-4000-8000-0000000000c2','totp','active','sealed');
insert into public.user_mfa_factors(user_id,factor_type,status,code_hash) values
 ('00000000-0000-4000-8000-0000000000c1','recovery_code','active','hash');
insert into public.mfa_session_attestations(user_id,session_id,factor_id,expires_at) values
 ('00000000-0000-4000-8000-0000000000c1','session-1','00000000-0000-4000-8000-0000000000d1',now()+interval '1 hour'),
 ('00000000-0000-4000-8000-0000000000c2','session-2','00000000-0000-4000-8000-0000000000d3',now()+interval '1 hour');

-- Failure of the second write must roll back the first, not merely log.
create function pg_temp.fail_attestation_revoke() returns trigger language plpgsql as $$
begin raise exception 'injected attestation write failure'; end $$;
create trigger injected_failure before update on public.mfa_session_attestations
  for each row execute function pg_temp.fail_attestation_revoke();
do $$ begin
  begin
    perform public.revoke_totp_factor('00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-0000000000d1');
    raise exception 'unexpected success';
  exception when raise_exception then
    if sqlerrm <> 'injected attestation write failure' then raise; end if;
  end;
end $$;
drop trigger injected_failure on public.mfa_session_attestations;
select pg_temp.assert_true((select status='active' from public.user_mfa_factors where id='00000000-0000-4000-8000-0000000000d1'), 'failure rolls back the active factor');

set local role service_role;
select pg_temp.assert_true(not exists(select * from public.revoke_totp_factor('00000000-0000-4000-8000-0000000000c2','00000000-0000-4000-8000-0000000000d1')), 'cannot revoke another user');
select pg_temp.assert_true(exists(select * from public.revoke_totp_factor('00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-0000000000d1')), 'service without BYPASSRLS can revoke');
reset role;
select pg_temp.assert_true(not exists(select 1 from public.user_mfa_factors where user_id='00000000-0000-4000-8000-0000000000c1' and status<>'revoked'), 'no pending factor or recovery code survives');
select pg_temp.assert_true(not exists(select 1 from public.mfa_session_attestations where user_id='00000000-0000-4000-8000-0000000000c1' and revoked_at is null), 'no verified session survives');
select pg_temp.assert_true((select revoked_at is null from public.mfa_session_attestations where session_id='session-2'), 'other user session survives');
-- A verified login already in flight cannot add assurance after revocation.
do $$ begin
  begin
    insert into public.mfa_session_attestations(user_id,session_id,factor_id,expires_at) values
      ('00000000-0000-4000-8000-0000000000c1','late-session','00000000-0000-4000-8000-0000000000d1',now()+interval '1 hour');
    raise exception 'retired factor attested';
  exception when check_violation then null; end;
  begin
    insert into public.mfa_session_attestations(user_id,session_id,factor_id,expires_at) values
      ('00000000-0000-4000-8000-0000000000c1','foreign-factor','00000000-0000-4000-8000-0000000000d3',now()+interval '1 hour');
    raise exception 'foreign factor attested';
  exception when check_violation then null; end;
end $$;
set local role authenticated;
do $$ begin
  begin
    perform public.revoke_totp_factor('00000000-0000-4000-8000-0000000000c2','00000000-0000-4000-8000-0000000000d3');
    raise exception 'browser revoked factor';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
