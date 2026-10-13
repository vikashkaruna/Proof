import { z } from 'zod';

const uuid = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
  .refine((v) => v !== '00000000-0000-0000-0000-000000000000');
const count = z.number().int().min(0).max(2000);
const instant = z.iso
  .datetime({ offset: true })
  .refine((v) =>
    /^(?:\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v),
  );
// PostgreSQL microseconds must not collapse into a millisecond ordering check.
function micros(v: string): bigint | null {
  const fraction = /\.(\d+)(?:Z|[+-])/.exec(v)?.[1] ?? '';
  const whole = Date.parse(v.replace(/\.\d+/, ''));
  if (!Number.isFinite(whole) || fraction.length > 6) return null;
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(6, '0'));
}
export const monitoringOutcomeRequestSchema = z
  .strictObject({ tenantId: uuid, scheduleIds: z.array(uuid).max(100) })
  .refine((v) => new Set(v.scheduleIds).size === v.scheduleIds.length);
export const monitoringFireSummarySchema = z
  .strictObject({
    fireId: uuid,
    estateId: uuid,
    kind: z.enum(['drift_check', 'rediscovery', 'reassessment']),
    dueAt: instant,
    calculationAfter: instant,
    nextRunAt: instant,
    correlationId: uuid,
    observationOutcome: z.enum(['drift_detected', 'no_drift', 'no_baseline', 'failed', 'unwired']),
    recordingOutcome: z.enum(['recorded', 'failed']),
    failureCode: z
      .enum([
        'cadence_invalid',
        'probe_invalid',
        'probe_failed',
        'event_recording_failed',
        'live_executor_unwired',
      ])
      .nullable(),
    detectedCount: count,
    recordedCount: count,
    failedCount: count,
    scheduleReceipt: z.strictObject({
      id: z
        .string()
        .regex(/^[1-9][0-9]{0,18}$/)
        .refine((v) => BigInt(v) <= 9223372036854775807n),
      entryHash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  })
  .superRefine((v, c) => {
    const refuse = () =>
      c.addIssue({ code: 'custom', message: 'Inconsistent retained monitoring outcome' });
    const due = micros(v.dueAt),
      after = micros(v.calculationAfter),
      next = micros(v.nextRunAt);
    if (
      v.recordedCount + v.failedCount !== v.detectedCount ||
      due === null ||
      after === null ||
      next === null ||
      due > after ||
      next <= after
    )
      refuse();
    if (
      v.recordingOutcome === 'recorded'
        ? v.failureCode !== null || v.failedCount !== 0
        : v.failureCode === null || v.recordedCount !== 0
    )
      refuse();
    if (v.observationOutcome === 'no_drift' || v.observationOutcome === 'no_baseline') {
      if (v.detectedCount !== 0 || v.recordingOutcome !== 'recorded') refuse();
    } else if (v.observationOutcome === 'drift_detected') {
      if (
        v.detectedCount === 0 ||
        (v.recordingOutcome === 'failed' && v.failureCode !== 'event_recording_failed')
      )
        refuse();
    } else if (
      v.recordingOutcome !== 'failed' ||
      v.detectedCount !== 0 ||
      (v.observationOutcome === 'unwired'
        ? v.failureCode !== 'live_executor_unwired'
        : !['cadence_invalid', 'probe_invalid', 'probe_failed'].includes(v.failureCode ?? ''))
    )
      refuse();
  });
export const monitoringScheduleOutcomeSchema = z.discriminatedUnion('state', [
  z.strictObject({ scheduleId: uuid, state: z.literal('never_recorded'), fire: z.null() }),
  z.strictObject({
    scheduleId: uuid,
    state: z.literal('retained'),
    fire: monitoringFireSummarySchema,
  }),
]);
export const monitoringOutcomesSchema = z
  .strictObject({ tenantId: uuid, schedules: z.array(monitoringScheduleOutcomeSchema).max(100) })
  .refine((v) => new Set(v.schedules.map((s) => s.scheduleId)).size === v.schedules.length);
export type MonitoringOutcomes = z.infer<typeof monitoringOutcomesSchema>;
export type MonitoringScheduleOutcome = z.infer<typeof monitoringScheduleOutcomeSchema>;
