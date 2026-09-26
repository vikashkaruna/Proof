import { describe, expect, it } from 'vitest';
import {
  computeMonitoringHealth,
  describeRefusal,
  isBatchOpen,
  isScheduleOverdue,
  needsOperatorAttention,
  parseDryRunChanges,
  reconciliationVerdict,
  renderDiffValue,
  summarizeDrift,
  summarizeVerificationOutcomes,
} from './execution-view';

describe('parseDryRunChanges', () => {
  it('parses the simulator diff shape into renderable changes', () => {
    const diff = {
      changes: [
        { field: 'email', before: 'value_as_stored', after: 'masked' },
        { field: 'retain_5y_kyc', before: 'absent', after: 'granted', role: 'dpo' },
      ],
    };
    expect(parseDryRunChanges(diff)).toEqual([
      { field: 'email', before: 'value_as_stored', after: 'masked' },
      { field: 'retain_5y_kyc', before: 'absent', after: 'granted', role: 'dpo' },
    ]);
  });

  it('accepts a diff whose changes array is empty', () => {
    expect(parseDryRunChanges({ changes: [] })).toEqual([]);
  });

  it('rejects non-object diffs, arrays and malformed change items', () => {
    expect(parseDryRunChanges(null)).toBeNull();
    expect(parseDryRunChanges('nope')).toBeNull();
    expect(parseDryRunChanges([{ field: 'x' }])).toBeNull();
    expect(parseDryRunChanges({ changes: 'nope' })).toBeNull();
    expect(parseDryRunChanges({ changes: [null] })).toBeNull();
    expect(parseDryRunChanges({ changes: [{ before: 'a', after: 'b' }] })).toBeNull();
    expect(parseDryRunChanges({ changes: [{ field: 7 }] })).toBeNull();
  });
});

describe('renderDiffValue', () => {
  it('renders strings, null, other JSON values and absence distinctly', () => {
    expect(renderDiffValue('masked')).toBe('masked');
    expect(renderDiffValue(null)).toBe('null');
    expect(renderDiffValue(true)).toBe('true');
    expect(renderDiffValue(1200)).toBe('1200');
    expect(renderDiffValue(undefined)).toBe('—');
  });
});

describe('describeRefusal', () => {
  it('explains the known simulator refusal codes', () => {
    expect(describeRefusal('action_type_not_simulable')).toContain('no simulator');
    expect(describeRefusal('parameters_invalid')).toContain('do not fit');
    expect(describeRefusal('parameters_oversized')).toContain('size bound');
  });

  it('falls back to the raw code for anything else and never invents a reason', () => {
    expect(describeRefusal('something_new')).toContain('something_new');
    expect(describeRefusal(null)).toContain('refused');
  });
});

describe('batch status helpers', () => {
  it('treats only dispatched and running as open', () => {
    expect(isBatchOpen('dispatched')).toBe(true);
    expect(isBatchOpen('running')).toBe(true);
    expect(isBatchOpen('completed')).toBe(false);
    expect(isBatchOpen('halted')).toBe(false);
  });

  it('flags the operator-attention states, not clean completions', () => {
    for (const status of ['partial_failure', 'failed', 'halted']) {
      expect(needsOperatorAttention(status)).toBe(true);
    }
    for (const status of ['completed', 'rolled_back', 'running', 'dispatched']) {
      expect(needsOperatorAttention(status)).toBe(false);
    }
  });
});

describe('isScheduleOverdue', () => {
  const now = Date.parse('2026-09-26T10:00:00Z');

  it('is overdue when active with a next run in the past', () => {
    expect(isScheduleOverdue({ status: 'active', next_run_at: '2026-09-26T09:00:00Z' }, now)).toBe(
      true,
    );
  });

  it('is not overdue for paused or retired schedules, or a future run', () => {
    expect(isScheduleOverdue({ status: 'paused', next_run_at: '2026-09-26T09:00:00Z' }, now)).toBe(
      false,
    );
    expect(isScheduleOverdue({ status: 'retired', next_run_at: '2026-09-26T09:00:00Z' }, now)).toBe(
      false,
    );
    expect(isScheduleOverdue({ status: 'active', next_run_at: '2026-09-26T11:00:00Z' }, now)).toBe(
      false,
    );
  });

  it('is not overdue when no next run is recorded', () => {
    expect(isScheduleOverdue({ status: 'active', next_run_at: null }, now)).toBe(false);
  });
});

describe('summarizeDrift', () => {
  const now = Date.parse('2026-09-26T10:00:00Z');
  const days = (n: number) => new Date(now - n * 86_400_000).toISOString();

  it('counts only the trailing week, unacknowledged rows and severity mix', () => {
    const summary = summarizeDrift(
      [
        { severity: 'high', detected_at: days(1), acknowledged_at: null },
        { severity: 'high', detected_at: days(2), acknowledged_at: days(1.5) },
        { severity: 'low', detected_at: days(3), acknowledged_at: null },
        { severity: 'critical', detected_at: days(9), acknowledged_at: null },
      ],
      now,
    );
    expect(summary.detectedLast7Days).toBe(3);
    expect(summary.unacknowledged).toBe(2);
    expect(summary.bySeverity).toEqual({ high: 2, low: 1 });
  });

  it('ignores unparseable timestamps rather than counting them', () => {
    const summary = summarizeDrift(
      [{ severity: 'low', detected_at: 'not-a-date', acknowledged_at: null }],
      now,
    );
    expect(summary.detectedLast7Days).toBe(0);
    expect(summary.unacknowledged).toBe(0);
  });
});

describe('computeMonitoringHealth', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  it('mirrors the BFF health definition over the same rows', () => {
    const health = computeMonitoringHealth(
      [
        { status: 'active', next_run_at: new Date(Date.now() - 60_000).toISOString() },
        { status: 'active', next_run_at: new Date(Date.now() + 3_600_000).toISOString() },
        { status: 'paused', next_run_at: null },
      ],
      [
        { severity: 'high', detected_at: daysAgo(1), acknowledged_at: null },
        { severity: 'critical', detected_at: daysAgo(2), acknowledged_at: daysAgo(1) },
        { severity: 'low', detected_at: daysAgo(9), acknowledged_at: null },
      ],
    );
    expect(health.activeSchedules).toBe(2);
    expect(health.overdueSchedules).toBe(1);
    expect(health.drift.detectedLast7Days).toBe(2);
    expect(health.drift.unacknowledged).toBe(1);
    // The total is over every fetched row — the 9-day-old low detection is
    // outside the 7-day window but still unacknowledged.
    expect(health.unacknowledgedTotal).toBe(2);
    expect(health.checkedAt).toBeGreaterThan(0);
  });

  it('is a coherent empty snapshot with no data', () => {
    const health = computeMonitoringHealth([], []);
    expect(health.activeSchedules).toBe(0);
    expect(health.overdueSchedules).toBe(0);
    expect(health.drift).toEqual({
      detectedLast7Days: 0,
      unacknowledged: 0,
      bySeverity: {},
    });
    expect(health.unacknowledgedTotal).toBe(0);
  });
});

describe('reconciliationVerdict', () => {
  it('is clean when nothing was swept and the content digest matched', () => {
    expect(reconciliationVerdict({ unexecuted: [], parameter_diffs: [] })).toBe('clean');
  });

  it('demands attention for swept actions or content drift', () => {
    expect(
      reconciliationVerdict({
        unexecuted: [{ action_id: 'a1', reason: 'swept_unexecuted' }],
        parameter_diffs: [],
      }),
    ).toBe('attention');
    expect(
      reconciliationVerdict({
        unexecuted: [],
        parameter_diffs: [{ kind: 'content_digest_drift', approved: 'a', recomputed: 'b' }],
      }),
    ).toBe('attention');
  });
});

describe('summarizeVerificationOutcomes', () => {
  it('collapses the reconciler outcome map to counts', () => {
    expect(
      summarizeVerificationOutcomes({
        a1: 'succeeded',
        a2: 'succeeded',
        a3: 'failed',
        a4: 'unexecuted',
      }),
    ).toEqual({ succeeded: 2, failed: 1, unexecuted: 1 });
  });

  it('counts unknown outcomes as unexecuted and tolerates junk', () => {
    expect(summarizeVerificationOutcomes({ a1: 'rolled_back' })).toEqual({
      succeeded: 0,
      failed: 0,
      unexecuted: 1,
    });
    expect(summarizeVerificationOutcomes(null)).toEqual({
      succeeded: 0,
      failed: 0,
      unexecuted: 0,
    });
  });
});
