import { describe, it, expect } from 'vitest';
import {
  coverageScopeIntent,
  coverageScopeOperation,
  coverageProducerAssignment,
  coverageFireOutcome,
  encodeCoverageScopeIntent,
} from './scheduled-coverage.js';
const id = (n: number) => `17510000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = 'a'.repeat(64);
const source = {
  scheduleId: id(1),
  readScopeId: id(2),
  estateId: id(3),
  connectorId: id(4),
  grantId: id(5),
  configurationSha256: sha,
  cadence: '*/5 * * * *',
  workloadId: id(6),
  custodyPolicyId: id(7),
  custodyPolicySha256: sha,
  keyPolicySha256: sha,
  custodyActivationEventId: id(8),
  custodyEpoch: 1,
  deploymentBindingSha256: sha,
  baselineRunId: id(9),
  baselineResultSha256: sha,
  preflightFireId: id(10),
  preflightDiscoveryRequestId: id(11),
  preflightDiscoveryId: id(12),
  preflightResultSha256: sha,
  catalogue: {
    libraryVersion: '0.1.1',
    rowsSha256: sha,
    questionnaireDigest: sha,
    manifestSha256: sha,
    selectionOperationKey: null,
  },
};
const request = {
  schemaVersion: 1,
  purpose: 'axiom.scheduled-coverage.authority.v1',
  operationKey: id(13),
  tenantId: id(14),
  ownerId: id(15),
  previousScopeId: null,
  source,
  expiresAt: '2030-01-01T00:00:00Z',
  maxFires: 2,
  taskScopes: ['control_library.read', 'findings.write'],
  declarationPolicy: 'all_business_facts_unknown',
  discoveryUse: 'technical_provenance_only',
  reason: 'Owner explicitly reviewed this scheduled unknown-only coverage scope',
};
describe('scheduled coverage authority contract', () => {
  it('preserves the full exact authority and declaration limitations', () => {
    const v = coverageScopeIntent.parse({ phase: 'authorize', request });
    expect(JSON.parse(encodeCoverageScopeIntent(v))).toEqual(v);
  });
  it.each([
    { maxFires: 0 },
    { maxFires: 25 },
    { taskScopes: ['findings.write', 'control_library.read'] },
    { taskScopes: ['control_library.read', 'findings.write', 'connector.write'] },
    { declarationPolicy: 'reuse_previous_answers' },
    { discoveryUse: 'infer_legal_facts' },
    { answers: { consent: true } },
  ])('refuses caller authority expansion %o', (change) => {
    expect(
      coverageScopeIntent.safeParse({ phase: 'authorize', request: { ...request, ...change } })
        .success,
    ).toBe(false);
  });
  it('binds phase into the canonical operation and refuses unknown phases', () => {
    const revoke = {
      schemaVersion: 1,
      operationKey: id(16),
      scopeId: id(13),
      requestSha256: sha,
      reason: request.reason,
    };
    expect(
      encodeCoverageScopeIntent(coverageScopeIntent.parse({ phase: 'revoke', request: revoke })),
    ).toContain('"phase":"revoke"');
    expect(coverageScopeIntent.safeParse({ phase: 'execute', request: revoke }).success).toBe(
      false,
    );
  });
  it('requires explicit actor/tenant/phase/operation recovery proof', () => {
    const p = {
      tenantId: id(14),
      actorId: id(15),
      phase: 'authorize',
      operationKey: id(13),
      requestSha256: sha,
      recorded: false,
      fenced: false,
      fenceReceiptId: null,
      challengeExpiresAt: null,
    };
    expect(coverageScopeOperation.safeParse(p).success).toBe(true);
    for (const key of ['tenantId', 'actorId', 'phase', 'operationKey']) {
      const copy: Record<string, unknown> = { ...p };
      delete copy[key];
      expect(coverageScopeOperation.safeParse(copy).success).toBe(false);
    }
    expect(coverageScopeOperation.safeParse({ ...p, fenced: true }).success).toBe(false);
  });
  it('never describes unconfirmed work as a finalized result', () => {
    const p = {
      tenantId: id(14),
      fireId: id(17),
      engagementId: id(18),
      jobId: id(19),
      runId: null,
      receiptId: null,
      resultDigest: null,
      state: 'unconfirmed',
    };
    expect(coverageFireOutcome.safeParse(p).success).toBe(true);
    expect(
      coverageFireOutcome.safeParse({ ...p, state: 'finalized', resultDigest: sha }).success,
    ).toBe(false);
    expect(
      coverageFireOutcome.safeParse({
        ...p,
        state: 'finalized',
        runId: id(20),
        receiptId: '25',
        resultDigest: sha,
      }).success,
    ).toBe(true);
  });
  it('does not accept generic actor/input fields in the reference protocol', () => {
    expect(
      coverageProducerAssignment.safeParse({
        tenantId: id(14),
        fireId: id(17),
        actorId: id(15),
        input: { answers: { yes: true } },
      }).success,
    ).toBe(false);
  });
});
