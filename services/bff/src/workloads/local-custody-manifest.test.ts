import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseLocalCustodyPolicyText } from '@axiom/types';
import { buildLocalCustodyManifest } from './local-custody-manifest.js';

const input = {
  tenantId: 'fd5e0001-0000-4000-8000-000000000001',
  targetWorkloadId: 'ce5ae6ce-cae4-4a5e-a8ab-8e08591b9e61',
  nominatedOperatorId: '33333333-3333-4333-8333-333333333333',
  trustDomain: 'local.axiomproof.test',
  deploymentBindingSha256: 'b'.repeat(64),
  reviewDueAt: 1_800_000_000_000,
  reason: 'Local retained runtime',
};
const policyId = '44444444-4444-4444-8444-444444444444';

describe('local custody manifest', () => {
  it('builds an operator_managed, tenant-bound policy with a verifiable digest', () => {
    const m = buildLocalCustodyManifest(input, policyId);
    expect(m.policySha256).toBe(createHash('sha256').update(m.policyText).digest('hex'));
    const p = parseLocalCustodyPolicyText(m.policyText);
    expect(p).toMatchObject({
      policyId,
      tenantId: input.tenantId,
      mode: 'operator_managed',
      targetWorkloadId: input.targetWorkloadId,
      nominatedOperatorId: input.nominatedOperatorId,
      deploymentBindingSha256: input.deploymentBindingSha256,
      statutoryComplianceAsserted: false,
      ownershipVerified: false,
      servicePrincipals: {
        producer: 'spiffe://local.axiomproof.test/service/assessment-dispatch-producer',
        controller: 'spiffe://local.axiomproof.test/controller/assessment',
      },
    });
    expect(p.keyPolicy).toEqual({ primary: m.primaryKeyRef, readable: [m.primaryKeyRef] });
    expect(m.primaryKeyRef).toBe(`axiom-local-dispatch://${input.tenantId}/${policyId}/versions/1`);
  });
  it('is deterministic for a policy ID and distinct per tenant', () => {
    const a = buildLocalCustodyManifest(input, policyId);
    expect(buildLocalCustodyManifest(input, policyId)).toEqual(a);
    const other = buildLocalCustodyManifest(
      { ...input, tenantId: 'fd5e0002-0000-4000-8000-000000000002' },
      policyId,
    );
    expect(other.policySha256).not.toBe(a.policySha256);
  });
  it.each([
    { tenantId: 'FD5E0001-0000-4000-8000-000000000001' },
    { deploymentBindingSha256: 'short' },
    { trustDomain: 'Bad Domain' },
    { reason: '' },
    { extra: true },
  ])('refuses invalid input %o', (over) => {
    expect(() => buildLocalCustodyManifest({ ...input, ...over } as never, policyId)).toThrow();
  });
});
