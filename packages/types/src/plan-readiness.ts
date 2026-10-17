import { z } from 'zod';

/**
 * BR-2 readiness, as computed by `plan_approval_readiness` (migration 0157).
 *
 * The rule lives in SQL so that the BFF gate, the approval trigger and the plan
 * screen cannot disagree. This module only parses its answer and says, in
 * plain words, which requirement is missing.
 */

/** Plan statuses an approval may be issued for (BFF route and 0157 agree). */
export const APPROVABLE_PLAN_STATUSES = ['draft', 'review', 'approved', 'cancelled'] as const;

export const ACTION_APPROVAL_BLOCKERS = [
  'action_not_found',
  'already_executed',
  'no_recorded_dry_run',
  'dry_run_not_complete',
  'dry_run_refused',
  'dry_run_failed',
  'dry_run_expired',
  'dry_run_content_changed',
  'rollback_not_validated',
] as const;
export type ActionApprovalBlocker = (typeof ACTION_APPROVAL_BLOCKERS)[number];

const isoTime = z.string().refine((v) => Number.isFinite(Date.parse(v)), 'timestamp');

export const ActionReadinessSchema = z.object({
  actionId: z.uuid(),
  sequence: z.number().int(),
  actionType: z.string(),
  approvalStatus: z.string(),
  executionStatus: z.string().nullable(),
  ready: z.boolean(),
  blockers: z.array(z.enum(ACTION_APPROVAL_BLOCKERS)),
  rollbackValidated: z.boolean().nullable(),
  rollbackValidatedAt: isoTime.nullable(),
  dryRun: z
    .object({
      id: z.uuid(),
      status: z.enum(['succeeded', 'refused', 'failed']),
      refusalReason: z.string().nullable(),
      createdAt: isoTime,
      expiresAt: isoTime,
    })
    .nullable(),
});
export type ActionReadiness = z.infer<typeof ActionReadinessSchema>;

export const PlanReadinessSchema = z.object({
  planId: z.uuid(),
  planStatus: z.string(),
  planApprovable: z.boolean(),
  approvableStatuses: z.array(z.string()),
  actions: z.array(ActionReadinessSchema),
  evaluatedAt: isoTime,
});
export type PlanReadiness = z.infer<typeof PlanReadinessSchema>;

const BLOCKER_TEXT: Record<ActionApprovalBlocker, string> = {
  action_not_found: 'The action is not part of this plan.',
  already_executed: 'The action has already been executed; it cannot be approved again.',
  no_recorded_dry_run:
    'No dry run is recorded for this action. A status saying "dry-run complete" without a recorded run does not count.',
  dry_run_not_complete: 'The dry run has not completed.',
  dry_run_refused: 'The latest dry run was refused by the simulator.',
  dry_run_failed: 'The latest dry run failed.',
  dry_run_expired: 'The dry run has expired (24-hour window). Re-run it before approving.',
  dry_run_content_changed:
    'The action changed after its dry run, so the recorded run no longer answers for it. Re-run it.',
  rollback_not_validated: 'The rollback has not been validated.',
};

export function describeApprovalBlocker(code: ActionApprovalBlocker): string {
  return BLOCKER_TEXT[code];
}

export function isApprovablePlanStatus(status: string): boolean {
  return (APPROVABLE_PLAN_STATUSES as readonly string[]).includes(status);
}

/** Why a plan in this status cannot be approved at all, or null if it can. */
export function describePlanStatusBlocker(status: string): string | null {
  if (isApprovablePlanStatus(status)) return null;
  const allowed = APPROVABLE_PLAN_STATUSES.join(', ');
  return `This plan's status is "${status.replace(/_/g, ' ')}". Approval can only be issued for a plan that is ${allowed}; executed or executing plans are closed to new approvals.`;
}

/** Per-plan summary row from `plan_decision_summaries` (migration 0157). */
export const PlanDecisionSummarySchema = z.object({
  plan_id: z.uuid(),
  action_count: z.number().int(),
  approved_actions: z.number().int(),
  ready_actions: z.number().int(),
  recorded_dry_runs: z.number().int(),
  succeeded_dry_runs: z.number().int(),
  refused_or_failed_dry_runs: z.number().int(),
  unrecorded_dry_runs: z.number().int(),
  expired_dry_runs: z.number().int(),
  rollbacks_validated: z.number().int(),
  last_approved_at: isoTime.nullable(),
  last_rejected_at: isoTime.nullable(),
});
export type PlanDecisionSummary = z.infer<typeof PlanDecisionSummarySchema>;

export type SummaryTone = 'ok' | 'warn' | 'bad' | 'none';

/** One-line dry-run state for a plan, from recorded runs only. */
export function summariseDryRuns(s: PlanDecisionSummary): { label: string; tone: SummaryTone } {
  if (s.action_count === 0) return { label: 'No actions', tone: 'none' };
  if (s.recorded_dry_runs === 0) return { label: 'None recorded', tone: 'bad' };
  const parts = [`${s.succeeded_dry_runs}/${s.action_count} succeeded`];
  if (s.expired_dry_runs > 0) parts.push(`${s.expired_dry_runs} expired`);
  if (s.refused_or_failed_dry_runs > 0)
    parts.push(`${s.refused_or_failed_dry_runs} refused/failed`);
  if (s.unrecorded_dry_runs > 0) parts.push(`${s.unrecorded_dry_runs} not recorded`);
  const clean =
    s.succeeded_dry_runs === s.action_count &&
    s.expired_dry_runs === 0 &&
    s.refused_or_failed_dry_runs === 0;
  return { label: parts.join(' · '), tone: clean ? 'ok' : 'warn' };
}

/** One-line rollback state for a plan. */
export function summariseRollbacks(s: PlanDecisionSummary): { label: string; tone: SummaryTone } {
  if (s.action_count === 0) return { label: 'No actions', tone: 'none' };
  const label = `${s.rollbacks_validated}/${s.action_count} validated`;
  if (s.rollbacks_validated === s.action_count) return { label, tone: 'ok' };
  return { label, tone: s.rollbacks_validated === 0 ? 'bad' : 'warn' };
}
