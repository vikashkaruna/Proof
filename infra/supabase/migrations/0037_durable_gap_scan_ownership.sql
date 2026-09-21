-- Anonymous report ownership is a server-minted capability, stored hashed.
begin;
alter table public.gap_scan_responses add column access_token_hash text;
-- Keep existing cookie holders able to read their retained reports. Old cookies
-- held the session hash itself; the BFF now compares its digest, never raw proof.
update public.gap_scan_responses set access_token_hash =
  encode(sha256(convert_to(session_id,'UTF8')),'hex');
alter table public.gap_scan_responses alter column access_token_hash set not null;
alter table public.gap_scan_responses add constraint gap_scan_access_hash_format
  check (access_token_hash ~ '^[0-9a-f]{64}$');
-- Report snapshots and their authority may only be written by the BFF.
drop policy if exists gap_scan_insert_public on public.gap_scan_responses;
revoke insert, update, delete on public.gap_scan_responses from anon, authenticated;
commit;
