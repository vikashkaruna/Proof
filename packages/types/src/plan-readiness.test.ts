import { describe, expect, it } from 'vitest';
import {
  PlanDecisionSummarySchema,
  PlanReadinessSchema,
  describeApprovalBlocker,
  describePlanStatusBlocker,
  summariseDryRuns,
  summariseRollbacks,
  type PlanDecisionSummary,
} from './plan-readiness';

const summary = (over: Partial<PlanDecisionSummary> = {}): PlanDecisionSummary => ({
  plan_id: '553b611b-78a0-4b66-8999-566cbf2dcbb4',
  action_count: 3,
  approved_actions: 0,
  ready_actions: 3,
  recorded_dry_runs: 3,
  succeeded_dry_runs: 3,
  refused_or_failed_dry_runs: 0,
  unrecorded_dry_runs: 0,
  expired_dry_runs: 0,
  rollbacks_validated: 3,
  last_approved_at: null,
  last_rejected_at: null,
  ...over,
});

describe('plan readiness contract (0157)', () => {
  it('parses the SQL answer as PostgREST returns it', () => {
    const parsed = PlanReadinessSchema.parse({
      planId: 'cb3c8ef4-8f3c-43fc-afca-ccc4b8bf598d',
      planStatus: 'approved',
      planApprovable: true,
      approvableStatuses: ['draft', 'review', 'approved', 'cancelled'],
      evaluatedAt: '2026-10-17T18:00:00.123456+00:00',
      actions: [
        {
          actionId: '99816474-5185-42da-886f-3356008f9810',
          sequence: 1,
          actionType: 'data.mask',
          approvalStatus: 'approved',
          executionStatus: 'draft',
          ready: false,
          blockers: ['no_recorded_dry_run'],
          rollbackValidated: true,
          rollbackValidatedAt: '2026-10-11T12:30:44.899688+00:00',
          dryRun: null,
        },
      ],
    });
    expect(parsed.actions[0]!.blockers).toEqual(['no_recorded_dry_run']);
  });

  it('refuses an unknown blocker code rather than rendering it as ready', () => {
    const bad = PlanReadinessSchema.safeParse({
      planId: 'cb3c8ef4-8f3c-43fc-afca-ccc4b8bf598d',
      planStatus: 'review',
      planApprovable: true,
      approvableStatuses: [],
      evaluatedAt: '2026-10-17T18:00:00Z',
      actions: [
        {
          actionId: '99816474-5185-42da-886f-3356008f9810',
          sequence: 1,
          actionType: 'data.mask',
          approvalStatus: 'awaiting_approval',
          executionStatus: null,
          ready: false,
          blockers: ['something_new'],
          rollbackValidated: true,
          rollbackValidatedAt: null,
          dryRun: null,
        },
      ],
    });
    expect(bad.success).toBe(false);
  });

  it('names the closed status and the statuses that are open', () => {
    expect(describePlanStatusBlocker('review')).toBeNull();
    expect(describePlanStatusBlocker('cancelled')).toBeNull();
    const text = describePlanStatusBlocker('partial_failure');
    expect(text).toContain('"partial failure"');
    expect(text).toContain('draft, review, approved, cancelled');
  });

  it('describes the cache-only contradiction in words', () => {
    expect(describeApprovalBlocker('no_recorded_dry_run')).toContain('does not count');
  });
});

describe('list summaries', () => {
  it('says "None recorded" when the only evidence is the status field', () => {
    const s = summary({
      action_count: 1,
      recorded_dry_runs: 0,
      succeeded_dry_runs: 0,
      unrecorded_dry_runs: 1,
    });
    expect(summariseDryRuns(s)).toEqual({ label: 'None recorded', tone: 'bad' });
  });

  it('is clean only when every action has a fresh recorded success', () => {
    expect(summariseDryRuns(summary())).toEqual({ label: '3/3 succeeded', tone: 'ok' });
    expect(summariseDryRuns(summary({ expired_dry_runs: 3 }))).toEqual({
      label: '3/3 succeeded · 3 expired',
      tone: 'warn',
    });
    expect(
      summariseDryRuns(summary({ succeeded_dry_runs: 2, refused_or_failed_dry_runs: 1 })).tone,
    ).toBe('warn');
    expect(
      summariseDryRuns(
        summary({ recorded_dry_runs: 2, succeeded_dry_runs: 2, unrecorded_dry_runs: 1 }),
      ),
    ).toEqual({ label: '2/3 succeeded · 1 not recorded', tone: 'warn' });
  });

  it('counts validated rollbacks', () => {
    expect(summariseRollbacks(summary())).toEqual({ label: '3/3 validated', tone: 'ok' });
    expect(summariseRollbacks(summary({ rollbacks_validated: 1 })).tone).toBe('warn');
    expect(summariseRollbacks(summary({ rollbacks_validated: 0 })).tone).toBe('bad');
    expect(summariseRollbacks(summary({ action_count: 0 })).tone).toBe('none');
  });

  it('parses a summary row', () => {
    expect(
      PlanDecisionSummarySchema.parse(
        summary({ last_approved_at: '2026-10-17T16:40:57.562939+00:00' }),
      ).last_approved_at,
    ).toContain('2026-10-17');
  });
});
