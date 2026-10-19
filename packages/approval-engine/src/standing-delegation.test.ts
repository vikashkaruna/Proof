import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  standingPolicyDelegation,
  encodeStandingRevisionIntent,
  encodeStandingPolicyDelegation,
  type StandingPolicyDelegation,
} from '@axiom/types';
import { ApprovalEngine } from './index.js';
const id = (n: number) => `17310000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
function fixture() {
  const request = {
    schemaVersion: 1 as const,
    operationKey: id(1),
    tenantId: id(2),
    ownerId: id(3),
    reviewerId: id(4),
    previousRevisionId: null,
    expiresAt: '2030-01-01T00:00:00Z',
    maxAuthorizations: 1 as const,
    mode: 'individual' as const,
    concurrency: 1 as const,
    stopOnFailure: true as const,
    reason: 'Explicit isolated synthetic standing delegation',
    source: {
      policyId: id(5),
      policyVersion: 1,
      policySha256: '9'.repeat(64),
      policyExpiresAt: '2030-01-01T00:00:00Z',
      planId: id(6),
      planVersion: 1,
      actionId: id(7),
      contentDigest: 'a'.repeat(64),
      bindingId: id(8),
      connectorId: id(9),
      engagementId: id(10),
      fixtureId: id(11),
      resourceId: id(12),
      deploymentRequestId: id(13),
      deploymentApprovalId: id(14),
      deploymentExpiresAt: '2030-01-01T00:00:00Z',
      environment: 'local' as const,
      engineSha256: 'b'.repeat(64),
      capabilitySha256: 'c'.repeat(64),
      snapshotSha256: 'd'.repeat(64),
      rollbackSha256: 'e'.repeat(64),
      roundtripSha256: 'f'.repeat(64),
      dryRunId: id(15),
      dryRunExpiresAt: '2030-01-01T00:00:00Z',
      custodyPolicyId: id(16),
      custodyEpoch: 1,
      custodyActivationEventId: id(17),
      nominatedOperatorId: id(18),
      planInitiatorId: id(3),
      actionType: 'config.audit_log_enable' as const,
      desiredEnabled: true as const,
    },
  };
  const value = standingPolicyDelegation.parse({
    schemaVersion: 1,
    purpose: 'axiom.standing-policy-delegation.v1',
    tenantId: id(2),
    revisionId: id(1),
    requestSha256: createHash('sha256')
      .update(encodeStandingRevisionIntent({ phase: 'request', request }))
      .digest('hex'),
    request,
    ownerDecision: { actorId: id(3), challengeId: id(30), receiptId: '10' },
    reviewerDecision: { actorId: id(4), challengeId: id(31), receiptId: '11' },
  });
  const engine = new ApprovalEngine();
  engine.setTenantSecret(id(2), 'Synthetic 173 first signing key');
  engine.setTenantSecret(id(99), 'Synthetic 173 other signing key');
  return { engine, value };
}
it('signs only the exact typed delegation under its configured tenant key', () => {
  const { engine, value } = fixture();
  const sig = engine.signStandingDelegation(id(2), value);
  expect(engine.verifyStandingDelegation(id(2), value, sig)).toBe(true);
  expect(engine.verifyStandingDelegation(id(99), value, sig)).toBe(false);
  expect(engine.verifyStandingDelegation(id(2), value, 'not-hex')).toBe(false);
});
it('normalizes object key order but invalidates actual approved metadata changes', () => {
  const { engine, value } = fixture();
  const sig = engine.signStandingDelegation(id(2), value);
  const reordered = Object.fromEntries(Object.entries(value).reverse()) as StandingPolicyDelegation;
  expect(engine.signStandingDelegation(id(2), reordered)).toBe(sig);
  expect(
    engine.verifyStandingDelegation(
      id(2),
      { ...value, reviewerDecision: { ...value.reviewerDecision, receiptId: '12' } },
      sig,
    ),
  ).toBe(false);
});
it('cannot be replayed as a remediation execution approval or raw detached statement', async () => {
  const { engine, value } = fixture();
  const sig = engine.signStandingDelegation(id(2), value);
  const token = await engine.issue(id(2), {
    planId: value.request.source.planId,
    actionIds: [value.request.source.actionId],
    approverId: value.request.reviewerId,
    mode: 'individual',
    concurrency: 1,
    stopOnFailure: true,
    expiresAt: value.request.expiresAt,
    contentDigest: value.request.source.contentDigest,
  });
  expect(await engine.verify(id(2), { spec: token.spec, signature: sig })).toMatchObject({
    valid: false,
    reason: 'signature_mismatch',
  });
  expect(engine.verifyDetachedStatement(id(2), encodeStandingPolicyDelegation(value), sig)).toBe(
    false,
  );
});
it('rejects mismatched canonical request digest before signing', () => {
  const { engine, value } = fixture();
  expect(() =>
    engine.signStandingDelegation(id(2), { ...value, requestSha256: 'a'.repeat(64) }),
  ).toThrow('scope digest refused');
});
it.each([
  (v: StandingPolicyDelegation) => ({ ...v, purpose: 'remediation_execution_v1' }),
  (v: StandingPolicyDelegation) => ({ ...v, password: 'not-a-credential' }),
  (v: StandingPolicyDelegation) => ({ ...v, reviewerDecision: v.ownerDecision }),
  (v: StandingPolicyDelegation) => ({ ...v, request: { ...v.request, maxAuthorizations: 2 } }),
])('refuses another domain, unknown fields, same-human proof and broadened scope', (change) => {
  const { engine, value } = fixture();
  expect(() =>
    engine.signStandingDelegation(id(2), change(value) as StandingPolicyDelegation),
  ).toThrow();
});

it('binds approval and revocation to distinct canonical intents', () => {
  const request = {
    schemaVersion: 1 as const,
    operationKey: id(41),
    revisionId: id(42),
    requestSha256: 'a'.repeat(64),
    reason: 'An explicitly reviewed decision reason',
  };
  expect(encodeStandingRevisionIntent({ phase: 'approve', request })).not.toBe(
    encodeStandingRevisionIntent({ phase: 'revoke', request }),
  );
});
