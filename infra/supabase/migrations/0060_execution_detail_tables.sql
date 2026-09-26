-- ─────────────────────────────────────────────────────────────────────
-- 0060_execution_detail_tables.sql
--
-- W5 · Phase 3 execution loop, foundation slice. Doc 11 (W2) lists five
-- execution-detail tables; this migration creates all five and the first
-- write path, `record_dry_run`, which is the M3.2 dry-run engine's only
-- write path. The remaining write paths land with the slices that need
-- them: the executor (execution_batches), the rollback engine
-- (rollback_executions), the verification agent (verification_results)
-- and the maker-checker reconciler (plan_reconciliations).
--
-- Normalisation is deliberate (Doc 11 W2 / R-02): `remediation_actions`
-- keeps its inline status columns because the approval and claim gates
-- read them, but the full record of each dry run, batch, rollback and
-- verification now lives in exactly one place, linked from the action.
-- The inline `dry_run_result` becomes a display cache of the latest
-- dry run's diff, written only by `record_dry_run` alongside
-- `latest_dry_run_id`; the `dry_runs` row is the source of record.
--
-- Every table is tenant-bound with row-level security, composite
-- tenant-consistent foreign keys, and no direct write path: writes go
-- through SECURITY DEFINER functions granted to service_role only,
-- following the 0059 pattern.
-- ─────────────────────────────────────────────────────────────────────

-- Composite tenant-consistent foreign keys need these constraints. They
-- are redundant with the primary keys and cost one index each.
alter table public.remediation_actions
  add constraint remediation_actions_tenant_id_key unique (tenant_id, id);
alter table public.remediation_plans
  add constraint remediation_plans_tenant_id_key unique (tenant_id, id);
alter table public.approval_tokens
  add constraint approval_tokens_tenant_id_key unique (tenant_id, id);

-- A dry run: the M3.2 simulator's structured before/after for one action,
-- or its refusal. Append-only: refusals are kept, so an auditor can see
-- that an action was refused simulation and had to be routed to manual
-- handling (Doc 04 §3.2) rather than quietly retried.
create table public.dry_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  action_id uuid not null,
  plan_id uuid not null,
  status text not null check (status in ('succeeded', 'refused', 'failed')),
  -- The structured diff (Doc 04 §3.2): before/after objects, not prose.
  -- Present only when the simulator could render one.
  diff jsonb check (
    diff is null or (
      jsonb_typeof(diff) = 'object'
      and jsonb_typeof(diff->'changes') = 'array'
      and octet_length(diff::text) <= 262144
    )
  ),
  -- Machine-readable refusal code (e.g. 'action_type_not_simulable').
  -- Prose is never a substitute for a diff, and a refusal is never silent.
  refusal_reason text check (refusal_reason is null or refusal_reason ~ '^[a-z0-9_]{1,80}$'),
  renderable boolean not null,
  -- Content binding: sha256 over the canonical stored parameters and
  -- rollback definition this run simulated, computed server-side by
  -- record_dry_run. A dry run answers for exactly the content it ran on.
  parameters_hash text not null check (parameters_hash ~ '^[0-9a-f]{64}$'),
  rollback_definition_hash text not null check (rollback_definition_hash ~ '^[0-9a-f]{64}$'),
  simulated_by text not null default 'sudhaar' check (length(simulated_by) <= 64),
  correlation_id uuid not null,
  -- The TTL (Doc 11 W5.1). A stale dry-run cannot back an approval
  -- (FR-6.3); the record and the action's freshness gate expire together.
  -- 24 hours, fixed: a change to it is a migration, not a caller's knob.
  expires_at timestamptz not null default now() + interval '24 hours',
  created_at timestamptz not null default now(),
  -- Outcome shape: a success carries a rendered diff and no refusal; a
  -- refusal or failure carries a reason and never a diff.
  constraint dry_runs_outcome_shape check (
    (status = 'succeeded' and diff is not null and renderable and refusal_reason is null)
    or (status <> 'succeeded' and diff is null and not renderable and refusal_reason is not null)
  ),
  unique (tenant_id, id),
  foreign key (tenant_id, action_id) references public.remediation_actions(tenant_id, id) on delete restrict,
  foreign key (tenant_id, plan_id) references public.remediation_plans(tenant_id, id) on delete restrict
);
create index dry_runs_action_latest on public.dry_runs(tenant_id, action_id, created_at desc);
create index dry_runs_plan_latest on public.dry_runs(tenant_id, plan_id, created_at desc);
alter table public.dry_runs enable row level security;
revoke all on public.dry_runs from public, anon, authenticated, service_role;
grant select on public.dry_runs to service_role, authenticated;
create policy bff_service_read on public.dry_runs for select to service_role using (true);
create policy tenant_member_read on public.dry_runs for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- One batch: the execution of one claimed approval under one dispatch.
-- R-04: batch/request keys stay separate from action keys — the request
-- key is the BFF's dispatch intent key, already unique per tenant and
-- plan in execution_dispatch_outbox (0020), and no action key appears
-- here. The row is written by the executor slice's RPC, not the BFF.
create table public.execution_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  plan_id uuid not null,
  request_key text not null check (length(request_key) between 1 and 200),
  correlation_id uuid not null,
  approval_token_id uuid not null,
  -- The content snapshot digest the batch was authorised for (0028). The
  -- executor recomputes before it mutates anything.
  content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  mode text not null check (mode in ('batch', 'individual')),
  concurrency integer not null check (concurrency between 1 and 100),
  stop_on_failure boolean not null,
  status text not null default 'dispatched' check (status in (
    'dispatched', 'running', 'completed', 'partial_failure', 'failed', 'halted', 'rolled_back')),
  dispatch_reference text check (dispatch_reference is null or length(dispatch_reference) <= 200),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint execution_batches_open_shape check (
    (finished_at is null) = (status in ('dispatched', 'running'))
  ),
  unique (tenant_id, id),
  unique (tenant_id, request_key),
  foreign key (tenant_id, plan_id) references public.remediation_plans(tenant_id, id) on delete restrict,
  foreign key (tenant_id, approval_token_id) references public.approval_tokens(tenant_id, id) on delete restrict
);
create index execution_batches_plan_latest on public.execution_batches(tenant_id, plan_id, started_at desc);
alter table public.execution_batches enable row level security;
revoke all on public.execution_batches from public, anon, authenticated, service_role;
grant select on public.execution_batches to service_role, authenticated;
create policy bff_service_read on public.execution_batches for select to service_role using (true);
create policy tenant_member_read on public.execution_batches for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- One rollback execution (M3.5): the engine executes Sudhaar's stored
-- definition, snapshotted here exactly as executed, never one
-- reconstructed after the fact.
create table public.rollback_executions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  action_id uuid not null,
  batch_id uuid,
  definition jsonb not null check (
    jsonb_typeof(definition) = 'object' and octet_length(definition::text) <= 262144
  ),
  definition_hash text not null check (definition_hash ~ '^[0-9a-f]{64}$'),
  triggered_by text not null check (triggered_by in ('failure_threshold', 'manual', 'governor', 'verification')),
  status text not null check (status in ('succeeded', 'failed', 'partial')),
  result jsonb check (result is null or octet_length(result::text) <= 262144),
  executed_by_agent text not null default 'karya' check (length(executed_by_agent) <= 64),
  correlation_id uuid not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, action_id) references public.remediation_actions(tenant_id, id) on delete restrict,
  foreign key (tenant_id, batch_id) references public.execution_batches(tenant_id, id) on delete restrict
);
create index rollback_executions_action_latest on public.rollback_executions(tenant_id, action_id, started_at desc);
alter table public.rollback_executions enable row level security;
revoke all on public.rollback_executions from public, anon, authenticated, service_role;
grant select on public.rollback_executions to service_role, authenticated;
create policy bff_service_read on public.rollback_executions for select to service_role using (true);
create policy tenant_member_read on public.rollback_executions for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- One verification result (M3.7): the checks Parikshan re-ran after an
-- action executed, and whether the gap actually closed. Metadata and
-- check outcomes; raw estate values stay in the evidence vault.
create table public.verification_results (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  action_id uuid not null,
  batch_id uuid,
  checks jsonb not null check (
    jsonb_typeof(checks) = 'array' and octet_length(checks::text) <= 262144
  ),
  outcome text not null check (outcome in ('passed', 'failed')),
  evidence_uri text check (evidence_uri is null or length(evidence_uri) <= 512),
  verified_by_agent text not null default 'parikshan' check (length(verified_by_agent) <= 64),
  correlation_id uuid not null,
  verified_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, action_id) references public.remediation_actions(tenant_id, id) on delete restrict,
  foreign key (tenant_id, batch_id) references public.execution_batches(tenant_id, id) on delete restrict
);
create index verification_results_action_latest on public.verification_results(tenant_id, action_id, verified_at desc);
alter table public.verification_results enable row level security;
revoke all on public.verification_results from public, anon, authenticated, service_role;
grant select on public.verification_results to service_role, authenticated;
create policy bff_service_read on public.verification_results for select to service_role using (true);
create policy tenant_member_read on public.verification_results for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- One reconciliation statement per batch (the maker-checker record, Doc 11
-- W5.6): approved scope versus executed reality, produced by the
-- independent reconciler role — not by Sudhaar or Karya. Anything executed
-- outside approved scope must be structurally impossible; the reconciler
-- asserts it, and this constraint is the backstop: a row claiming out-of-
-- scope execution is a defect to fail loudly on, not a finding to store.
create table public.plan_reconciliations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  plan_id uuid not null,
  batch_id uuid not null,
  approved_scope jsonb not null check (
    jsonb_typeof(approved_scope) = 'object' and octet_length(approved_scope::text) <= 262144
  ),
  executed_reality jsonb not null check (
    jsonb_typeof(executed_reality) = 'object' and octet_length(executed_reality::text) <= 262144
  ),
  unexecuted jsonb not null default '[]'::jsonb check (jsonb_typeof(unexecuted) = 'array'),
  parameter_diffs jsonb not null default '[]'::jsonb check (jsonb_typeof(parameter_diffs) = 'array'),
  out_of_scope jsonb not null default '[]'::jsonb check (
    jsonb_typeof(out_of_scope) = 'array' and jsonb_array_length(out_of_scope) = 0
  ),
  verification_outcomes jsonb not null default '{}'::jsonb check (jsonb_typeof(verification_outcomes) = 'object'),
  statement text not null check (length(statement) between 1 and 8192),
  statement_signature text not null check (length(statement_signature) between 32 and 512),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, batch_id),
  foreign key (tenant_id, plan_id) references public.remediation_plans(tenant_id, id) on delete restrict,
  foreign key (tenant_id, batch_id) references public.execution_batches(tenant_id, id) on delete restrict
);
alter table public.plan_reconciliations enable row level security;
revoke all on public.plan_reconciliations from public, anon, authenticated, service_role;
grant select on public.plan_reconciliations to service_role, authenticated;
create policy bff_service_read on public.plan_reconciliations for select to service_role using (true);
create policy tenant_member_read on public.plan_reconciliations for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- Links from the action to its current detail records. Set only by the
-- SECURITY DEFINER write paths, which verify the tenant before writing;
-- the composite foreign keys keep a link from crossing tenants.
alter table public.remediation_actions
  add column latest_dry_run_id uuid,
  add column execution_batch_id uuid,
  add column latest_rollback_execution_id uuid,
  add column latest_verification_result_id uuid,
  add constraint remediation_actions_latest_dry_run_fk
    foreign key (tenant_id, latest_dry_run_id) references public.dry_runs(tenant_id, id) on delete restrict,
  add constraint remediation_actions_execution_batch_fk
    foreign key (tenant_id, execution_batch_id) references public.execution_batches(tenant_id, id) on delete restrict,
  add constraint remediation_actions_latest_rollback_fk
    foreign key (tenant_id, latest_rollback_execution_id)
    references public.rollback_executions(tenant_id, id) on delete restrict,
  add constraint remediation_actions_latest_verification_fk
    foreign key (tenant_id, latest_verification_result_id)
    references public.verification_results(tenant_id, id) on delete restrict;

-- ─────────────────────────────────────────────────────────────────────
-- record_dry_run — the M3.2 dry-run engine's only write path.
--
-- The runtime simulates against the content the BFF read from the stored
-- action, then records here. The function re-reads the action itself and
-- refuses unless the simulated content IS the stored content, so a dry
-- run is always bound to exactly the parameters and rollback definition
-- the approver will later read. A success marks the action
-- `dry_run_complete` with a 24-hour freshness gate; a refusal or failure
-- invalidates any earlier dry-run — content that can no longer be
-- simulated cannot stay eligible for agent execution.
-- ─────────────────────────────────────────────────────────────────────
create function public.record_dry_run(
  p_tenant_id uuid,
  p_action_id uuid,
  p_status text,
  p_diff jsonb,
  p_refusal_reason text,
  p_simulated_by text,
  p_parameters jsonb,
  p_rollback_definition jsonb,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  a public.remediation_actions;
  r public.dry_runs;
  v_parameters_hash text;
  v_rollback_hash text;
  v_output_hash text;
  v_result public.ledger_result;
begin
  -- The action is the source of truth for what a dry-run may run on.
  select * into a from public.remediation_actions
    where tenant_id = p_tenant_id and id = p_action_id for update;
  if not found then
    return jsonb_build_object('error', 'action_not_found');
  end if;

  -- Dry-runs precede approval. Once an action is approved its content is
  -- frozen: re-simulating it would let a new diff replace the one the
  -- approver read after the fact.
  if a.approval_status not in ('draft', 'awaiting_approval') then
    return jsonb_build_object('error', 'action_not_eligible');
  end if;

  -- Content binding: the simulated content must be the stored content.
  -- jsonb equality is semantic, so key order and whitespace cannot sneak
  -- a difference through, and a hash computed here is over what is
  -- actually stored.
  if p_parameters is distinct from a.parameters
     or p_rollback_definition is distinct from a.rollback_definition then
    return jsonb_build_object('error', 'content_mismatch');
  end if;

  if p_status not in ('succeeded', 'refused', 'failed')
     or p_simulated_by is null or length(p_simulated_by) = 0 or length(p_simulated_by) > 64
     or p_correlation_id is null then
    return jsonb_build_object('error', 'invalid_record');
  end if;

  if p_status = 'succeeded' then
    if p_diff is null or jsonb_typeof(p_diff) <> 'object'
       or jsonb_typeof(p_diff->'changes') is distinct from 'array'
       or p_refusal_reason is not null
       or octet_length(p_diff::text) > 262144 then
      return jsonb_build_object('error', 'invalid_diff');
    end if;
  else
    if p_diff is not null or p_refusal_reason is null
       or p_refusal_reason !~ '^[a-z0-9_]{1,80}$' then
      return jsonb_build_object('error', 'invalid_refusal');
    end if;
  end if;

  v_parameters_hash := encode(sha256(convert_to(a.parameters::text, 'UTF8')), 'hex');
  v_rollback_hash := encode(sha256(convert_to(a.rollback_definition::text, 'UTF8')), 'hex');
  if p_status = 'succeeded' then
    v_output_hash := encode(sha256(convert_to(p_diff::text, 'UTF8')), 'hex');
    v_result := 'success';
  elsif p_status = 'refused' then
    v_result := 'skipped';
  else
    v_result := 'failure';
  end if;

  insert into public.dry_runs(tenant_id, action_id, plan_id, status, diff, refusal_reason,
    renderable, parameters_hash, rollback_definition_hash, simulated_by, correlation_id, expires_at)
  values (p_tenant_id, p_action_id, a.plan_id, p_status, p_diff, p_refusal_reason,
    p_status = 'succeeded', v_parameters_hash, v_rollback_hash, p_simulated_by, p_correlation_id,
    now() + interval '24 hours')
  returning * into r;

  if p_status = 'succeeded' then
    update public.remediation_actions set
      dry_run_status = 'dry_run_complete',
      dry_run_result = p_diff,
      dry_run_completed_at = now(),
      dry_run_expires_at = r.expires_at,
      latest_dry_run_id = r.id,
      updated_at = now()
    where tenant_id = p_tenant_id and id = p_action_id;
  else
    -- A refused or failed re-simulation invalidates whatever earlier
    -- dry-run made the action eligible: content that cannot be simulated
    -- now must not stay approvable on the strength of a stale diff.
    update public.remediation_actions set
      dry_run_status = 'awaiting_dry_run',
      dry_run_result = null,
      dry_run_completed_at = null,
      dry_run_expires_at = null,
      latest_dry_run_id = r.id,
      updated_at = now()
    where tenant_id = p_tenant_id and id = p_action_id;
  end if;

  -- The ledger carries the binding and the outcome, not the diff: hashes
  -- and refusal codes only. The diff itself is tenant-readable here.
  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'agent', p_simulated_by, null, null, null,
    'plan.dry_run.completed', p_action_id::text, v_parameters_hash, v_output_hash,
    null, null, null, null, v_result,
    jsonb_build_object('dry_run_id', r.id, 'plan_id', a.plan_id, 'status', p_status,
      'renderable', r.renderable, 'refusal_reason', p_refusal_reason,
      'parameters_hash', v_parameters_hash, 'rollback_definition_hash', v_rollback_hash,
      'expires_at', r.expires_at)
  );

  return jsonb_build_object('dryRun', jsonb_build_object(
    'id', r.id, 'status', r.status, 'renderable', r.renderable,
    'refusalReason', r.refusal_reason, 'expiresAt', r.expires_at, 'createdAt', r.created_at));
end $$;
revoke all on function public.record_dry_run(uuid,uuid,text,jsonb,text,text,jsonb,jsonb,uuid)
  from public, anon, authenticated;
grant execute on function public.record_dry_run(uuid,uuid,text,jsonb,text,text,jsonb,jsonb,uuid)
  to service_role;
