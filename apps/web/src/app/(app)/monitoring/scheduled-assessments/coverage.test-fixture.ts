import { coverageScopeContext, coverageScopeIntent } from '@axiom/types';
import type { CoverageJournal } from './coverage-journal';
export const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const hash = 'a'.repeat(64);
export function fixture() {
  const source = {
    scheduleId: id(10),
    readScopeId: id(11),
    estateId: id(12),
    connectorId: id(13),
    grantId: id(14),
    configurationSha256: hash,
    cadence: '*/5 * * * *',
    workloadId: id(15),
    custodyPolicyId: id(16),
    custodyPolicySha256: hash,
    keyPolicySha256: hash,
    custodyActivationEventId: id(17),
    custodyEpoch: 1,
    deploymentBindingSha256: hash,
    baselineRunId: id(18),
    baselineResultSha256: hash,
    preflightFireId: id(19),
    preflightDiscoveryRequestId: id(20),
    preflightDiscoveryId: id(21),
    preflightResultSha256: hash,
    catalogue: {
      libraryVersion: '0.1.1',
      rowsSha256: hash,
      questionnaireDigest: hash,
      manifestSha256: hash,
      selectionOperationKey: null,
    },
  };
  const intent = coverageScopeIntent.parse({
    phase: 'authorize',
    request: {
      schemaVersion: 1,
      purpose: 'axiom.scheduled-coverage.authority.v1',
      operationKey: id(30),
      tenantId: id(3),
      ownerId: id(1),
      previousScopeId: null,
      source,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      maxFires: 2,
      taskScopes: ['control_library.read', 'findings.write'],
      declarationPolicy: 'all_business_facts_unknown',
      discoveryUse: 'technical_provenance_only',
      reason: 'Synthetic technical coverage only; legal facts remain unknown.',
    },
  });
  const journal: CoverageJournal = {
    version: 1,
    tenantId: id(3),
    actorId: id(1),
    intent,
    challengeId: null,
    challengeExpiresAt: null,
  };
  const context = coverageScopeContext.parse({
    tenantId: id(3),
    actorId: id(1),
    checkedAt: new Date().toISOString(),
    candidates: [
      { source, previousScopeId: null, maxExpiresAt: new Date(Date.now() + 1800000).toISOString() },
    ],
    scopes: [],
    fires: [],
  });
  return { source, journal, context };
}
export const binding = (v: CoverageJournal) => ({
  tenantId: v.tenantId,
  actorId: v.actorId,
  phase: v.intent.phase,
  operationKey: v.intent.request.operationKey,
});
