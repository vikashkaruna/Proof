/**
 * W5 execution surfaces — shared row shapes and pure display helpers.
 *
 * The execution-detail tables (migrations 0060-0063) are read by the web
 * app's server components through the user-scoped Supabase client, so every
 * query is RLS-tenant-scoped and a missing filter is an empty result rather
 * than a cross-tenant leak (the SEC-3 rule). This module holds the display
 * logic the execution, monitoring and plan surfaces share: parsing the
 * dry-run simulator's structured diff, summarising batches, the drift-health
 * arithmetic that mirrors the BFF's GET /v1/monitoring/health, and the
 * maker-checker reconciliation verdict.
 *
 * Everything here is pure so a test can drive it without a database.
 */

/** One rendered field-level change from the dry-run simulator (Doc 04 §3.2). */
export interface DryRunChange {
  field: string;
  before: unknown;
  after: unknown;
  role?: string;
}

/**
 * Parse the stored `dry_runs.diff` into renderable changes.
 *
 * The simulator emits `{ changes: [{ field, before, after, role? }] }`, and
 * the database check constraint only guarantees `diff.changes` is an array of
 * JSON — it cannot guarantee the item shape. Returns `null` for anything that
 * does not fit, so the caller can fall back to the raw JSON view instead of
 * rendering invented fields. An empty array is valid: an action whose
 * simulation produced no field-level changes.
 */
export function parseDryRunChanges(diff: unknown): DryRunChange[] | null {
  if (diff === null || typeof diff !== 'object' || Array.isArray(diff)) return null;
  const changes = (diff as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) return null;
  const parsed: DryRunChange[] = [];
  for (const change of changes) {
    if (change === null || typeof change !== 'object' || Array.isArray(change)) return null;
    const record = change as Record<string, unknown>;
    if (typeof record.field !== 'string') return null;
    parsed.push({
      field: record.field,
      before: record.before,
      after: record.after,
      ...(typeof record.role === 'string' ? { role: record.role } : {}),
    });
  }
  return parsed;
}

/** Render a diff cell value as display text without inventing content. */
export function renderDiffValue(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * Human text for a `dry_runs.refusal_reason` code. A refusal is an outcome,
 * not an error: it is recorded so the auditor can see the action was routed
 * to manual handling rather than quietly retried.
 */
const REFUSAL_LABELS: Record<string, string> = {
  action_type_not_simulable:
    'This action type has no simulator. Route it to manual handling — it cannot be agent-executed.',
  parameters_invalid: 'The stored parameters do not fit the simulator spec for this action type.',
  parameters_oversized: 'The stored parameters exceed the simulator size bound.',
};

export function describeRefusal(code: string | null | undefined): string {
  if (!code) return 'The simulation was refused.';
  return REFUSAL_LABELS[code] ?? `Refused with reason ${code}.`;
}

/** Statuses of `execution_batches` (migration 0060). */
export type BatchStatus =
  'dispatched' | 'running' | 'completed' | 'partial_failure' | 'failed' | 'halted' | 'rolled_back';

/** A batch the executor has not settled yet (the open-shape constraint). */
export function isBatchOpen(status: string): boolean {
  return status === 'dispatched' || status === 'running';
}

/**
 * Batch states that mean an operator should look: anything that did not
 * finish clean. Halted (governor or kill switch) and rolled_back batches are
 * incidents, and a rollback that itself failed is the one state that must
 * never render clean.
 */
export function needsOperatorAttention(status: string): boolean {
  return status === 'partial_failure' || status === 'failed' || status === 'halted';
}

export interface ScheduleLike {
  status: string;
  next_run_at: string | null;
}

/**
 * Overdue = active with a next run in the past — the same definition as the
 * BFF's GET /v1/monitoring/health, so the two surfaces cannot disagree.
 */
export function isScheduleOverdue(schedule: ScheduleLike, now: number): boolean {
  return (
    schedule.status === 'active' &&
    typeof schedule.next_run_at === 'string' &&
    Date.parse(schedule.next_run_at) < now
  );
}

export interface DriftEventLike {
  severity: string;
  detected_at: string;
  acknowledged_at: string | null;
}

export interface DriftSummary {
  detectedLast7Days: number;
  unacknowledged: number;
  bySeverity: Record<string, number>;
}

/**
 * Drift health over the trailing week — mirrors GET /v1/monitoring/health:
 * events in the last 7 days, how many still lack a human acknowledgement, and
 * the severity distribution.
 */
export function summarizeDrift(events: DriftEventLike[], now: number): DriftSummary {
  const cutoff = now - 7 * 86_400_000;
  const recent = events.filter((e) => {
    const detected = Date.parse(e.detected_at);
    return Number.isFinite(detected) && detected >= cutoff;
  });
  return {
    detectedLast7Days: recent.length,
    unacknowledged: recent.filter((e) => e.acknowledged_at == null).length,
    bySeverity: recent.reduce<Record<string, number>>((acc, e) => {
      acc[e.severity] = (acc[e.severity] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

export interface MonitoringHealth {
  /** Wall-clock instant the snapshot was taken (ms epoch). */
  checkedAt: number;
  activeSchedules: number;
  overdueSchedules: number;
  drift: DriftSummary;
  unacknowledgedTotal: number;
}

/**
 * Monitoring health as of one instant — the web mirror of the BFF's
 * GET /v1/monitoring/health, computed over the same rows with the same
 * definitions. The clock read happens here, once per request of the
 * force-dynamic page, so the figures on the page are a single coherent
 * snapshot rather than a mix of moments.
 */
export function computeMonitoringHealth(
  schedules: ScheduleLike[],
  events: DriftEventLike[],
): MonitoringHealth {
  const now = Date.now();
  return {
    checkedAt: now,
    activeSchedules: schedules.filter((s) => s.status === 'active').length,
    overdueSchedules: schedules.filter((s) => isScheduleOverdue(s, now)).length,
    drift: summarizeDrift(events, now),
    unacknowledgedTotal: events.filter((e) => e.acknowledged_at == null).length,
  };
}

export interface ReconciliationFacts {
  unexecuted?: unknown;
  parameter_diffs?: unknown;
}

export type ReconciliationVerdict = 'clean' | 'attention';

/**
 * The maker-checker verdict. The reconciler writes `unexecuted` (actions
 * swept back for a fresh approval) and `parameter_diffs` (content drift
 * between the approved digest and the recomputed one). Both empty is a clean
 * statement; anything else deserves eyes. `out_of_scope` is structurally
 * always empty — the database refuses to store a row that claims otherwise.
 */
export function reconciliationVerdict(facts: ReconciliationFacts): ReconciliationVerdict {
  return arrayLength(facts.unexecuted) === 0 && arrayLength(facts.parameter_diffs) === 0
    ? 'clean'
    : 'attention';
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * The `verification_outcomes` map the reconciler stores (action id → final
 * outcome or 'unexecuted'), collapsed to counts for a one-line summary.
 */
export function summarizeVerificationOutcomes(outcomes: unknown): {
  succeeded: number;
  failed: number;
  unexecuted: number;
} {
  const counts = { succeeded: 0, failed: 0, unexecuted: 0 };
  if (outcomes === null || typeof outcomes !== 'object' || Array.isArray(outcomes)) return counts;
  for (const value of Object.values(outcomes as Record<string, unknown>)) {
    if (value === 'succeeded') counts.succeeded += 1;
    else if (value === 'failed') counts.failed += 1;
    else counts.unexecuted += 1;
  }
  return counts;
}
