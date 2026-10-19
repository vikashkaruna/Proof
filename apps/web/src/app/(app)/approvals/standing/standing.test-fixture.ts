import { standingMeasuredSource, type StandingPolicyContext } from '@axiom/types';
import type { StandingJournal } from './standing-journal';
export const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const hash = 'a'.repeat(64);
export function fixture() {
  const future = new Date(Date.now() + 3600000).toISOString();
  const source = standingMeasuredSource.parse({
    policyId: id(10),
    policyVersion: 1,
    policySha256: hash,
    policyExpiresAt: future,
    planId: id(11),
    planVersion: 1,
    actionId: id(12),
    contentDigest: hash,
    bindingId: id(13),
    connectorId: id(14),
    engagementId: id(15),
    fixtureId: id(16),
    resourceId: id(17),
    deploymentRequestId: id(18),
    deploymentApprovalId: id(19),
    deploymentExpiresAt: future,
    environment: 'local',
    engineSha256: hash,
    capabilitySha256: hash,
    snapshotSha256: hash,
    rollbackSha256: hash,
    roundtripSha256: hash,
    dryRunId: id(20),
    dryRunExpiresAt: future,
    custodyPolicyId: id(21),
    custodyEpoch: 1,
    custodyActivationEventId: id(22),
    nominatedOperatorId: id(23),
    planInitiatorId: id(1),
    actionType: 'config.audit_log_enable',
    desiredEnabled: true,
  });
  const journal: StandingJournal = {
    version: 1,
    tenantId: id(3),
    actorId: id(1),
    challengeId: null,
    challengeExpiresAt: null,
    intent: {
      phase: 'request',
      request: {
        schemaVersion: 1,
        operationKey: id(30),
        tenantId: id(3),
        ownerId: id(1),
        reviewerId: id(2),
        previousRevisionId: null,
        source,
        expiresAt: future,
        maxAuthorizations: 1,
        mode: 'individual',
        concurrency: 1,
        stopOnFailure: true,
        reason: 'Synthetic measured scope reviewed carefully.',
      },
    },
  };
  const context: StandingPolicyContext = {
    tenantId: id(3),
    actorId: id(1),
    checkedAt: new Date().toISOString(),
    candidates: [
      {
        policyName: 'Synthetic audit policy',
        ownerId: id(1),
        reviewerId: id(2),
        previousRevisionId: null,
        source,
      },
    ],
    revisions: [],
  };
  return { journal, context, source };
}
export const binding = (v: StandingJournal) => ({
  tenantId: v.tenantId,
  actorId: v.actorId,
  phase: v.intent.phase,
  operationKey: v.intent.request.operationKey,
});
