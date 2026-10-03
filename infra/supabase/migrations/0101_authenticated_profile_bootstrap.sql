-- PostgREST requires table-level INSERT for its profile write path. Keep that
-- privilege closed: a signed-in user can only materialize their own Auth row
-- through this fixed, idempotent function, never set authority columns.
begin;

create function public.bootstrap_user_profile()
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_auth auth.users;
begin
  if auth.uid() is null then
    raise exception 'Authenticated user required' using errcode = '42501';
  end if;
  select * into v_auth from auth.users where id = auth.uid();
  if not found or v_auth.email is null then
    raise exception 'Authenticated identity unavailable' using errcode = '42501';
  end if;
  insert into public.users(id,email,full_name)
    values(v_auth.id,v_auth.email,
      nullif(left(btrim(coalesce(v_auth.raw_user_meta_data->>'full_name','')),200),''))
    on conflict (id) do nothing;
  return v_auth.id;
end $$;

revoke all on function public.bootstrap_user_profile() from public,anon,authenticated;
grant execute on function public.bootstrap_user_profile() to authenticated;
revoke insert (id,email,full_name) on public.users from authenticated;

-- Auth accounts created before this migration may have missed the old web
-- mirror. Backfill only the identity-owned fields; no memberships or grants.
insert into public.users(id,email,full_name)
select a.id,a.email,
  nullif(left(btrim(coalesce(a.raw_user_meta_data->>'full_name','')),200),'')
from auth.users a
where a.email is not null
on conflict (id) do nothing;

commit;
