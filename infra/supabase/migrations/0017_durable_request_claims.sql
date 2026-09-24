-- W0: the old middleware queried an absent idempotency_keys table and ignored
-- database failures. A claim must be durable BEFORE the handler runs.
begin;
create table public.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  tenant_id uuid references public.tenants(id) on delete restrict,
  tenant_scope uuid generated always as (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,
  path text not null,
  method text not null check (method in ('POST','PUT','PATCH','DELETE')),
  key text not null check (length(key) between 8 and 256),
  request_sha256 text not null check (length(request_sha256) = 64),
  authority_sha256 text not null check (length(authority_sha256) = 64),
  status text not null default 'in_progress' check (status in ('in_progress','completed')),
  response_status integer check (response_status between 100 and 599),
  response_body jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  replay_until timestamptz not null default now() + interval '24 hours',
  unique (user_id, tenant_scope, path, method, key),
  check (status <> 'completed' or (response_status is not null and completed_at is not null))
);
alter table public.idempotency_keys enable row level security;
revoke all on public.idempotency_keys from public, anon, authenticated;
grant select, insert, update on public.idempotency_keys to service_role;

create function public.claim_request(
  p_user_id uuid, p_tenant_id uuid, p_path text, p_method text, p_key text,
  p_request_sha256 text, p_authority_sha256 text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.idempotency_keys;
begin
  insert into public.idempotency_keys(user_id,tenant_id,path,method,key,request_sha256,authority_sha256)
    values(p_user_id,p_tenant_id,p_path,p_method,p_key,p_request_sha256,p_authority_sha256)
    on conflict (user_id,tenant_scope,path,method,key) do nothing returning * into r;
  if found then return jsonb_build_object('decision','claimed','id',r.id); end if;
  select * into strict r from public.idempotency_keys
    where user_id=p_user_id and tenant_scope=coalesce(p_tenant_id,'00000000-0000-0000-0000-000000000000'::uuid)
      and path=p_path and method=p_method and key=p_key for update;
  if r.request_sha256 <> p_request_sha256 or r.authority_sha256 <> p_authority_sha256 then
    return jsonb_build_object('decision','conflict');
  end if;
  if r.status <> 'completed' then return jsonb_build_object('decision','in_progress'); end if;
  if r.replay_until <= now() then return jsonb_build_object('decision','expired'); end if;
  return jsonb_build_object('decision','replay','status',r.response_status,'body',r.response_body);
end $$;

create function public.complete_request(p_id uuid,p_request_sha256 text,p_status integer,p_body jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.idempotency_keys set status='completed',response_status=p_status,response_body=p_body,completed_at=now()
    where id=p_id and request_sha256=p_request_sha256 and status='in_progress';
  return found;
end $$;
revoke all on function public.claim_request(uuid,uuid,text,text,text,text,text),
  public.complete_request(uuid,text,integer,jsonb) from public,anon,authenticated;
grant execute on function public.claim_request(uuid,uuid,text,text,text,text,text),
  public.complete_request(uuid,text,integer,jsonb) to service_role;
commit;
