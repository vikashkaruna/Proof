begin;
create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
create function pg_temp.hashes() returns text[] language sql as $$
select array_agg('scrypt$'||md5(i::text)||'$'||repeat(md5(i::text),2)) from generate_series(1,10) i
$$;
-- Use real SQL, not the service double, for the atomicity and provenance rules.
do $$
declare
  u uuid := gen_random_uuid(); other_u uuid := gen_random_uuid();
  old_f uuid := gen_random_uuid(); next_f uuid; ch uuid; method text;
  other_f uuid := gen_random_uuid();
begin
  insert into auth.users(id,email) values(u,'replacement@test.invalid'),(other_u,'other-replacement@test.invalid');
  insert into public.users(id,email) values(u,'replacement@test.invalid'),(other_u,'other-replacement@test.invalid');
  insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted)
    values(old_f,u,'totp','active','sealed'),(other_f,other_u,'totp','active','sealed');
  insert into public.mfa_session_attestations(user_id,session_id,factor_id,expires_at)
    values(u,'first-session',old_f,now()+interval '1 hour'),
      (u,'second-session',old_f,now()+interval '1 hour'),
      (other_u,'unrelated-session',other_f,now()+interval '1 hour');
  foreach method in array array['totp','recovery_code'] loop
    next_f := gen_random_uuid(); ch := gen_random_uuid();
    insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted)
      values(next_f,u,'totp','pending','sealed-new');
    -- In-flight legacy replacements and first-enrollment races cannot bypass proof.
    begin
      perform public.finalize_totp_enrolment(u,next_f,42,pg_temp.hashes());
      raise exception 'replacement accepted without provenance';
    exception when sqlstate 'PT409' then null; end;
    insert into public.mfa_challenges(id,user_id,factor_id,purpose,bound_resource_ref,expires_at,satisfied_at,consumed_at,satisfied_with)
      values(ch,u,old_f,'enrolment',old_f::text,now()+interval '5 minutes',now(),now(),null);
    update public.user_mfa_factors set replaces_factor_id=old_f,replacement_challenge_id=ch where id=next_f;
    begin
      perform public.finalize_totp_enrolment(u,next_f,42,pg_temp.hashes());
      raise exception 'unknown verification method was accepted';
    exception when sqlstate 'PT409' then null; end;
    update public.mfa_challenges set satisfied_with=method,user_id=other_u where id=ch;
    begin
      perform public.finalize_totp_enrolment(u,next_f,42,pg_temp.hashes());
      raise exception 'another user challenge was accepted';
    exception when sqlstate 'PT409' then null; end;
    update public.mfa_challenges set user_id=u where id=ch;
    update public.user_mfa_factors set replaces_factor_id=other_f where id=next_f;
    begin
      perform public.finalize_totp_enrolment(u,next_f,42,pg_temp.hashes());
      raise exception 'stale factor binding was accepted';
    exception when sqlstate 'PT409' then null; end;
    update public.user_mfa_factors set replaces_factor_id=old_f where id=next_f;
    perform public.finalize_totp_enrolment(u,next_f,42,pg_temp.hashes());
    perform pg_temp.assert_true((select count(*)=case when method='totp' then 2 else 0 end
      from public.mfa_session_attestations where user_id=u and revoked_at is null),
      'TOTP preserves assurance; recovery also clears assurance grandfathered from prior factors');
    old_f := next_f;
  end loop;
  perform pg_temp.assert_true((select revoked_at is null from public.mfa_session_attestations where user_id=other_u), 'unrelated user unchanged');
end $$;
rollback;
