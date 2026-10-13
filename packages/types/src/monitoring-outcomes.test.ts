import { describe, expect, it } from 'vitest';
import {
  monitoringOutcomeRequestSchema,
  monitoringFireSummarySchema,
  monitoringOutcomesSchema,
} from './monitoring-outcomes';
const id = '11111111-1111-4111-8111-111111111111';
const fire = {
  fireId: id,
  estateId: id,
  kind: 'drift_check',
  dueAt: '2026-01-01T00:00:00Z',
  calculationAfter: '2026-01-01T00:01:00Z',
  nextRunAt: '2026-01-01T00:15:00Z',
  correlationId: id,
  observationOutcome: 'drift_detected',
  recordingOutcome: 'failed',
  failureCode: 'event_recording_failed',
  detectedCount: 2,
  recordedCount: 0,
  failedCount: 2,
  scheduleReceipt: { id: '12', entryHash: 'a'.repeat(64) },
};
describe('strict retained monitoring outcomes', () => {
  it('preserves detected but zero recorded facts on atomic recording failure', () =>
    expect(monitoringFireSummarySchema.parse(fire).recordedCount).toBe(0));
  it.each([
    { recordedCount: 1 },
    { failedCount: 1 },
    { detectedCount: true },
    { failureCode: null },
    { failureCode: 'raw customer secret' },
    { observationOutcome: 'no_drift' },
    { nextRunAt: fire.calculationAfter },
    { scheduleReceipt: { id: '0', entryHash: 'a'.repeat(64) } },
    { extra: 'caller authority' },
  ])('refuses inconsistent or unbounded proof %j', (change) =>
    expect(monitoringFireSummarySchema.safeParse({ ...fire, ...change }).success).toBe(false),
  );
  it('accepts genuine zero-event failure and unwired records without calling them successful', () => {
    for (const change of [
      { observationOutcome: 'failed', failureCode: 'probe_failed' },
      { observationOutcome: 'unwired', failureCode: 'live_executor_unwired' },
    ])
      expect(
        monitoringFireSummarySchema.safeParse({
          ...fire,
          ...change,
          detectedCount: 0,
          failedCount: 0,
        }).success,
      ).toBe(true);
  });
  it('keeps never_recorded without numeric invented counts', () =>
    expect(
      monitoringOutcomesSchema.parse({
        tenantId: id,
        schedules: [{ scheduleId: id, state: 'never_recorded', fire: null }],
      }).schedules[0]?.fire,
    ).toBeNull());
  it.each([[id, id], Array(101).fill(id), ['invalid'], ['00000000-0000-0000-0000-000000000000']])(
    'bounds selection before query',
    (scheduleIds) =>
      expect(monitoringOutcomeRequestSchema.safeParse({ tenantId: id, scheduleIds }).success).toBe(
        false,
      ),
  );
});

it('preserves PostgreSQL microseconds and refuses reversed due/calculation time', () => {
  expect(
    monitoringFireSummarySchema.safeParse({
      ...fire,
      dueAt: '2026-01-01T00:00:00.000002Z',
      calculationAfter: '2026-01-01T00:00:00.000001Z',
    }).success,
  ).toBe(false);
  expect(
    monitoringFireSummarySchema.safeParse({
      ...fire,
      dueAt: '2026-01-01T05:30:00.000001+05:30',
      calculationAfter: '2026-01-01T00:00:00.000002Z',
    }).success,
  ).toBe(true);
});
