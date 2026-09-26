-- ─────────────────────────────────────────────────────────────────────
-- 0071_w8_breach_dsar_release.sql
--
-- W8 — rights, breach operations and the founder release gate (Revision 98).
--
-- 0006 created the dsars/breaches/reports tables, but nothing could drive
-- them through their own workflows: status columns were open to any UPDATE
-- the RLS policy allowed, no notification drafts existed, and a report could
-- go from draft to published without a captured human review. This migration
-- gives the three workflows their sanctioned write paths and locks everything
-- else out:
--
--   record_dsar / verify_dsar_identity / advance_dsar
--       The DSAR lifecycle: intake starts the statutory clock (server-owned,
--       §11/Rule 16), identity verification binds who verified and how, and
--       the status chain is closed — fulfilment needs a verified identity,
--       completion needs a fulfilment evidence artifact, rejection needs a
--       captured reason (FR-7.6). Escalation is its own recorded decision.
--   record_breach / advance_breach
--       Intake starts the 72-hour DPB clock (server-owned, §8(6)) and opens
--       a deadline compliance event; the state machine is strictly linear —
--       detection cannot skip triage and a closed breach stays closed.
--   draft_breach_notification / review_breach_notification /
--   send_breach_notification
--       W8.2's authority chain. A notification is drafted, then REVIEWED by
--       someone other than its drafter, and only then sent — by someone
--       other than its drafter. Nothing is transmitted by the platform: the
--       send records the human's own-channel dispatch with its delivery
--       outcome as evidence. Failed and deferred attempts accumulate as
--       retry evidence without ever completing the statutory fact.
--   review_report / release_report
--       W8.3 / BR-4. Unreviewed client output cannot be released: only an
--       Axiom-internal reviewer may approve (or reject, with a captured
--       reason), and only an approved report can be released — at which
--       point the released content is hashed server-side into the row so
--       what was released stays provable.
--
-- Every write is ledgered as a HUMAN action through append_ledger. The nine
-- new ledger values below join the existing dsar.received/verified/fulfilled/
-- rejected and breach.detected/notified.* values; the successful statutory
-- notifications reuse breach.notified.dpb / breach.notified.principals.
-- ─────────────────────────────────────────────────────────────────────

alter type public.ledger_action_type add value if not exists 'dsar.status.changed';
alter type public.ledger_action_type add value if not exists 'dsar.escalated';
alter type public.ledger_action_type add value if not exists 'breach.status.changed';
alter type public.ledger_action_type add value if not exists 'breach.notification.drafted';
alter type public.ledger_action_type add value if not exists 'breach.notification.reviewed';
alter type public.ledger_action_type add value if not exists 'breach.notification.attempt';
alter type public.ledger_action_type add value if not exists 'report.approved';
alter type public.ledger_action_type add value if not exists 'report.rejected';
alter type public.ledger_action_type add value if not exists 'report.released';

-- ─────────────────────────────────────────────────────────────────────
-- Breach notification drafts (W8.2). Append-only in spirit: a superseded
-- draft stays, pointing at the draft that replaced it. No delete path.
-- ─────────────────────────────────────────────────────────────────────

create type public.breach_notification_kind as enum ('dpb', 'affected_principal');
create type public.breach_notification_status as enum ('draft', 'reviewed', 'sent', 'superseded');

create table public.breach_notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- RESTRICT, not cascade: a breach's notification history must not be
  -- deletable through the breach row.
  breach_id uuid not null references public.breaches(id) on delete restrict,
  kind public.breach_notification_kind not null,
  status public.breach_notification_status not null default 'draft',
  language text not null default 'en' check (language in ('en', 'hi')),
  subject text not null check (char_length(subject) between 1 and 300),
  body text not null check (char_length(body) between 1 and 20000),
  reviewed_by uuid references public.users(id),
  reviewed_at timestamptz,
  sent_by uuid references public.users(id),
  sent_at timestamptz,
  -- The outcome of the human's own-channel dispatch (the platform never
  -- transmits); recorded as evidence on the send.
  delivery_outcome text check (delivery_outcome in ('delivered', 'failed', 'deferred')),
  delivery_attempts integer not null default 0 check (delivery_attempts between 0 and 5),
  delivery_detail jsonb not null default '[]'::jsonb check (pg_column_size(delivery_detail) <= 8192),
  superseded_by uuid references public.breach_notifications(id),
  correlation_id uuid not null,
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A draft cannot reach reviewed/sent without a recorded review, and the
  -- maker-checker rule is a fact of the row, not a convention: neither the
  -- reviewer nor the sender may be the drafter. (A draft that dies by
  -- supersession never needed review.)
  check (status in ('draft', 'superseded') or reviewed_by is not null),
  check (status <> 'sent' or (sent_by is not null and sent_at is not null and sent_by <> created_by)),
  check (reviewed_by is null or reviewed_by <> created_by)
);

create index idx_breach_notifications_tenant on public.breach_notifications(tenant_id);
create index idx_breach_notifications_breach on public.breach_notifications(breach_id);

grant select on public.breach_notifications to service_role, authenticated;

alter table public.breach_notifications enable row level security;

create policy "breach_notifications_select_member" on public.breach_notifications
  for select using (
    public.is_tenant_member(tenant_id)
    or exists (select 1 from public.users where id = auth.uid() and is_axiom_internal)
  );

-- ─────────────────────────────────────────────────────────────────────
-- The privilege wall. The workflow RPCs below are the ONLY write paths;
-- direct writes are revoked from every connecting role. (The 0006 RLS
-- modify policies become inert — no grant reaches them.)
-- Reports keep INSERT for service_role: generating a report is agent work;
-- reviewing and releasing it is not.
-- ─────────────────────────────────────────────────────────────────────

revoke insert, update, delete on public.breaches from authenticated, service_role;
revoke insert, update, delete on public.dsars from authenticated, service_role;
revoke insert, update, delete on public.breach_notifications from authenticated, service_role;
revoke update, delete on public.reports from authenticated, service_role;
revoke insert on public.reports from authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- Reports: the rejected state and its captured reason (W8.3 / FR-7.6),
-- plus the server-computed hash of what was actually released.
-- ─────────────────────────────────────────────────────────────────────

alter table public.reports
  add column rejected_by uuid references public.users(id),
  add column rejected_at timestamptz,
  add column rejection_reason text check (char_length(rejection_reason) between 1 and 2000),
  add column released_content_hash text check (released_content_hash ~ '^[0-9a-f]{64}$');

alter table public.reports drop constraint if exists reports_status_check;
alter table public.reports
  add constraint reports_status_check
  check (status in ('draft', 'approved', 'rejected', 'published', 'archived'));

-- ─────────────────────────────────────────────────────────────────────
-- W8.1 — DSAR lifecycle
-- ─────────────────────────────────────────────────────────────────────

create function public.record_dsar(
  p_tenant_id uuid,
  p_kind text,
  p_principal_name text,
  p_principal_email text,
  p_principal_phone text,
  p_due_days integer,
  p_notes text,
  p_recorded_by uuid,
  p_correlation_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_dsar_id uuid;
  v_due_by timestamptz;
begin
  if p_kind not in ('access', 'correction', 'erasure', 'nominate', 'portability') then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  -- At least one contact channel; each bounded and shaped.
  if p_principal_email is null and p_principal_phone is null then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if p_principal_email is not null and
     (char_length(p_principal_email) < 3 or char_length(p_principal_email) > 320
      or p_principal_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if p_principal_phone is not null and
     (char_length(p_principal_phone) < 6 or char_length(p_principal_phone) > 20
      or p_principal_phone !~ '^[0-9+][0-9 ()+-]+$') then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if p_principal_name is not null and
     (char_length(p_principal_name) < 1 or char_length(p_principal_name) > 200) then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if p_notes is not null and char_length(p_notes) > 2000 then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if p_due_days < 1 or p_due_days > 90 then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  -- Server-owned statutory clock.
  v_due_by := clock_timestamp() + make_interval(days => p_due_days);

  insert into public.dsars (
    tenant_id, kind, status, data_principal_name, data_principal_email,
    data_principal_phone, due_by, notes
  ) values (
    p_tenant_id, p_kind::dsar_kind, 'received', p_principal_name, p_principal_email,
    p_principal_phone, v_due_by, p_notes
  ) returning id into v_dsar_id;

  -- The deadline joins the calendar with the default reminder offsets.
  insert into public.compliance_events (tenant_id, title, description, due_at, dsar_id)
  values (
    p_tenant_id,
    left('DSAR deadline: ' || coalesce(p_principal_name, p_principal_email, p_principal_phone), 300),
    'Statutory fulfilment deadline for the ' || p_kind || ' request.',
    v_due_by,
    v_dsar_id
  );

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_recorded_by::text, null, null, null,
    'dsar.received', v_dsar_id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('kind', p_kind, 'due_by', v_due_by, 'due_days', p_due_days));

  return jsonb_build_object('dsarId', v_dsar_id, 'dueBy', v_due_by);
end $$;

create function public.verify_dsar_identity(
  p_tenant_id uuid,
  p_dsar_id uuid,
  p_method text,
  p_verified_by uuid,
  p_correlation_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_status text;
begin
  if p_method is null or char_length(p_method) < 1 or char_length(p_method) > 120 then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  select status::text into v_status from public.dsars
    where id = p_dsar_id and tenant_id = p_tenant_id;
  if v_status is null then
    return jsonb_build_object('error', 'dsar_not_found');
  end if;
  if v_status not in ('received', 'identity_verification') then
    return jsonb_build_object('error', 'invalid_transition');
  end if;

  update public.dsars set
    identity_verified = true,
    identity_verification_method = p_method,
    status = greatest(status, 'identity_verification'::dsar_status),
    updated_at = now()
  where id = p_dsar_id and tenant_id = p_tenant_id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_verified_by::text, null, null, null,
    'dsar.verified', p_dsar_id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('method', p_method, 'from_status', v_status));

  return jsonb_build_object('dsarId', p_dsar_id, 'identityVerified', true);
end $$;

create function public.advance_dsar(
  p_tenant_id uuid,
  p_dsar_id uuid,
  p_to_status text,
  p_note text,
  p_fulfilment_evidence_id uuid,
  p_advanced_by uuid,
  p_correlation_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_from text;
  v_allowed boolean;
  v_action public.ledger_action_type;
begin
  select status::text into v_from from public.dsars
    where id = p_dsar_id and tenant_id = p_tenant_id;
  if v_from is null then
    return jsonb_build_object('error', 'dsar_not_found');
  end if;

  -- The closed transition map. Fulfilment requires a verified identity;
  -- completion requires a fulfilment evidence artifact belonging to the
  -- tenant; rejection (FR-7.6) requires a captured reason.
  v_allowed :=
    (p_to_status = 'in_fulfilment' and v_from = 'identity_verification')
    or (p_to_status = 'completed' and v_from = 'in_fulfilment')
    or (p_to_status = 'rejected' and v_from in ('received', 'identity_verification', 'in_fulfilment'))
    or (p_to_status = 'escalated' and v_from in ('identity_verification', 'in_fulfilment'));
  if not v_allowed then
    return jsonb_build_object('error', 'invalid_transition');
  end if;

  if p_to_status = 'completed' then
    if p_fulfilment_evidence_id is null then
      return jsonb_build_object('error', 'fulfilment_evidence_required');
    end if;
    if not exists (
      select 1 from public.evidence
        where id = p_fulfilment_evidence_id and tenant_id = p_tenant_id
    ) then
      return jsonb_build_object('error', 'fulfilment_evidence_not_found');
    end if;
  end if;

  if p_to_status = 'rejected' and (p_note is null or char_length(p_note) = 0) then
    return jsonb_build_object('error', 'reason_required');
  end if;
  if p_note is not null and char_length(p_note) > 2000 then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  v_action := case p_to_status
    when 'completed' then 'dsar.fulfilled'::public.ledger_action_type
    when 'rejected' then 'dsar.rejected'::public.ledger_action_type
    when 'escalated' then 'dsar.escalated'::public.ledger_action_type
    else 'dsar.status.changed'::public.ledger_action_type
  end;

  update public.dsars set
    status = p_to_status::dsar_status,
    completed_at = case when p_to_status = 'completed' then clock_timestamp() else completed_at end,
    rejection_reason = case when p_to_status = 'rejected' then p_note else rejection_reason end,
    fulfillment_evidence_id = case when p_to_status = 'completed'
      then p_fulfilment_evidence_id else fulfillment_evidence_id end,
    updated_at = now()
  where id = p_dsar_id and tenant_id = p_tenant_id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_advanced_by::text, null, null, null,
    v_action, p_dsar_id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('from', v_from, 'to', p_to_status,
      'fulfilment_evidence_id', p_fulfilment_evidence_id));

  return jsonb_build_object('dsarId', p_dsar_id, 'status', p_to_status);
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- W8.2 — breach intake, the linear state machine, and the notification
-- authority chain
-- ─────────────────────────────────────────────────────────────────────

create function public.record_breach(
  p_tenant_id uuid,
  p_title text,
  p_description text,
  p_severity text,
  p_occurred_at timestamptz,
  p_data_categories text[],
  p_affected_count integer,
  p_reported_by uuid,
  p_correlation_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_breach_id uuid;
  v_due_by timestamptz;
begin
  if p_title is null or char_length(p_title) < 1 or char_length(p_title) > 300 then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if p_description is null or char_length(p_description) < 1 or char_length(p_description) > 5000 then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if p_severity not in ('low', 'medium', 'high', 'critical') then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if p_occurred_at is not null and p_occurred_at > clock_timestamp() then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if array_length(p_data_categories, 1) > 20 then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if exists (select 1 from unnest(p_data_categories) c
             where c is null or char_length(c) < 1 or char_length(c) > 100) then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if p_affected_count is not null and p_affected_count < 0 then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  -- Server-owned 72-hour clock from awareness (§8(6)).
  v_due_by := clock_timestamp() + interval '72 hours';

  insert into public.breaches (
    tenant_id, title, description, severity, status, occurred_at, detected_at,
    dpb_notification_due_by, affected_count, data_categories, owner_id
  ) values (
    p_tenant_id, p_title, p_description, p_severity::breach_severity, 'detected',
    p_occurred_at, clock_timestamp(), v_due_by, p_affected_count, p_data_categories,
    p_reported_by
  ) returning id into v_breach_id;

  insert into public.compliance_events (tenant_id, title, description, due_at, breach_id)
  values (
    p_tenant_id,
    left('DPB notification deadline: ' || p_title, 300),
    '72-hour Data Protection Board notification deadline.',
    v_due_by,
    v_breach_id
  );

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_reported_by::text, null, null, null,
    'breach.detected', v_breach_id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('severity', p_severity, 'dpb_notification_due_by', v_due_by,
      'occurred_at', p_occurred_at));

  return jsonb_build_object('breachId', v_breach_id, 'dpbNotificationDueBy', v_due_by);
end $$;

create function public.advance_breach(
  p_tenant_id uuid,
  p_breach_id uuid,
  p_to_status text,
  p_note text,
  p_advanced_by uuid,
  p_correlation_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_from text;
  v_allowed boolean;
begin
  select status::text into v_from from public.breaches
    where id = p_breach_id and tenant_id = p_tenant_id;
  if v_from is null then
    return jsonb_build_object('error', 'breach_not_found');
  end if;

  -- Strictly linear: detection cannot skip triage, a closed breach stays
  -- closed, and there are no backward moves.
  v_allowed :=
    (v_from = 'detected' and p_to_status = 'triaging')
    or (v_from = 'triaging' and p_to_status = 'contained')
    or (v_from = 'contained' and p_to_status = 'notifying_dpb')
    or (v_from = 'notifying_dpb' and p_to_status = 'notifying_principals')
    or (v_from = 'notifying_principals' and p_to_status = 'post_mortem')
    or (v_from = 'post_mortem' and p_to_status = 'closed');
  if not v_allowed then
    return jsonb_build_object('error', 'invalid_transition');
  end if;
  if p_note is not null and char_length(p_note) > 2000 then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  update public.breaches set status = p_to_status::breach_status, updated_at = now()
    where id = p_breach_id and tenant_id = p_tenant_id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_advanced_by::text, null, null, null,
    'breach.status.changed', p_breach_id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('from', v_from, 'to', p_to_status, 'note', p_note));

  return jsonb_build_object('breachId', p_breach_id, 'status', p_to_status);
end $$;

create function public.draft_breach_notification(
  p_tenant_id uuid,
  p_breach_id uuid,
  p_kind text,
  p_language text,
  p_subject text,
  p_body text,
  p_created_by uuid,
  p_correlation_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_notification_id uuid;
  v_status text;
begin
  if p_kind not in ('dpb', 'affected_principal') then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if p_language not in ('en', 'hi') then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if p_subject is null or char_length(p_subject) < 1 or char_length(p_subject) > 300 then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if p_body is null or char_length(p_body) < 1 or char_length(p_body) > 20000 then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  select status::text into v_status from public.breaches
    where id = p_breach_id and tenant_id = p_tenant_id;
  if v_status is null then
    return jsonb_build_object('error', 'breach_not_found');
  end if;
  if v_status = 'closed' then
    return jsonb_build_object('error', 'breach_closed');
  end if;

  -- One live draft per (breach, kind): the insert first, then earlier
  -- unsent drafts are superseded — pointed at their replacement, never
  -- deleted, so the revision chain stays in the table.
  insert into public.breach_notifications (
    tenant_id, breach_id, kind, status, language, subject, body, correlation_id, created_by
  ) values (
    p_tenant_id, p_breach_id, p_kind::breach_notification_kind, 'draft', p_language,
    p_subject, p_body, p_correlation_id, p_created_by
  ) returning id into v_notification_id;

  update public.breach_notifications
    set status = 'superseded', superseded_by = v_notification_id, updated_at = now()
    where breach_id = p_breach_id and tenant_id = p_tenant_id
      and kind = p_kind::breach_notification_kind
      and status in ('draft', 'reviewed')
      and id <> v_notification_id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_created_by::text, null, null, null,
    'breach.notification.drafted', v_notification_id::text, null, null, null, null, null,
    null, 'success',
    jsonb_build_object('breach_id', p_breach_id, 'kind', p_kind, 'language', p_language));

  return jsonb_build_object('notificationId', v_notification_id);
end $$;

create function public.review_breach_notification(
  p_tenant_id uuid,
  p_notification_id uuid,
  p_reviewed_by uuid,
  p_correlation_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_created_by uuid;
begin
  select status::text, created_by into v_status, v_created_by
    from public.breach_notifications
    where id = p_notification_id and tenant_id = p_tenant_id;
  if v_status is null then
    return jsonb_build_object('error', 'notification_not_found');
  end if;
  if v_status <> 'draft' then
    return jsonb_build_object('error', 'not_reviewable');
  end if;
  -- W8.2: review authority is a second human, never the drafter.
  if p_reviewed_by = v_created_by then
    return jsonb_build_object('error', 'self_review_forbidden');
  end if;

  update public.breach_notifications
    set status = 'reviewed', reviewed_by = p_reviewed_by,
      reviewed_at = clock_timestamp(), updated_at = now()
    where id = p_notification_id and tenant_id = p_tenant_id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_reviewed_by::text, null, null, null,
    'breach.notification.reviewed', p_notification_id::text, null, null, null, null, null,
    null, 'success',
    jsonb_build_object('breach_id', p_notification_id));

  return jsonb_build_object('notificationId', p_notification_id, 'status', 'reviewed');
end $$;

create function public.send_breach_notification(
  p_tenant_id uuid,
  p_notification_id uuid,
  p_outcome text,
  p_detail jsonb,
  p_sent_by uuid,
  p_correlation_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_created_by uuid;
  v_kind text;
  v_breach_id uuid;
  v_attempts integer;
  v_detail jsonb;
begin
  if p_outcome not in ('delivered', 'failed', 'deferred') then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if pg_column_size(p_detail) > 4096 then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  select status::text, created_by, kind::text, breach_id, delivery_attempts, delivery_detail
    into v_status, v_created_by, v_kind, v_breach_id, v_attempts, v_detail
    from public.breach_notifications
    where id = p_notification_id and tenant_id = p_tenant_id;
  if v_status is null then
    return jsonb_build_object('error', 'notification_not_found');
  end if;
  -- A send requires a completed review by a second human, and the sender
  -- must not be the drafter.
  if v_status <> 'reviewed' then
    return jsonb_build_object('error', 'not_reviewed');
  end if;
  if p_sent_by = v_created_by then
    return jsonb_build_object('error', 'self_send_forbidden');
  end if;

  -- Every attempt is evidence. A failed or deferred attempt keeps the
  -- notification in reviewed for a retry; the statutory fact is only
  -- recorded by a delivered send. The cap is checked BEFORE the counter
  -- moves, so the refusal is a decision, not a constraint violation.
  if v_attempts >= 5 then
    perform public.append_ledger(
      p_tenant_id, p_correlation_id, 'human', p_sent_by::text, null, null, null,
      'breach.notification.attempt', p_notification_id::text, null, null, null, null, null,
      null, 'failure',
      jsonb_build_object('outcome', p_outcome, 'refused', 'too_many_attempts'));
    return jsonb_build_object('error', 'too_many_attempts');
  end if;

  v_detail := v_detail || jsonb_build_array(jsonb_build_object(
    'at', clock_timestamp(), 'outcome', p_outcome, 'by', p_sent_by, 'detail', p_detail));

  update public.breach_notifications
    set delivery_attempts = delivery_attempts + 1,
      delivery_detail = v_detail,
      updated_at = now()
    where id = p_notification_id and tenant_id = p_tenant_id;

  if p_outcome <> 'delivered' then
    perform public.append_ledger(
      p_tenant_id, p_correlation_id, 'human', p_sent_by::text, null, null, null,
      'breach.notification.attempt', p_notification_id::text, null, null, null, null, null,
      null, 'success',
      jsonb_build_object('outcome', p_outcome, 'attempt', v_attempts + 1, 'detail', p_detail));
    return jsonb_build_object('notificationId', p_notification_id,
      'deliveryAttempts', v_attempts + 1, 'status', 'reviewed');
  end if;

  update public.breach_notifications
    set status = 'sent', sent_by = p_sent_by, sent_at = clock_timestamp(),
      delivery_outcome = 'delivered', updated_at = now()
    where id = p_notification_id and tenant_id = p_tenant_id;

  -- The statutory timestamps on the breach: first delivered send wins.
  if v_kind = 'dpb' then
    update public.breaches set dpb_notified_at = clock_timestamp(), updated_at = now()
      where id = v_breach_id and dpb_notified_at is null;
  else
    update public.breaches set principals_notified_at = clock_timestamp(), updated_at = now()
      where id = v_breach_id and principals_notified_at is null;
  end if;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_sent_by::text, null, null, null,
    case v_kind when 'dpb' then 'breach.notified.dpb'::public.ledger_action_type
      else 'breach.notified.principals'::public.ledger_action_type end,
    p_notification_id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('breach_id', v_breach_id, 'attempt', v_attempts + 1,
      'delivery_detail', p_detail));

  return jsonb_build_object('notificationId', p_notification_id, 'status', 'sent');
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- W8.3 / BR-4 — the founder review and release gate
-- ─────────────────────────────────────────────────────────────────────

create function public.review_report(
  p_tenant_id uuid,
  p_report_id uuid,
  p_decision text,
  p_note text,
  p_reviewed_by uuid,
  p_correlation_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_internal boolean;
begin
  if p_decision not in ('approved', 'rejected') then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  if p_note is not null and char_length(p_note) > 2000 then
    return jsonb_build_object('error', 'invalid_request');
  end if;
  -- BR-4: review is the founder's (Axiom-internal) authority, verified
  -- against the users table — the BFF calls as the service connection,
  -- so there is no user JWT to read.
  select is_axiom_internal into v_internal from public.users where id = p_reviewed_by;
  if v_internal is null or not v_internal then
    return jsonb_build_object('error', 'founder_authority_required');
  end if;
  select status::text into v_status from public.reports
    where id = p_report_id and tenant_id = p_tenant_id;
  if v_status is null then
    return jsonb_build_object('error', 'report_not_found');
  end if;
  if v_status <> 'draft' then
    return jsonb_build_object('error', 'not_reviewable');
  end if;
  if p_decision = 'rejected' and (p_note is null or char_length(p_note) = 0) then
    return jsonb_build_object('error', 'reason_required');
  end if;

  update public.reports set
    status = p_decision,
    reviewed_by = p_reviewed_by,
    reviewed_at = clock_timestamp(),
    approved_at = case when p_decision = 'approved' then clock_timestamp() else approved_at end,
    rejected_by = case when p_decision = 'rejected' then p_reviewed_by else rejected_by end,
    rejected_at = case when p_decision = 'rejected' then clock_timestamp() else rejected_at end,
    rejection_reason = case when p_decision = 'rejected' then p_note else rejection_reason end
  where id = p_report_id and tenant_id = p_tenant_id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_reviewed_by::text, null, null, null,
    case p_decision when 'approved' then 'report.approved'::public.ledger_action_type
      else 'report.rejected'::public.ledger_action_type end,
    p_report_id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('decision', p_decision, 'note', p_note));

  return jsonb_build_object('reportId', p_report_id, 'status', p_decision);
end $$;

create function public.release_report(
  p_tenant_id uuid,
  p_report_id uuid,
  p_released_by uuid,
  p_correlation_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_internal boolean;
  v_hash text;
begin
  select is_axiom_internal into v_internal from public.users where id = p_released_by;
  if v_internal is null or not v_internal then
    return jsonb_build_object('error', 'founder_authority_required');
  end if;
  select status::text into v_status from public.reports
    where id = p_report_id and tenant_id = p_tenant_id;
  if v_status is null then
    return jsonb_build_object('error', 'report_not_found');
  end if;
  -- BR-4 in one line: unreviewed (or rejected) output cannot be released.
  if v_status <> 'approved' then
    return jsonb_build_object('error', 'not_approved');
  end if;

  -- The hash of exactly what was released, computed server-side over the
  -- structured content.
  select encode(digest(content::text, 'sha256'), 'hex') into v_hash
    from public.reports where id = p_report_id and tenant_id = p_tenant_id;

  update public.reports set
    status = 'published', published_at = clock_timestamp(),
    released_content_hash = v_hash
  where id = p_report_id and tenant_id = p_tenant_id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'human', p_released_by::text, null, null, null,
    'report.released', p_report_id::text, null, null, null, null, null, null, 'success',
    jsonb_build_object('content_hash', v_hash));

  return jsonb_build_object('reportId', p_report_id, 'status', 'published',
    'contentHash', v_hash);
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- Execute is the BFF's service connection only.
-- ─────────────────────────────────────────────────────────────────────

revoke all on function
  public.record_dsar(uuid, text, text, text, text, integer, text, uuid, uuid),
  public.verify_dsar_identity(uuid, uuid, text, uuid, uuid),
  public.advance_dsar(uuid, uuid, text, text, uuid, uuid, uuid),
  public.record_breach(uuid, text, text, text, timestamptz, text[], integer, uuid, uuid),
  public.advance_breach(uuid, uuid, text, text, uuid, uuid),
  public.draft_breach_notification(uuid, uuid, text, text, text, text, uuid, uuid),
  public.review_breach_notification(uuid, uuid, uuid, uuid),
  public.send_breach_notification(uuid, uuid, text, jsonb, uuid, uuid),
  public.review_report(uuid, uuid, text, text, uuid, uuid),
  public.release_report(uuid, uuid, uuid, uuid)
from public;

grant execute on function
  public.record_dsar(uuid, text, text, text, text, integer, text, uuid, uuid),
  public.verify_dsar_identity(uuid, uuid, text, uuid, uuid),
  public.advance_dsar(uuid, uuid, text, text, uuid, uuid, uuid),
  public.record_breach(uuid, text, text, text, timestamptz, text[], integer, uuid, uuid),
  public.advance_breach(uuid, uuid, text, text, uuid, uuid),
  public.draft_breach_notification(uuid, uuid, text, text, text, text, uuid, uuid),
  public.review_breach_notification(uuid, uuid, uuid, uuid),
  public.send_breach_notification(uuid, uuid, text, jsonb, uuid, uuid),
  public.review_report(uuid, uuid, text, text, uuid, uuid),
  public.release_report(uuid, uuid, uuid, uuid)
to service_role;
