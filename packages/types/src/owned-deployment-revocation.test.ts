import { expect, it } from 'vitest';
import {
  ownedDeploymentRevocation,
  ownedDeploymentRevocationMfaEnvelope,
  ownedDeploymentMfaEnvelope,
  ownedDeploymentOperationCanonicalJSON,
  ownedDeploymentFence,
} from './owned-deployment.js';
const id = (n: number) => `89110000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const request = {
  operationKey: id(1),
  expectedManifestSha256: 'a'.repeat(64),
  expectedApprovalId: id(2),
  reason: 'Revoke only the recorded synthetic authority',
  acknowledgeOwnedSynthetic: true,
};
it('binds stop intent to exact recorded approval without replacement provider instructions', () => {
  expect(ownedDeploymentRevocation.parse(request)).toEqual(request);
  expect(ownedDeploymentRevocation.safeParse({ ...request, install: true }).success).toBe(false);
  expect(ownedDeploymentRevocation.safeParse({ ...request, sql: 'arbitrary' }).success).toBe(false);
});
it('keeps enrollment and revocation MFA envelopes purpose-disjoint', () => {
  expect(
    ownedDeploymentRevocationMfaEnvelope.safeParse({ request, challengeId: id(3), code: '123456' })
      .success,
  ).toBe(true);
  expect(ownedDeploymentMfaEnvelope.safeParse({ request, challengeId: id(3) }).success).toBe(false);
  expect(
    ownedDeploymentRevocationMfaEnvelope.safeParse({
      request: { ...request, expectedPreflightSha256: 'b'.repeat(64) },
    }).success,
  ).toBe(false);
});
it('canonical revocation recovery covers exact phase and source but never MFA codes', () => {
  const identity = {
    tenantId: id(4),
    actorId: id(5),
    requestId: id(6),
    operationKey: id(1),
    intent: { phase: 'revoke_verify', request, challengeId: id(3) },
  };
  const encoded = ownedDeploymentOperationCanonicalJSON(identity);
  expect(encoded).toContain('revoke_verify');
  expect(encoded).not.toContain('123456');
  expect(() =>
    ownedDeploymentOperationCanonicalJSON({
      ...identity,
      intent: { ...identity.intent, code: '123456' },
    }),
  ).toThrow();
  expect(
    ownedDeploymentFence.safeParse({
      operationKey: id(7),
      target: { phase: 'revocation', operationKey: id(1), canonicalRequestHash: 'a'.repeat(64) },
      reason: 'expired',
    }).success,
  ).toBe(true);
});
