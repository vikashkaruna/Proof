import { createHash } from 'node:crypto';
import {
  encodeLocalCustodyPolicy,
  encodeLocalCustodyCancellation,
  encodeLocalCustodyEvent,
  type LocalCustodyEventRequest,
  type LocalCustodyContext,
} from '@axiom/types';
export const tenant = '11111111-1111-4111-8111-111111111111',
  actor = '22222222-2222-4222-8222-222222222222',
  policyId = '33333333-3333-4333-8333-333333333333',
  operation = '44444444-4444-4444-8444-444444444444',
  event = '55555555-5555-4555-8555-555555555555',
  other = '66666666-6666-4666-8666-666666666666';
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function manifest(t = tenant) {
  const ref = `axiom-local-dispatch://${t}/${policyId}/versions/1`;
  const policyText = encodeLocalCustodyPolicy({
    version: 1,
    policyId,
    tenantId: t,
    mode: 'operator_managed',
    nominatedOperatorId: actor,
    targetWorkloadId: other,
    servicePrincipals: {
      producer: 'spiffe://local.test/service/assessment-dispatch-producer',
      controller: 'spiffe://local.test/controller/assessment',
    },
    validity: { kind: 'until_revoked', reviewDueAt: 1 },
    actionClass: 'assessment_dispatch_key_custody',
    keyPolicy: { primary: ref, readable: [ref] },
    keyPolicySha256: 'b'.repeat(64),
    deploymentBindingSha256: 'c'.repeat(64),
    reason: 'Explicit local custody only',
    acceptedLimitations: ['hardware_backing_unverified'],
    statutoryComplianceAsserted: false,
    ownershipVerified: false,
  });
  return { policyText, policySha256: hash(policyText) };
}
export function request(t = tenant): LocalCustodyEventRequest {
  return {
    version: 1,
    operationKey: operation,
    transition: 'request',
    ...manifest(t),
    previousEventId: null,
    nextReviewDueAt: null,
    reason: 'Owner requests dispatch custody',
    confirmed: true,
  };
}
export function receipt(r = request(), t = tenant, a = actor) {
  return {
    state: 'recorded' as const,
    tenantId: t,
    actorId: a,
    operationKey: r.operationKey,
    policyId,
    transition: r.transition,
    eventId: event,
    activationEpoch: 0,
    reviewDueAt: 1,
    previousEventId: r.previousEventId,
    requestText: encodeLocalCustodyEvent(r),
    requestSha256: hash(encodeLocalCustodyEvent(r)),
    policySha256: r.policySha256,
    keyPolicySha256: 'b'.repeat(64),
    receipt: { id: '1', entryHash: 'a'.repeat(64) },
    replayed: true,
  };
}
export function context(t = tenant, a = actor): LocalCustodyContext {
  return {
    version: 1,
    tenantId: t,
    actorId: a,
    isDemo: false,
    canRequest: true,
    requestModes: ['operator_managed'],
    selectedPolicyId: null,
    rows: [],
    history: [],
    nextCursor: null,
    nextHistoryCursor: null,
  };
}
export function cancellation(r = request()) {
  return {
    version: 1 as const,
    operationKey: other,
    originalRequestText: encodeLocalCustodyEvent(r),
    reason: 'Abandon the stale exact intent',
    confirmed: true as const,
  };
}

export function cancellationReceipt(c = cancellation(), t = tenant, a = actor) {
  return {
    state: 'cancelled' as const,
    tenantId: t,
    actorId: a,
    operationKey: c.operationKey,
    originalOperationKey: JSON.parse(c.originalRequestText).operationKey,
    originalRequestText: c.originalRequestText,
    originalRequestSha256: hash(c.originalRequestText),
    cancellationText: encodeLocalCustodyCancellation(c),
    cancellationSha256: hash(encodeLocalCustodyCancellation(c)),
    cancellationId: event,
    receipt: { id: '2', entryHash: 'd'.repeat(64) },
    replayed: true,
  };
}
