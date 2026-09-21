begin;
create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
create function pg_temp.hashes() returns text[] language sql as $$
select array_agg('scrypt$'||md5(i::text)||'$'||repeat(md5(i::text),2)) from generate_series(1,10) i
$$;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000000071','activation@test.invalid');
insert into public.users(id,email) values ('00000000-0000-4000-8000-000000000071','activation@test.invalid');
insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted) values
 ('00000000-0000-4000-8000-000000000072','00000000-0000-4000-8000-000000000071','totp','active','sealed-old'),
 ('00000000-0000-4000-8000-000000000073','00000000-0000-4000-8000-000000000071','totp','pending','sealed-new');
insert into public.user_mfa_factors(id,user_id,factor_type,status,code_hash) values
 ('00000000-0000-4000-8000-000000000074','00000000-0000-4000-8000-000000000071','recovery_code','active','old-hash');

-- A verified, consumed recovery challenge is the trusted replacement proof.
insert into public.mfa_challenges(id,user_id,factor_id,purpose,bound_resource_ref,expires_at,satisfied_at,consumed_at,satisfied_with)
values ('00000000-0000-4000-8000-000000000075','00000000-0000-4000-8000-000000000071','00000000-0000-4000-8000-000000000072','enrolment','00000000-0000-4000-8000-000000000072',now()+interval '5 minutes',now(),now(),'recovery_code');
update public.user_mfa_factors set replaces_factor_id='00000000-0000-4000-8000-000000000072',replacement_challenge_id='00000000-0000-4000-8000-000000000075' where id='00000000-0000-4000-8000-000000000073';
insert into public.mfa_session_attestations(user_id,session_id,factor_id,expires_at)
values ('00000000-0000-4000-8000-000000000071','activation-session','00000000-0000-4000-8000-000000000072',now()+interval '1 hour');

-- Force recovery persistence to fail after the internal factor swap.
create function pg_temp.fail_recovery_insert() returns trigger language plpgsql as $$
begin if new.factor_type='recovery_code' then raise exception 'injected recovery storage failure'; end if; return new; end $$;
create trigger injected_failure before insert on public.user_mfa_factors
  for each row execute function pg_temp.fail_recovery_insert();
set local role service_role;
do $$ begin
  begin
    perform public.finalize_totp_enrolment('00000000-0000-4000-8000-000000000071','00000000-0000-4000-8000-000000000073',42,pg_temp.hashes());
    raise exception 'unexpected success';
  exception when raise_exception then
    if sqlerrm <> 'injected recovery storage failure' then raise; end if;
  end;
end $$;
reset role;
drop trigger injected_failure on public.user_mfa_factors;
select pg_temp.assert_true((select status='active' from public.user_mfa_factors where id='00000000-0000-4000-8000-000000000072'), 'failed recovery insert retains old authenticator');
select pg_temp.assert_true((select status='pending' and last_used_counter is null from public.user_mfa_factors where id='00000000-0000-4000-8000-000000000073'), 'failed recovery insert retains pending factor and unused counter');
select pg_temp.assert_true((select status='active' from public.user_mfa_factors where id='00000000-0000-4000-8000-000000000074'), 'old recovery set remains usable');

select pg_temp.assert_true((select revoked_at is null from public.mfa_session_attestations where session_id='activation-session'), 'rollback keeps previous session verification');

-- Failure in the final attestation update must also undo the factor/code swap.
create function pg_temp.fail_session_update() returns trigger language plpgsql as $$
begin raise exception 'injected session storage failure'; end $$;
create trigger injected_session_failure before update on public.mfa_session_attestations
  for each row execute function pg_temp.fail_session_update();
set local role service_role;
do $$ begin
  begin
    perform public.finalize_totp_enrolment('00000000-0000-4000-8000-000000000071','00000000-0000-4000-8000-000000000073',42,pg_temp.hashes());
    raise exception 'unexpected success';
  exception when raise_exception then
    if sqlerrm <> 'injected session storage failure' then raise; end if;
  end;
end $$;
reset role;
drop trigger injected_session_failure on public.mfa_session_attestations;
select pg_temp.assert_true((select status='active' from public.user_mfa_factors where id='00000000-0000-4000-8000-000000000072'), 'session failure restores old authenticator');
select pg_temp.assert_true((select status='pending' and last_used_counter is null from public.user_mfa_factors where id='00000000-0000-4000-8000-000000000073'), 'session failure restores pending factor and counter');
select pg_temp.assert_true((select count(*)=1 from public.user_mfa_factors where user_id='00000000-0000-4000-8000-000000000071' and factor_type='recovery_code' and status='active'), 'session failure restores original recovery set');
select pg_temp.assert_true((select revoked_at is null from public.mfa_session_attestations where session_id='activation-session'), 'session failure preserves prior assurance');

set local role service_role;
select pg_temp.assert_true(exists(select * from public.finalize_totp_enrolment('00000000-0000-4000-8000-000000000071','00000000-0000-4000-8000-000000000073',42,pg_temp.hashes())), 'retry completes both transitions');
select pg_temp.assert_true(not exists(select * from public.finalize_totp_enrolment('00000000-0000-4000-8000-000000000071','00000000-0000-4000-8000-000000000073',42,pg_temp.hashes())), 'repeated activation cannot rotate codes again');
do $$ begin
  begin
    perform public.activate_totp_factor('00000000-0000-4000-8000-000000000071','00000000-0000-4000-8000-000000000073',42);
    raise exception 'BFF can bypass recovery transaction';
  exception when insufficient_privilege then null; end;
  begin
    perform public.finalize_totp_enrolment('00000000-0000-4000-8000-000000000071','00000000-0000-4000-8000-000000000073',42,array['raw-code']);
    raise exception 'invalid recovery set accepted';
  exception when check_violation then null; end;
end $$;
reset role;
select pg_temp.assert_true((select status='revoked' from public.user_mfa_factors where id='00000000-0000-4000-8000-000000000074'), 'old recovery row retained but unusable');
select pg_temp.assert_true((select count(*)=10 from public.user_mfa_factors where user_id='00000000-0000-4000-8000-000000000071' and factor_type='recovery_code' and status='active'), 'exactly ten new active hashes');
select pg_temp.assert_true((select status='active' and last_used_counter=42 from public.user_mfa_factors where id='00000000-0000-4000-8000-000000000073'), 'new factor active and replay counter burned');
select pg_temp.assert_true((select revoked_at is not null from public.mfa_session_attestations where session_id='activation-session'), 'recovery replacement ends prior verification');
set local role authenticated;
do $$ begin
  begin
    perform public.finalize_totp_enrolment('00000000-0000-4000-8000-000000000071','00000000-0000-4000-8000-000000000073',42,pg_temp.hashes());
    raise exception 'browser activated factor';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
