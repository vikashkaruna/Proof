import { z } from 'zod';
import { ActionStatus } from './enums';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const snapshot = z
  .object({
    fixture_id: uuid,
    resource_id: uuid,
    version: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 2),
    audit_log_enabled: z.boolean(),
  })
  .strict();
const transition = z.object({ before: snapshot, after: snapshot }).strict();

export const OwnedEffectObservationRequestSchema = z
  .object({
    operationKey: uuid,
    planId: uuid,
    actionId: uuid,
    batchId: uuid,
  })
  .strict();

/** Recorded provider facts are distinct from execution success and write authority. */
export const OwnedEffectObservationReceiptSchema = z
  .object({
    tenantId: uuid,
    actorId: uuid,
    operationKey: uuid,
    planId: uuid,
    actionId: uuid,
    batchId: uuid,
    bindingId: uuid,
    contentDigest: digest,
    ledgerReceipt: z.string().regex(/^[1-9][0-9]{0,18}$/),
    observation: z
      .object({
        outcome: z.enum(['unknown', 'forward_committed', 'rollback_committed']),
        observedAt: z.iso.datetime({ offset: true }),
        forwardOperationId: uuid,
        rollbackOperationId: uuid,
        forward: transition.nullable(),
        rollback: transition.nullable(),
        current: snapshot,
        currentMatchesLastCommit: z.boolean().nullable(),
        recordedActionStatus: z.enum(ActionStatus),
        recordedBatchStatus: z.enum([
          'dispatched',
          'running',
          'completed',
          'partial_failure',
          'failed',
          'halted',
          'rolled_back',
        ]),
        approvalExpired: z.boolean(),
        approvalRevoked: z.boolean(),
        retryAllowed: z.literal(false),
        rollbackAllowed: z.literal(false),
        executionStatusChanged: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const o = value.observation;
    const expected = o.rollback?.after ?? o.forward?.after;
    const expectedOutcome = o.rollback
      ? 'rollback_committed'
      : o.forward
        ? 'forward_committed'
        : 'unknown';
    const same = (a: z.infer<typeof snapshot>, b: z.infer<typeof snapshot>) =>
      a.fixture_id === b.fixture_id &&
      a.resource_id === b.resource_id &&
      a.version === b.version &&
      a.audit_log_enabled === b.audit_log_enabled;
    const validTransition = (t: z.infer<typeof transition>, enabled: boolean) =>
      t.before.fixture_id === t.after.fixture_id &&
      t.before.resource_id === t.after.resource_id &&
      t.after.version === t.before.version + 1 &&
      t.before.audit_log_enabled !== enabled &&
      t.after.audit_log_enabled === enabled;
    if (
      o.outcome !== expectedOutcome ||
      (o.rollback && !o.forward) ||
      (o.forward && !validTransition(o.forward, true)) ||
      (o.rollback &&
        (!validTransition(o.rollback, false) || !same(o.rollback.before, o.forward!.after))) ||
      (expected
        ? o.currentMatchesLastCommit !== same(expected, o.current)
        : o.currentMatchesLastCommit !== null) ||
      (expected &&
        (expected.fixture_id !== o.current.fixture_id ||
          expected.resource_id !== o.current.resource_id))
    ) {
      ctx.addIssue({ code: 'custom', message: 'Owned effect observation is inconsistent' });
    }
  });
export type OwnedEffectObservationRequest = z.infer<typeof OwnedEffectObservationRequestSchema>;
export type OwnedEffectObservationReceipt = z.infer<typeof OwnedEffectObservationReceiptSchema>;
