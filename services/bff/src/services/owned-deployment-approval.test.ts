import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ownedDeploymentOperationCanonicalJSON } from '@axiom/types';
import { ApprovalEngine, type SignedApprovalToken } from '@axiom/approval-engine';
import type { OwnedDeploymentDecision } from '@axiom/types';
import { makeOwnedDeploymentManifest } from '../test/owned-deployment-fixture.js';
import {
  ownedDeploymentManifest,
  ownedDeploymentManifestSha256,
} from './owned-deployment-manifest.js';
import {
  OwnedDeploymentApprovals,
  type OwnedDeploymentApprovalSource,
  type OwnedDeploymentApprovalPorts,
} from './owned-deployment-approval.js';
const id = (n: number) => `89110000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function fixture() {
  const m = ownedDeploymentManifest.parse(makeOwnedDeploymentManifest()),
    hash = ownedDeploymentManifestSha256(m),
    now = Date.now();
  const current: OwnedDeploymentApprovalSource = {
    manifest: m,
    summary: {
      requestId: id(10),
      tenantId: m.tenantId,
      actorId: id(11),
      engagementId: m.engagementId,
      connectorId: m.connectorId,
      state: 'preflight_ready',
      manifestSha256: hash,
      environment: 'local',
      label: 'Owned synthetic audit configuration',
      scope: 'owned_synthetic_config.audit_log_enable',
      fixtureId: m.fixtureId,
      resourceId: m.resourceId,
      bindingId: m.bindingId,
      custodyPolicyId: m.custodyPolicyId,
      custodyEpoch: 1,
      requestedAt: new Date(now - 1000).toISOString(),
      expiresAt: m.expiresAt,
      reason: 'Synthetic fixture enrollment requested for validation',
      preflight: {
        sha256: 'b'.repeat(64),
        completedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 240000).toISOString(),
        rollbackSha256: 'c'.repeat(64),
        dryRunCompleted: true,
        rollbackValidated: true,
        checks: [
          {
            name: 'Fixture-only host checks',
            outcome: 'passed',
            detail: 'Unit fixture; no actual Docker inspection',
          },
        ],
        receiptId: '1',
      },
      approval: null,
      installation: null,
      limitations: m.limitations,
    },
  };
  const context = {
    tenantId: m.tenantId,
    actorId: id(12),
    expectedActorId: id(12),
    sessionId: id(13),
  };
  const decision: OwnedDeploymentDecision = {
    operationKey: id(14),
    expectedManifestSha256: hash,
    expectedPreflightSha256: 'b'.repeat(64),
    expectedRollbackSha256: 'c'.repeat(64),
    reason: 'Approve only this synthetic fixture deployment',
    acknowledgeOwnedSynthetic: true,
  };
  const engine = new ApprovalEngine(Buffer.from('synthetic-enrollment-unit-signing-secret'));
  const issue = vi.spyOn(engine, 'issue');
  let retainedToken: SignedApprovalToken | undefined;
  const ports = {
    authorizeFounder: vi.fn(async () => {}),
    recoverApproval: vi.fn<OwnedDeploymentApprovalPorts['recoverApproval']>(async () => null),
    loadCurrentSource: vi.fn(async () => structuredClone(current)),
    loadApprovedInstallerSource: vi.fn<OwnedDeploymentApprovalPorts['loadApprovedInstallerSource']>(
      async () => ({
        source: structuredClone(current),
        decision,
        token: retainedToken,
      }),
    ),
    consumeBoundFounderMfa: vi.fn(async () => {}),
    recordApproved: vi.fn<OwnedDeploymentApprovalPorts['recordApproved']>(
      async (_context, input) => {
        retainedToken = input.token;
        current.summary.state = 'approved';
        current.summary.approval = {
          approvalId: id(15),
          approvedBy: context.actorId,
          approvedAt: new Date().toISOString(),
          expiresAt: input.token.spec.expiresAt,
          receiptId: '2',
        };
        return structuredClone(current.summary);
      },
    ),
  };
  const service = new OwnedDeploymentApprovals(ports, engine);
  const approve = () => service.approve(context, current.summary.requestId, decision, id(16));
  return { current, context, decision, ports, engine, issue, service, approve };
}
it('issues a distinct signed enrollment domain only after actual source and bound founder MFA gates', async () => {
  const f = await fixture();
  expect((await f.approve()).state).toBe('approved');
  expect(f.ports.consumeBoundFounderMfa).toHaveBeenCalledOnce();
  expect(f.ports.loadCurrentSource).toHaveBeenCalledTimes(2);
  expect(f.issue.mock.invocationCallOrder[0]).toBeGreaterThan(
    f.ports.consumeBoundFounderMfa.mock.invocationCallOrder[0]!,
  );
  const token = f.ports.recordApproved.mock.calls[0]![1].token;
  expect(token.spec.actionIds).toHaveLength(6);
  expect(new Set(token.spec.actionIds).size).toBe(6);
  expect(await f.engine.verify(f.context.tenantId, token)).toEqual({
    valid: false,
    reason: 'purpose_mismatch',
  });
  await f.service.verifyInstallerToken(
    f.context.tenantId,
    f.current.summary.requestId,
    token,
    'enroll_synthetic_resource',
  );
});
it.each(['rollbackValidated', 'dryRunCompleted'] as const)(
  'cannot sign with missing actual %s',
  async (field) => {
    const f = await fixture();
    f.current.summary.preflight![field] = false;
    await expect(f.approve()).rejects.toThrow();
    expect(f.issue).not.toHaveBeenCalled();
    expect(f.ports.consumeBoundFounderMfa).not.toHaveBeenCalled();
  },
);
it('refuses owner or stale actor before issuing any token', async () => {
  const f = await fixture();
  f.ports.authorizeFounder.mockRejectedValueOnce(Error('Founder required'));
  await expect(f.approve()).rejects.toThrow();
  expect(f.issue).not.toHaveBeenCalled();
  f.context.expectedActorId = id(99);
  await expect(f.approve()).rejects.toThrow();
  expect(f.issue).not.toHaveBeenCalled();
});
it('cannot sign changed or expired source after valid MFA', async () => {
  const f = await fixture();
  f.ports.consumeBoundFounderMfa.mockImplementation(async () => {
    f.current.summary.custodyEpoch++;
  });
  await expect(f.approve()).rejects.toThrow();
  expect(f.issue).not.toHaveBeenCalled();
});
it('recovers the exact prior approval before attempting consumed MFA', async () => {
  const f = await fixture();
  const prior = await f.approve();
  const identity = {
    tenantId: f.context.tenantId,
    actorId: f.context.actorId,
    requestId: f.current.summary.requestId,
    operationKey: f.decision.operationKey,
    intent: { phase: 'approve', request: f.decision, challengeId: id(16) },
  };
  f.ports.recoverApproval.mockResolvedValueOnce({
    data: {
      ...identity,
      phase: 'approve',
      outcome: 'recorded',
      canonicalRequestHash: createHash('sha256')
        .update(ownedDeploymentOperationCanonicalJSON(identity))
        .digest('hex'),
      receiptId: '2',
      result: prior,
      phaseResult: null,
    },
  });
  f.ports.consumeBoundFounderMfa.mockRejectedValue(Error('Already consumed'));
  expect(await f.approve()).toEqual(prior);
  expect(f.issue).toHaveBeenCalledOnce();
  expect(f.ports.consumeBoundFounderMfa).toHaveBeenCalledOnce();
});
it('refuses tampered signature, foreign persisted token, changed scope and revoked deployment at every step', async () => {
  const f = await fixture();
  await f.approve();
  const token = f.ports.recordApproved.mock.calls[0]![1].token;
  const forged = { ...token, signature: 'a'.repeat(64) };
  await expect(
    f.service.verifyInstallerToken(
      f.context.tenantId,
      f.current.summary.requestId,
      forged,
      'authorize_role_switch',
    ),
  ).rejects.toThrow();
  await expect(
    f.service.verifyInstallerToken(f.context.tenantId, id(99), token, 'authorize_role_switch'),
  ).rejects.toThrow();
  const changed = {
    ...f.current,
    manifest: {
      ...f.current.manifest,
      deployment: { ...f.current.manifest.deployment, workerUid: 0 },
    },
  };
  f.ports.loadApprovedInstallerSource.mockResolvedValueOnce({
    source: changed,
    decision: f.decision,
    token,
  });
  await expect(
    f.service.verifyInstallerToken(
      f.context.tenantId,
      f.current.summary.requestId,
      token,
      'stage_owned_controller',
    ),
  ).rejects.toThrow();
  f.current.summary.state = 'revoked';
  await expect(
    f.service.verifyInstallerToken(
      f.context.tenantId,
      f.current.summary.requestId,
      token,
      'verify_installed_scope',
    ),
  ).rejects.toThrow();
});

it('never recovers a foreign or merely similar receipt as confirmed approval', async () => {
  const f = await fixture();
  const prior = await f.approve();
  f.ports.recoverApproval.mockResolvedValueOnce({
    data: {
      requestId: f.current.summary.requestId,
      tenantId: f.context.tenantId,
      actorId: id(99),
      operationKey: f.decision.operationKey,
      phase: 'approve',
      outcome: 'recorded',
      canonicalRequestHash: 'a'.repeat(64),
      intent: { phase: 'approve', request: f.decision, challengeId: id(16) },
      receiptId: '2',
      result: prior,
      phaseResult: null,
    },
  });
  await expect(f.approve()).rejects.toThrow('Owned deployment approval refused');
  expect(f.issue).toHaveBeenCalledOnce();
});
