-- C-W0-6: public contact inquiries are persisted by the BFF before any mail is
-- attempted, and the stored delivery status is the only claim made about mail.
-- Marketing SSR holds neither database nor mail credentials for this workflow.
begin;

create table public.contact_inquiries (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  email text not null check (char_length(email) between 3 and 320),
  company text check (company is null or char_length(company) <= 200),
  message text not null check (char_length(message) between 10 and 5000),
  created_at timestamptz not null default now(),
  -- not_configured: stored; delivery deliberately disabled, nothing was sent.
  -- pending: stored; one provider attempt is in flight or its result is unknown.
  -- sent: the provider returned a receipt. failed: the provider refused or was unreachable.
  delivery_status text not null check (delivery_status in ('not_configured','pending','sent','failed')),
  delivery_attempted_at timestamptz,
  delivery_completed_at timestamptz,
  provider_message_id text check (provider_message_id is null or char_length(provider_message_id) between 1 and 200),
  delivery_error_code text check (delivery_error_code is null or delivery_error_code in
    ('provider_refused','provider_unavailable','provider_no_receipt')),
  constraint contact_delivery_consistent check (
    (delivery_status = 'not_configured' and delivery_attempted_at is null and delivery_completed_at is null
       and provider_message_id is null and delivery_error_code is null)
    or (delivery_status = 'pending' and delivery_attempted_at is not null and delivery_completed_at is null
       and provider_message_id is null and delivery_error_code is null)
    or (delivery_status = 'sent' and delivery_attempted_at is not null and delivery_completed_at is not null
       and provider_message_id is not null and delivery_error_code is null)
    or (delivery_status = 'failed' and delivery_attempted_at is not null and delivery_completed_at is not null
       and provider_message_id is null and delivery_error_code is not null)
  )
);
create index idx_contact_inquiries_created on public.contact_inquiries(created_at desc);
create index idx_contact_inquiries_undelivered on public.contact_inquiries(created_at)
  where delivery_status in ('pending','failed');

comment on table public.contact_inquiries is
  'Public founder-contact submissions. Written only by the BFF; submitted content is immutable and delivery settles once.';

-- Submitted content never changes, and a delivery outcome settles exactly once:
-- pending -> sent | failed. A not_configured row was never attempted and stays so.
create function public.contact_inquiry_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'contact inquiries are retained; delete is not permitted' using errcode = '42501';
  end if;
  if (new.id, new.name, new.email, new.company, new.message, new.created_at, new.delivery_attempted_at)
     is distinct from
     (old.id, old.name, old.email, old.company, old.message, old.created_at, old.delivery_attempted_at) then
    raise exception 'contact inquiry content is immutable' using errcode = '42501';
  end if;
  if old.delivery_status <> 'pending' or new.delivery_status not in ('sent','failed') then
    raise exception 'contact delivery outcome already settled' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger contact_inquiry_guard before update or delete on public.contact_inquiries
  for each row execute function public.contact_inquiry_guard();

alter table public.contact_inquiries enable row level security;
revoke all on public.contact_inquiries from public, anon, authenticated, service_role;
grant select, insert, update on public.contact_inquiries to service_role;
create policy contact_backend_insert on public.contact_inquiries
  for insert to service_role with check (true);
create policy contact_backend_settle on public.contact_inquiries
  for update to service_role using (delivery_status = 'pending') with check (true);
-- The BFF reads back only the row it has just written; Axiom internal staff can
-- review inquiries through their user-scoped session.
create policy contact_backend_read on public.contact_inquiries
  for select to service_role using (true);
grant select on public.contact_inquiries to authenticated;
create policy contact_internal_read on public.contact_inquiries
  for select to authenticated using (
    exists (select 1 from public.users where id = auth.uid() and is_axiom_internal)
  );

commit;
