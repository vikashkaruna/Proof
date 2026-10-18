import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ApprovalEngine } from '@axiom/approval-engine';
import { ownedDeploymentOperationCanonicalJSON } from '@axiom/types';
import {
  OwnedDeploymentController,
  type OwnedDeploymentControllerPorts,
} from './owned-deployment-controller.js';
import { ownedEnrollmentDecisionHash } from './owned-deployment-approval.js';
import {
  ownedDeploymentManifest,
  ownedDeploymentManifestSha256,
} from './owned-deployment-manifest.js';
import { makeOwnedDeploymentManifest } from '../test/owned-deployment-fixture.js';
const id = (n: number) => `89110000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const manifest = ownedDeploymentManifest.parse(makeOwnedDeploymentManifest()),
    digest = ownedDeploymentManifestSha256(manifest);
  const context = {
    tenantId: manifest.tenantId,
    actorId: id(11),
    sessionId: id(12),
    expectedActorId: id(11),
  };
  const decision = {
    operationKey: id(13),
    expectedManifestSha256: digest,
    expectedPreflightSha256: 'b'.repeat(64),
    expectedRollbackSha256: 'c'.repeat(64),
    reason: 'Approve this exact synthetic-only scope',
    acknowledgeOwnedSynthetic: true as const,
  };
  const summary = {
    requestId: id(10),
    tenantId: manifest.tenantId,
    actorId: context.actorId,
    engagementId: manifest.engagementId,
    connectorId: manifest.connectorId,
    state: 'requested' as const,
    manifestSha256: digest,
    environment: manifest.environment,
    label: manifest.label,
    scope: manifest.scope,
    fixtureId: manifest.fixtureId,
    resourceId: manifest.resourceId,
    bindingId: manifest.bindingId,
    custodyPolicyId: manifest.custodyPolicyId,
    custodyEpoch: manifest.custodyEpoch,
    requestedAt: new Date().toISOString(),
    expiresAt: manifest.expiresAt,
    reason: decision.reason,
    preflight: null,
    approval: null,
    installation: null,
    limitations: manifest.limitations,
  };
  const humanRpc = vi.fn<OwnedDeploymentControllerPorts['humanRpc']>(async (name, args) => {
    if (name === 'read_owned_deployment_operation')
      return {
        data: {
          requestId: args.p_request_id,
          tenantId: context.tenantId,
          actorId: context.actorId,
          operationKey: decision.operationKey,
          phase: args.p_phase,
          outcome: 'not_recorded',
          canonicalRequestHash: null,
          intent: null,
          receiptId: null,
          result: null,
          phaseResult: null,
        },
      };
    if (name === 'record_owned_deployment_mfa_phase')
      return args.p_phase === 'challenge'
        ? {
            phase: 'challenge',
            challenge: {
              challengeId: id(14),
              expiresAt: new Date(Date.now() + 60000).toISOString(),
              maxAttempts: 5,
            },
          }
        : { phase: 'verify', verified: true };
    if (name === 'prepare_owned_deployment_request') return summary;
    if (name === 'read_owned_deployment_requests') return [summary];
    return { verified: true };
  });
  const ports: OwnedDeploymentControllerPorts = {
    humanRpc,
    serviceRpc: vi.fn(async () => null),
    manifests: vi.fn(async () => new Map([[digest, manifest]])),
    approval: new ApprovalEngine(Buffer.from('controller-unit-only-secret')),
    mfa: {
      issueChallenge: vi.fn<OwnedDeploymentControllerPorts['mfa']['issueChallenge']>(async () => ({
        ok: true,
        challengeId: id(14),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        maxAttempts: 5,
      })),
      verifyChallenge: vi.fn<OwnedDeploymentControllerPorts['mfa']['verifyChallenge']>(
        async () => ({
          ok: true,
          satisfiedWith: 'totp',
          challengeId: id(14),
          purpose: 'owned_synthetic_enrollment',
          boundResourceRef: decision.operationKey,
          factorId: id(15),
        }),
      ),
      consumeChallenge: vi.fn<OwnedDeploymentControllerPorts['mfa']['consumeChallenge']>(
        async () => ({
          ok: true,
          challengeId: id(14),
          satisfiedAt: new Date().toISOString(),
        }),
      ),
    },
  };
  return {
    manifest,
    digest,
    context,
    decision,
    summary,
    humanRpc,
    ports,
    controller: new OwnedDeploymentController(ports),
  };
}
it('uses only a protected matching manifest, never browser provider fields', async () => {
  const f = fixture();
  const request = {
    operationKey: id(10),
    engagementId: f.manifest.engagementId,
    connectorId: f.manifest.connectorId,
    manifestSha256: f.digest,
    reason: f.decision.reason,
    acknowledgeOwnedSynthetic: true,
  };
  await f.controller.request(f.context, request);
  expect(f.humanRpc).toHaveBeenCalledWith(
    'prepare_owned_deployment_request',
    expect.objectContaining({
      p_manifest: f.manifest,
      p_request: request,
      p_session_id: f.context.sessionId,
    }),
  );
  await expect(
    f.controller.request(f.context, { ...request, sql: 'grant arbitrary role' }),
  ).rejects.toThrow();
  await expect(f.controller.request({ ...f.context, tenantId: id(99) }, request)).rejects.toThrow();
  expect(f.humanRpc).toHaveBeenCalledTimes(1);
});
it('prepares the immutable decision before issuing the dedicated session-bound MFA purpose', async () => {
  const f = fixture();
  await f.controller.mfa(f.context, id(10), 'challenge', { request: f.decision });
  expect(f.humanRpc.mock.calls.map(([name]) => name)).toEqual([
    'read_owned_deployment_operation',
    'prepare_owned_deployment_decision',
    'record_owned_deployment_mfa_phase',
  ]);
  expect(f.ports.mfa.issueChallenge).toHaveBeenCalledWith(
    expect.objectContaining({
      purpose: 'owned_synthetic_enrollment',
      sessionId: f.context.sessionId,
      boundResourceRef: f.decision.operationKey,
      boundPayloadSha256: ownedEnrollmentDecisionHash(f.context, id(10), f.decision),
    }),
  );
  expect(f.ports.mfa.consumeChallenge).not.toHaveBeenCalled();
});
it('recovers a lost verify reply before using or retaining the code again', async () => {
  const f = fixture(),
    intent = { phase: 'verify' as const, request: f.decision, challengeId: id(14) };
  const canonicalRequestHash = createHash('sha256')
    .update(
      ownedDeploymentOperationCanonicalJSON({
        tenantId: f.context.tenantId,
        actorId: f.context.actorId,
        requestId: id(10),
        operationKey: f.decision.operationKey,
        intent,
      }),
    )
    .digest('hex');
  f.humanRpc.mockResolvedValueOnce({
    data: {
      requestId: id(10),
      tenantId: f.context.tenantId,
      actorId: f.context.actorId,
      operationKey: f.decision.operationKey,
      phase: 'verify',
      outcome: 'recorded',
      canonicalRequestHash,
      intent,
      receiptId: '1',
      result: f.summary,
      phaseResult: { phase: 'verify', verified: true },
    },
  });
  expect(
    await f.controller.mfa(f.context, id(10), 'verify', {
      request: f.decision,
      challengeId: id(14),
      code: '123456',
    }),
  ).toEqual({ data: { verified: true } });
  expect(f.ports.mfa.verifyChallenge).not.toHaveBeenCalled();
  expect(f.humanRpc).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.humanRpc.mock.calls)).not.toContain('123456');
});
it('does not recover a foreign actor receipt or consume a different MFA purpose', async () => {
  const f = fixture();
  f.humanRpc.mockResolvedValueOnce({
    data: {
      requestId: id(10),
      tenantId: f.context.tenantId,
      actorId: id(99),
      operationKey: f.decision.operationKey,
      phase: 'verify',
      outcome: 'not_recorded',
      canonicalRequestHash: null,
      intent: null,
      receiptId: null,
      result: null,
      phaseResult: null,
    },
  });
  await expect(
    f.controller.mfa(f.context, id(10), 'verify', {
      request: f.decision,
      challengeId: id(14),
      code: '123456',
    }),
  ).rejects.toThrow();
  expect(f.ports.mfa.verifyChallenge).not.toHaveBeenCalled();
  const g = fixture();
  vi.mocked(g.ports.mfa.verifyChallenge).mockResolvedValueOnce({
    ok: true,
    satisfiedWith: 'totp',
    challengeId: id(14),
    purpose: 'plan_approve',
    boundResourceRef: g.decision.operationKey,
    factorId: id(15),
  });
  await expect(
    g.controller.mfa(g.context, id(10), 'verify', {
      request: g.decision,
      challengeId: id(14),
      code: '123456',
    }),
  ).rejects.toThrow();
  expect(g.humanRpc.mock.calls.map(([name]) => name)).not.toContain(
    'record_owned_deployment_mfa_phase',
  );
});
