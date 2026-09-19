-- ==============================================================================
-- Axiom Proof — 0008_gap_scan_contact_phone.sql
-- Add contact_phone to gap_scan_responses table
-- ==============================================================================

alter table public.gap_scan_responses
  add column if not exists contact_phone text;
