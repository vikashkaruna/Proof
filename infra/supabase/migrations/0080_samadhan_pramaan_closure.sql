-- ─────────────────────────────────────────────────────────────────────
-- 0080_samadhan_pramaan_closure.sql
--
-- Phase 0–5 Gap Closure Extension: Samadhan & Pramaan Architecture
--
-- 1. Adds ledger action types:
--      - 'closure.pramaan.drafted'
--      - 'closure.pramaan.sealed'
--      - 'report.dispatched.email'
-- 2. Formalizes Samadhan (Maker-Checker & Reconciler Agent):
--      - Adds reconciled_by_agent to public.plan_reconciliations
--      - Updates record_plan_reconciliation to attribute 'samadhan'
-- 3. Creates public.pramaan_dossiers table:
--      - Tracks comprehensive statutory closure dossiers synthesized by Pramaan
--      - Stores Merkle root, manifest hash, archive hash, and Gold ProofSeal hash
--      - Supports board_executive, dpb_statutory, auditor_assurance, technical_register, full_closure
-- 4. Creates public.report_email_dispatches table:
--      - Audit log for reports and dossiers sent via email
--      - Mandates verified sender 'platform@axiomproof.ai', CC 'sales@axiomproof.ai', BCC 'founder@axiomminds.ai'
-- 5. RPCs:
--      - seal_pramaan_dossier
--      - record_report_email_dispatch
-- ─────────────────────────────────────────────────────────────────────

alter type public.ledger_action_type add value if not exists 'closure.pramaan.drafted';
alter type public.ledger_action_type add value if not exists 'closure.pramaan.sealed';
alter type public.ledger_action_type add value if not exists 'report.dispatched.email';

-- ─── 1. Formalize Samadhan on plan_reconciliations ───────────────────

alter table public.plan_reconciliations
  add column if not exists reconciled_by_agent text not null default 'samadhan'
  check (reconciled_by_agent in ('samadhan', 'reconciler'));

create or replace function public.record_plan_reconciliation(
  p_tenant_id uuid,
  p_plan_id uuid,
  p_batch_id uuid,
  p_correlation_id uuid,
  p_statement text,
  p_statement_signature text
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  b public.execution_batches;
  t public.approval_tokens;
  v_out_of_scope jsonb;
  v_unexecuted jsonb;
  v_drift boolean;
  v_digest text;
  v_verification jsonb;
begin
  if p_statement is null or length(p_statement) = 0 or length(p_statement) > 8192
     or p_statement_signature is null
     or p_statement_signature !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('error', 'invalid_record');
  end if;

  select * into b from public.execution_batches
    where tenant_id = p_tenant_id and id = p_batch_id and plan_id = p_plan_id;
  if not found then
    return jsonb_build_object('error', 'batch_not_found');
  end if;
  if b.finished_at is null then
    return jsonb_build_object('error', 'batch_not_finished');
  end if;

  -- The approved scope comes from the token row itself, never from the caller.
  select * into t from public.approval_tokens
    where tenant_id = p_tenant_id and id = b.approval_token_id;

  -- Out-of-scope execution is computed here, not asserted by the caller:
  -- any action this batch touched that the token did not cover is a
  -- structural defect, and the record is refused so it screams.
  select coalesce(jsonb_agg(id::text), '[]'::jsonb) into v_out_of_scope
    from public.remediation_actions
   where execution_batch_id = b.id
     and (t.action_ids is null or not (t.action_ids @> array[id]));
  if jsonb_array_length(v_out_of_scope) > 0 then
    return jsonb_build_object('error', 'out_of_scope_executed', 'action_ids', v_out_of_scope);
  end if;

  -- Unexecuted: actions the batch held but never settled (swept back to
  -- approved — retryable only under a fresh approval).
  select coalesce(jsonb_agg(jsonb_build_object(
           'action_id', id::text, 'reason', 'swept_unexecuted')), '[]'::jsonb)
    into v_unexecuted
    from public.remediation_actions
   where execution_batch_id = b.id and final_outcome is null;

  -- Parameter-level check: the approved snapshot was the batch's content
  -- digest, computed over the token's approved action set; recompute it
  -- now over that same set. A mismatch means approved content changed —
  -- before or after execution — and the statement says so.
  v_digest := public.action_set_content_digest(p_tenant_id, p_plan_id, t.action_ids);
  v_drift := v_digest is distinct from b.content_digest;

  select coalesce(jsonb_object_agg(id::text, coalesce(final_outcome::text, 'unexecuted')), '{}'::jsonb)
    into v_verification
    from public.remediation_actions where execution_batch_id = b.id;

  insert into public.plan_reconciliations(tenant_id, plan_id, batch_id,
    approved_scope, executed_reality, unexecuted, parameter_diffs, verification_outcomes,
    statement, statement_signature, reconciled_by_agent)
  values (p_tenant_id, p_plan_id, b.id,
    jsonb_build_object('token_id', t.id, 'nonce', t.nonce, 'action_ids', to_jsonb(t.action_ids),
      'content_digest', b.content_digest),
    jsonb_build_object('batch_status', b.status, 'succeeded_at_finish',
      (select count(*) from public.remediation_actions
        where execution_batch_id = b.id and final_outcome = 'succeeded'),
      'failed_at_finish',
      (select count(*) from public.remediation_actions
        where execution_batch_id = b.id and final_outcome = 'failed'),
      'rolled_back',
      (select count(*) from public.remediation_actions
        where execution_batch_id = b.id and final_outcome = 'rolled_back'),
      'content_digest_recomputed', v_digest),
    v_unexecuted,
    (case when v_drift
      then jsonb_build_array(jsonb_build_object('kind', 'content_digest_drift',
             'approved', b.content_digest, 'recomputed', v_digest))
      else '[]'::jsonb end),
    v_verification,
    p_statement, p_statement_signature, 'samadhan');

  -- Attributed explicitly to Samadhan Agent
  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'agent', 'samadhan', null, null, null,
    'execution.reconciliation.recorded', p_plan_id::text, null, null, null, null, null, null,
    (case when jsonb_array_length(v_unexecuted) = 0 and not v_drift
      then 'success' else 'skipped' end)::public.ledger_result,
    jsonb_build_object('batch_id', b.id, 'batch_status', b.status,
      'reconciled_by_agent', 'samadhan',
      'unexecuted', jsonb_array_length(v_unexecuted), 'content_digest_drift', v_drift,
      'statement_sha256', encode(sha256(convert_to(p_statement, 'UTF8')), 'hex')));

  return jsonb_build_object('reconciliation', jsonb_build_object(
    'unexecuted', jsonb_array_length(v_unexecuted), 'content_digest_drift', v_drift));
end $$;

-- ─── 2. Pramaan Dossiers Table (Statutory Closure) ───────────────────

create table if not exists public.pramaan_dossiers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  engagement_id uuid not null references public.engagements(id) on delete restrict,
  report_id uuid references public.reports(id) on delete set null,
  dossier_type text not null check (dossier_type in (
    'board_executive', 'dpb_statutory', 'auditor_assurance', 'technical_register', 'full_closure'
  )),
  title text not null check (length(title) between 1 and 300),
  status text not null default 'draft' check (status in ('draft', 'approved', 'sealed', 'rejected')),
  merkle_root text not null check (merkle_root ~ '^[0-9a-f]{64}$'),
  manifest_hash text not null check (manifest_hash ~ '^[0-9a-f]{64}$'),
  archive_hash text check (archive_hash is null or archive_hash ~ '^[0-9a-f]{64}$'),
  archive_bytes bigint check (archive_bytes is null or archive_bytes between 1 and 67108864),
  proof_seal_hash text not null check (proof_seal_hash ~ '^[0-9a-f]{64}$'),
  sealed_at timestamptz,
  sealed_by uuid references public.users(id),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, id)
);

create index if not exists idx_pramaan_dossiers_tenant on public.pramaan_dossiers(tenant_id, created_at desc);
create index if not exists idx_pramaan_dossiers_engagement on public.pramaan_dossiers(tenant_id, engagement_id);

alter table public.pramaan_dossiers enable row level security;
revoke all on public.pramaan_dossiers from public, anon, authenticated, service_role;
grant select, insert, update on public.pramaan_dossiers to service_role;
grant select on public.pramaan_dossiers to authenticated;

create policy pramaan_dossiers_tenant_select on public.pramaan_dossiers
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
  );

create policy pramaan_dossiers_service_all on public.pramaan_dossiers
  for all to service_role using (true) with check (true);

-- ─── 3. Report & Dossier Email Dispatches Table ───────────────────────

create table if not exists public.report_email_dispatches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  report_id uuid references public.reports(id) on delete cascade,
  dossier_id uuid references public.pramaan_dossiers(id) on delete cascade,
  recipient_email text not null check (length(recipient_email) between 3 and 255),
  sender_email text not null default 'platform@axiomproof.ai' check (sender_email = 'platform@axiomproof.ai'),
  cc_email text default 'sales@axiomproof.ai',
  bcc_email text default 'founder@axiomminds.ai',
  subject text not null check (length(subject) between 1 and 500),
  delivery_status text not null default 'queued' check (delivery_status in ('queued', 'sent', 'failed')),
  external_message_id text check (external_message_id is null or length(external_message_id) <= 255),
  dispatched_by uuid not null references public.users(id),
  dispatched_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, id)
);

create index if not exists idx_report_email_tenant on public.report_email_dispatches(tenant_id, dispatched_at desc);

alter table public.report_email_dispatches enable row level security;
revoke all on public.report_email_dispatches from public, anon, authenticated, service_role;
grant select, insert, update on public.report_email_dispatches to service_role;
grant select on public.report_email_dispatches to authenticated;

create policy report_email_tenant_select on public.report_email_dispatches
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
  );

create policy report_email_service_all on public.report_email_dispatches
  for all to service_role using (true) with check (true);

-- ─── 4. RPCs for Dossier Sealing & Email Dispatch ───────────────────

create or replace function public.seal_pramaan_dossier(
  p_tenant_id uuid,
  p_dossier_id uuid,
  p_sealed_by uuid,
  p_expected_proof_seal text,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_dossier public.pramaan_dossiers;
  v_is_internal boolean;
begin
  if p_expected_proof_seal is null or p_expected_proof_seal !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('error', 'invalid_proof_seal');
  end if;

  select is_axiom_internal into v_is_internal from public.users where id = p_sealed_by;
  if v_is_internal is null or not v_is_internal then
    return jsonb_build_object('error', 'founder_authority_required');
  end if;

  select * into v_dossier from public.pramaan_dossiers
    where tenant_id = p_tenant_id and id = p_dossier_id for update;
  if not found then
    return jsonb_build_object('error', 'dossier_not_found');
  end if;

  if v_dossier.status = 'sealed' then
    return jsonb_build_object('error', 'already_sealed');
  end if;

  if v_dossier.proof_seal_hash <> p_expected_proof_seal then
    return jsonb_build_object('error', 'proof_seal_mismatch');
  end if;

  update public.pramaan_dossiers set
    status = 'sealed',
    sealed_at = clock_timestamp(),
    sealed_by = p_sealed_by,
    updated_at = clock_timestamp()
  where tenant_id = p_tenant_id and id = p_dossier_id;

  -- Append to immutable audit ledger
  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'agent', 'pramaan', null, null, null,
    'closure.pramaan.sealed'::public.ledger_action_type,
    p_dossier_id::text, null, null, null, null, null, null,
    'success'::public.ledger_result,
    jsonb_build_object(
      'dossier_id', p_dossier_id,
      'engagement_id', v_dossier.engagement_id,
      'dossier_type', v_dossier.dossier_type,
      'merkle_root', v_dossier.merkle_root,
      'manifest_hash', v_dossier.manifest_hash,
      'proof_seal_hash', p_expected_proof_seal,
      'sealed_by', p_sealed_by
    )
  );

  return jsonb_build_object('dossierId', p_dossier_id, 'status', 'sealed', 'sealedAt', clock_timestamp());
end $$;

revoke all on function public.seal_pramaan_dossier(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.seal_pramaan_dossier(uuid, uuid, uuid, text, uuid) to service_role;

create or replace function public.record_report_email_dispatch(
  p_tenant_id uuid,
  p_report_id uuid,
  p_dossier_id uuid,
  p_recipient_email text,
  p_subject text,
  p_external_id text,
  p_dispatched_by uuid,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_dispatch_id uuid;
begin
  if p_recipient_email is null or length(p_recipient_email) < 3 or length(p_recipient_email) > 255
     or p_subject is null or length(p_subject) < 1 or length(p_subject) > 500 then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  insert into public.report_email_dispatches (
    tenant_id, report_id, dossier_id, recipient_email, subject,
    delivery_status, external_message_id, dispatched_by
  ) values (
    p_tenant_id, p_report_id, p_dossier_id, p_recipient_email, p_subject,
    'sent', p_external_id, p_dispatched_by
  ) returning id into v_dispatch_id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_dispatched_by::text, null, null, null,
    'report.dispatched.email'::public.ledger_action_type,
    coalesce(p_dossier_id, p_report_id)::text, null, null, null, null, null, null,
    'success'::public.ledger_result,
    jsonb_build_object(
      'dispatch_id', v_dispatch_id,
      'recipient', p_recipient_email,
      'sender', 'platform@axiomproof.ai',
      'external_id', p_external_id
    )
  );

  return jsonb_build_object('dispatchId', v_dispatch_id, 'status', 'sent');
end $$;

revoke all on function public.record_report_email_dispatch(uuid, uuid, uuid, text, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_report_email_dispatch(uuid, uuid, uuid, text, text, text, uuid, uuid) to service_role;
