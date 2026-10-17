import { describeApprovalBlocker, type ActionReadiness } from '@axiom/types';

/**
 * What the plan screens say about an action's dry run and rollback.
 *
 * The recorded `dry_runs` row is the source of truth (migration 0060); the
 * action's `dry_run_status` column is a display cache. The owner found a plan
 * whose cache said "dry-run complete" while no run was recorded, so the screens
 * now derive the state from the readiness answer (0157), which reads the
 * recorded run, and show the cache only as a secondary fact.
 */

export type RecordedDryRunState =
  'succeeded' | 'expired' | 'refused' | 'failed' | 'not_recorded' | 'unknown';

export type BadgeVariant = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'indigo';

export function recordedDryRunState(
  readiness: ActionReadiness | null | undefined,
): RecordedDryRunState {
  if (!readiness) return 'unknown';
  const run = readiness.dryRun;
  if (!run) return 'not_recorded';
  if (run.status === 'refused') return 'refused';
  if (run.status === 'failed') return 'failed';
  return readiness.blockers.includes('dry_run_expired') ? 'expired' : 'succeeded';
}

const DRY_RUN_LABEL: Record<RecordedDryRunState, { label: string; variant: BadgeVariant }> = {
  succeeded: { label: 'Recorded · succeeded', variant: 'success' },
  expired: { label: 'Recorded · expired', variant: 'warning' },
  refused: { label: 'Recorded · refused', variant: 'danger' },
  failed: { label: 'Recorded · failed', variant: 'danger' },
  not_recorded: { label: 'Not recorded', variant: 'danger' },
  unknown: { label: 'Unavailable', variant: 'neutral' },
};

export function dryRunBadge(state: RecordedDryRunState) {
  return DRY_RUN_LABEL[state];
}

/**
 * The cache claims a completed dry run that is not on record — the exact
 * contradiction in the finding. Shown so nobody mistakes the cache for a run.
 */
export function cacheContradictsRecord(
  dryRunStatus: string,
  readiness: ActionReadiness | null | undefined,
): boolean {
  return dryRunStatus === 'dry_run_complete' && recordedDryRunState(readiness) === 'not_recorded';
}

/**
 * An approval granted while no dry run was recorded. 0157 makes this
 * impossible from now on; rows approved earlier are flagged, not hidden.
 */
export function approvedWithoutRecordedRun(
  approvalStatus: string,
  readiness: ActionReadiness | null | undefined,
): boolean {
  return approvalStatus === 'approved' && recordedDryRunState(readiness) === 'not_recorded';
}

/** Plain-language reasons this action cannot be approved now (empty if it can). */
export function blockerReasons(readiness: ActionReadiness | null | undefined): string[] {
  if (!readiness) return ['Readiness could not be read, so approval is not offered.'];
  return readiness.blockers.map(describeApprovalBlocker);
}
