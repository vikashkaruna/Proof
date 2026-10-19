import { describe, expect, it } from 'vitest';
import {
  OWNED_DEPLOYMENT_STEPS,
  ownedDeploymentRequest,
  ownedDeploymentFence,
  ownedDeploymentFenceResult,
  ownedDeploymentOperationReadback,
  ownedDeploymentOperationCanonicalJSON,
  ownedDeploymentSummary,
  type OwnedDeploymentSummary,
} from './owned-deployment';
const id = '89110000-0000-4000-8000-000000000001';
const hash = 'a'.repeat(64);
function fixture(): OwnedDeploymentSummary {
  return {
    requestId: id,
    tenantId: id,
    actorId: id,
    engagementId: id,
    connectorId: id,
    state: 'active',
    manifestSha256: hash,
    environment: 'local',
    label: 'Owned synthetic audit configuration',
    scope: 'owned_synthetic_config.audit_log_enable',
    fixtureId: id,
    resourceId: id,
    bindingId: id,
    custodyPolicyId: id,
    custodyEpoch: 1,
    requestedAt: '2026-10-19T00:00:00Z',
    expiresAt: '2026-10-20T00:00:00Z',
    reason: 'Explicit synthetic fixture validation only',
    preflight: {
      sha256: hash,
      completedAt: '2026-10-19T00:00:00Z',
      expiresAt: '2026-10-20T00:00:00Z',
      rollbackSha256: hash,
      dryRunCompleted: true,
      rollbackValidated: true,
      checks: [{ name: 'Synthetic scope', outcome: 'passed', detail: 'Reviewed local fixture' }],
      receiptId: '1',
    },
    approval: {
      approvalId: id,
      approvedBy: id,
      approvedAt: '2026-10-19T00:00:00Z',
      expiresAt: '2026-10-20T00:00:00Z',
      receiptId: '2',
    },
    installation: {
      operationKey: id,
      steps: OWNED_DEPLOYMENT_STEPS.map((step) => ({
        step,
        state: 'confirmed',
        receiptId: '3',
        detail: 'Actual readback confirmed',
      })),
      receiptId: '4',
    },
    limitations: ['Local synthetic boolean only; no production readiness claim'],
  };
}
describe('owned deployment shared browser contract', () => {
  it('accepts the actual fully confirmed state and an honest refused preflight', () => {
    expect(ownedDeploymentSummary.safeParse(fixture()).success).toBe(true);
    const refused = fixture();
    refused.state = 'preflight_refused';
    refused.approval = null;
    refused.installation = null;
    refused.preflight!.dryRunCompleted = false;
    refused.preflight!.rollbackValidated = false;
    refused.preflight!.checks[0]!.outcome = 'failed';
    expect(ownedDeploymentSummary.safeParse(refused).success).toBe(true);
  });
  it.each(['preflight', 'approval', 'installation'] as const)(
    'cannot claim active without recorded %s',
    (field) => {
      const value = fixture();
      value[field] = null;
      expect(ownedDeploymentSummary.safeParse(value).success).toBe(false);
    },
  );
  it.each(['dryRunCompleted', 'rollbackValidated'] as const)(
    'cannot be approved without %s',
    (field) => {
      const value = fixture();
      value.state = 'approved';
      value.preflight![field] = false;
      expect(ownedDeploymentSummary.safeParse(value).success).toBe(false);
    },
  );
  it('refuses duplicate or unconfirmed installation steps', () => {
    const value = fixture();
    value.installation!.steps[1]!.step = OWNED_DEPLOYMENT_STEPS[0];
    expect(ownedDeploymentSummary.safeParse(value).success).toBe(false);
    const uncertain = fixture();
    uncertain.installation!.steps[0]!.state = 'unconfirmed';
    expect(ownedDeploymentSummary.safeParse(uncertain).success).toBe(false);
    uncertain.state = 'unconfirmed';
    expect(ownedDeploymentSummary.safeParse(uncertain).success).toBe(true);
  });
  it('never accepts caller chosen authority or leaks installation credentials', () => {
    const value = {
      operationKey: id,
      engagementId: id,
      connectorId: id,
      manifestSha256: hash,
      reason: 'Explicit synthetic fixture validation only',
      acknowledgeOwnedSynthetic: true,
    };
    expect(ownedDeploymentRequest.safeParse(value).success).toBe(true);
    for (const field of ['role', 'targetUrl', 'workerUid', 'jwt', 'sql', 'spiffeId']) {
      expect(ownedDeploymentRequest.safeParse({ ...value, [field]: 'caller choice' }).success).toBe(
        false,
      );
      expect(
        ownedDeploymentSummary.safeParse({ ...fixture(), [field]: 'private value' }).success,
      ).toBe(false);
    }
  });
});

it('requires exact phase/key-bound readback and never returns verification codes', () => {
  const request = {
    operationKey: id,
    expectedManifestSha256: hash,
    expectedPreflightSha256: hash,
    expectedRollbackSha256: hash,
    reason: 'Explicit synthetic fixture validation only',
    acknowledgeOwnedSynthetic: true,
  };
  const value = {
    data: {
      requestId: id,
      tenantId: id,
      actorId: id,
      operationKey: id,
      phase: 'approve',
      outcome: 'recorded',
      canonicalRequestHash: hash,
      intent: { phase: 'approve', request, challengeId: id },
      receiptId: '9',
      result: fixture(),
      phaseResult: null,
    },
  };
  expect(ownedDeploymentOperationReadback.safeParse(value).success).toBe(true);
  expect(
    ownedDeploymentOperationReadback.safeParse({ data: { ...value.data, phase: 'verify' } })
      .success,
  ).toBe(false);
  expect(
    ownedDeploymentOperationReadback.safeParse({
      data: { ...value.data, intent: { ...value.data.intent, code: '123456' } },
    }).success,
  ).toBe(false);
  expect(
    ownedDeploymentOperationReadback.safeParse({ data: { ...value.data, outcome: 'not_recorded' } })
      .success,
  ).toBe(false);
  expect(
    ownedDeploymentOperationReadback.safeParse({
      data: {
        ...value.data,
        outcome: 'not_recorded',
        canonicalRequestHash: null,
        intent: null,
        receiptId: null,
        result: null,
      },
    }).success,
  ).toBe(true);
});

it('canonical operation codec is independently stable and phase/actor bound', () => {
  const request = {
    operationKey: id,
    engagementId: id,
    connectorId: id,
    manifestSha256: hash,
    reason: 'Explicit synthetic fixture validation only',
    acknowledgeOwnedSynthetic: true,
  };
  const value = {
    tenantId: id,
    actorId: id,
    requestId: id,
    operationKey: id,
    intent: { phase: 'request', request },
  };
  const encoded = ownedDeploymentOperationCanonicalJSON(value);
  expect(encoded).toBe(
    ownedDeploymentOperationCanonicalJSON({ ...value, intent: { request, phase: 'request' } }),
  );
  expect(encoded.startsWith('{"actorId":')).toBe(true);
  expect(
    ownedDeploymentOperationCanonicalJSON({
      ...value,
      actorId: '89110000-0000-4000-8000-000000000002',
    }),
  ).not.toBe(encoded);
});

it('allows explicit no-effect server fencing while refusing installer cancellation or client clearance', () => {
  const operationKey = '89110000-0000-4000-8000-000000000002';
  const target = { phase: 'decision', operationKey: id, canonicalRequestHash: hash };
  expect(ownedDeploymentFence.safeParse({ operationKey, target, reason: 'expired' }).success).toBe(
    true,
  );
  expect(
    ownedDeploymentFence.safeParse({ operationKey: id, target, reason: 'expired' }).success,
  ).toBe(false);
  expect(
    ownedDeploymentFence.safeParse({
      operationKey,
      target: { ...target, phase: 'install' },
      reason: 'expired',
    }).success,
  ).toBe(false);
  const receipt = {
    data: {
      requestId: id,
      tenantId: id,
      actorId: id,
      operationKey,
      target,
      disposition: 'fenced_no_mutation',
      previousState: 'expired_decision',
      requiresPreflight: true,
      fenceReceiptId: '8',
    },
  };
  expect(ownedDeploymentFenceResult.safeParse(receipt).success).toBe(true);
  expect(
    ownedDeploymentFenceResult.safeParse({
      data: { ...receipt.data, disposition: 'client_cleared' },
    }).success,
  ).toBe(false);
});

it('binds recovered fence receipt identity to its outer recorded operation receipt', () => {
  const operationKey = '89110000-0000-4000-8000-000000000002';
  const request = {
    operationKey,
    target: { phase: 'decision', operationKey: id, canonicalRequestHash: hash },
    reason: 'expired',
  };
  const receipt = {
    requestId: id,
    tenantId: id,
    actorId: id,
    operationKey,
    target: request.target,
    disposition: 'fenced_no_mutation',
    previousState: 'expired_decision',
    requiresPreflight: true,
    fenceReceiptId: '8',
  };
  const data = {
    requestId: id,
    tenantId: id,
    actorId: id,
    operationKey,
    phase: 'fence',
    outcome: 'recorded',
    canonicalRequestHash: hash,
    intent: { phase: 'fence', request },
    receiptId: '8',
    result: null,
    phaseResult: { phase: 'fence', receipt },
  };
  expect(ownedDeploymentOperationReadback.safeParse({ data }).success).toBe(true);
  expect(
    ownedDeploymentOperationReadback.safeParse({ data: { ...data, receiptId: '9' } }).success,
  ).toBe(false);
});

it('separates historical installation from current recorded credential scope', () => {
  for (const state of ['valid_recorded_scope', 'inactive', 'unconfirmed'] as const) {
    expect(
      ownedDeploymentSummary.safeParse({
        ...fixture(),
        currentAuthority: {
          state,
          detail: 'Live transport availability must be checked independently',
          credentialExpiresAt: state === 'valid_recorded_scope' ? '2026-10-19T00:15:00Z' : null,
        },
      }).success,
    ).toBe(true);
  }
  expect(
    ownedDeploymentSummary.safeParse({
      ...fixture(),
      currentAuthority: {
        state: 'live_worker_running',
        detail: 'Unsupported claim',
        credentialExpiresAt: null,
      },
    }).success,
  ).toBe(false);
});
