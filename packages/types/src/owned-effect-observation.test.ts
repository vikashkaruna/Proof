import { expect, it } from 'vitest';
import { OwnedEffectObservationReceiptSchema as schema } from './owned-effect-observation';
const id = (n: number) => `89170000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const current = { fixture_id: id(8), resource_id: id(9), version: 0, audit_log_enabled: false };
function receipt() {
  return {
    tenantId: id(1),
    actorId: id(2),
    operationKey: id(3),
    planId: id(4),
    actionId: id(5),
    batchId: id(6),
    bindingId: id(7),
    contentDigest: 'a'.repeat(64),
    ledgerReceipt: '123',
    observation: {
      outcome: 'unknown',
      observedAt: '2026-10-19T00:00:00+00:00',
      forwardOperationId: id(10),
      rollbackOperationId: id(11),
      forward: null,
      rollback: null,
      current,
      currentMatchesLastCommit: null,
      recordedActionStatus: 'failed',
      recordedBatchStatus: 'partial_failure',
      approvalExpired: true,
      approvalRevoked: true,
      retryAllowed: false,
      rollbackAllowed: false,
      executionStatusChanged: false,
    },
  };
}
it('preserves an unknown outcome and expired authority without inventing no-effect', () => {
  expect(schema.parse(receipt()).observation.outcome).toBe('unknown');
});
it.each(['retryAllowed', 'rollbackAllowed', 'executionStatusChanged'] as const)(
  'observation cannot confer%s',
  (field) => {
    const r = receipt();
    expect(
      schema.safeParse({ ...r, observation: { ...r.observation, [field]: true } }).success,
    ).toBe(false);
  },
);
it.each(['no_effect', 'succeeded', 'forward_committed'])(
  'cannot infer%s from an absent journal',
  (outcome) => {
    const r = receipt();
    expect(schema.safeParse({ ...r, observation: { ...r.observation, outcome } }).success).toBe(
      false,
    );
  },
);
it('validates causal rollback and exact snapshot version, including ABA drift', () => {
  const r = receipt();
  const after = { ...current, version: 1, audit_log_enabled: true };
  const restored = { ...current, version: 2 };
  const observation = {
    ...r.observation,
    outcome: 'rollback_committed',
    forward: { before: current, after },
    rollback: { before: after, after: restored },
    current: restored,
    currentMatchesLastCommit: true,
  };
  expect(schema.safeParse({ ...r, observation }).success).toBe(true);
  expect(
    schema.safeParse({
      ...r,
      observation: { ...observation, current: { ...restored, version: 4 } },
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      ...r,
      observation: {
        ...observation,
        current: { ...restored, version: 4 },
        currentMatchesLastCommit: false,
      },
    }).success,
  ).toBe(true);
  expect(
    schema.safeParse({
      ...r,
      observation: { ...observation, rollback: { before: current, after: restored } },
    }).success,
  ).toBe(false);
});
it('rejects foreign provider identity and injected fields', () => {
  const r = receipt();
  const after = { ...current, version: 1, audit_log_enabled: true };
  const observation = {
    ...r.observation,
    outcome: 'forward_committed',
    forward: { before: current, after },
    current: { ...after, fixture_id: id(99) },
    currentMatchesLastCommit: false,
  };
  expect(schema.safeParse({ ...r, observation }).success).toBe(false);
  expect(schema.safeParse({ ...r, signedToken: 'caller authority' }).success).toBe(false);
});
