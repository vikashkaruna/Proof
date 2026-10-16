import { describe, it, expect } from 'vitest';
import {
  encodeLocalCustodyPolicy,
  encodeLocalCustodyCancellation,
  parseLocalCustodyPolicyText,
  encodeLocalCustodyEvent,
  localCustodyEventRequestSchema,
} from './local-custody-policy';
const tenant = '11111111-1111-4111-8111-111111111111',
  policyId = '22222222-2222-4222-8222-222222222222',
  operator = '33333333-3333-4333-8333-333333333333';
const ref = `axiom-local-dispatch://${tenant}/${policyId}/versions/1`;
const value = {
  version: 1,
  policyId,
  tenantId: tenant,
  mode: 'operator_managed',
  nominatedOperatorId: operator,
  targetWorkloadId: '66666666-6666-4666-8666-666666666666',
  servicePrincipals: {
    producer: 'spiffe://local.axiom/service/assessment-dispatch-producer',
    controller: 'spiffe://local.axiom/controller/assessment',
  },
  validity: { kind: 'until_revoked', reviewDueAt: 1 },
  actionClass: 'assessment_dispatch_key_custody',
  keyPolicy: { primary: ref, readable: [ref] },
  keyPolicySha256: 'a'.repeat(64),
  deploymentBindingSha256: 'b'.repeat(64),
  reason: 'Operator-managed local custody with reviewed limitations.',
  acceptedLimitations: ['hardware_backing_unverified'],
  statutoryComplianceAsserted: false,
  ownershipVerified: false,
};
describe('strict local custody policy bytes', () => {
  it('retains overdue review metadata without asserting expiry or legal compliance', () => {
    const text = encodeLocalCustodyPolicy(value);
    expect(parseLocalCustodyPolicyText(text)).toEqual(value);
    expect(encodeLocalCustodyPolicy({ ...value, reason: 'मराठी 😀' })).toContain('मराठी 😀');
    expect(encodeLocalCustodyPolicy(Object.fromEntries(Object.entries(value).reverse()))).toBe(
      text,
    );
  });
  it.each([
    { mode: 'aws' },
    { actionClass: 'override_all' },
    { acceptedLimitations: ['disable_mfa'] },
    { acceptedLimitations: ['disable_object_lock'] },
    {
      servicePrincipals: {
        producer: 'spiffe://local.axiom/agent/sudhaar',
        controller: 'spiffe://local.axiom/controller/assessment',
      },
    },
    { statutoryComplianceAsserted: true },
    { ownershipVerified: true },
    { validity: { kind: 'fixed_expiry', expiresAt: 1 } },
    { reason: '\ud800' },
    { tenantId: operator },
    { keyPolicy: { primary: ref, readable: [ref, ref] } },
    { acceptedLimitations: ['hardware_backing_unverified', 'hardware_backing_unverified'] },
  ])('rejects unsupported or ambiguous policy %j', (change) => {
    expect(() => encodeLocalCustodyPolicy({ ...value, ...change })).toThrow();
  });
  it.each(['..', '.local', 'local.', '-local', 'local-', 'a..b', 'LOCAL', 'a b', 'a'.repeat(256)])(
    'rejects invalid service trust domain %s for either fixed principal',
    (domain) => {
      for (const kind of ['producer', 'controller'] as const) {
        const path =
          kind === 'producer' ? 'service/assessment-dispatch-producer' : 'controller/assessment';
        expect(() =>
          encodeLocalCustodyPolicy({
            ...value,
            servicePrincipals: { ...value.servicePrincipals, [kind]: `spiffe://${domain}/${path}` },
          }),
        ).toThrow();
      }
    },
  );
  it.each(['a', 'local.axiom', 'a-b.c', 'a'.repeat(255)])(
    'accepts canonical bounded trust domain %s',
    (domain) => {
      const servicePrincipals = {
        producer: `spiffe://${domain}/service/assessment-dispatch-producer`,
        controller: `spiffe://${domain}/controller/assessment`,
      };
      expect(
        parseLocalCustodyPolicyText(encodeLocalCustodyPolicy({ ...value, servicePrincipals }))
          .servicePrincipals,
      ).toEqual(servicePrincipals);
    },
  );
  it('refuses duplicate escaped members and altered retained bytes', () => {
    const text = encodeLocalCustodyPolicy(value);
    for (const bad of [' ' + text, text.replace('"version":1', '"version":1,"vers\\u0069on":1')])
      expect(() => parseLocalCustodyPolicyText(bad)).toThrow();
  });
  it('requires exact predecessor and confirmation per operation', () => {
    const request = {
      version: 1,
      operationKey: operator,
      transition: 'request',
      policyText: encodeLocalCustodyPolicy(value),
      policySha256: 'c'.repeat(64),
      previousEventId: null,
      nextReviewDueAt: null,
      reason: 'Request',
      confirmed: true,
    };
    expect(encodeLocalCustodyEvent(request)).toContain('Request');
    expect(
      localCustodyEventRequestSchema.safeParse({ ...request, transition: 'approve' }).success,
    ).toBe(false);
    expect(localCustodyEventRequestSchema.safeParse({ ...request, confirmed: false }).success).toBe(
      false,
    );
  });
});
it('cancellation retains exact original bytes under distinct key and rejects ambiguous/oversized intent', () => {
  const original = encodeLocalCustodyEvent({
    version: 1,
    operationKey: policyId,
    transition: 'request',
    policyText: encodeLocalCustodyPolicy(value),
    policySha256: 'a'.repeat(64),
    previousEventId: null,
    nextReviewDueAt: null,
    reason: 'Request',
    confirmed: true,
  });
  const c = {
    version: 1,
    operationKey: operator,
    originalRequestText: original,
    reason: 'Abandon stale intent',
    confirmed: true,
  };
  expect(JSON.parse(encodeLocalCustodyCancellation(c))).toEqual(c);
  for (const changed of [
    { operationKey: policyId },
    { operationKey: null },
    { confirmed: false },
    { reason: ' ' },
    { originalRequestText: original + ' ' },
    { originalRequestText: JSON.stringify({ ...JSON.parse(original), operationKey: null }) },
  ])
    expect(() => encodeLocalCustodyCancellation({ ...c, ...changed })).toThrow();
  expect(encodeLocalCustodyCancellation({ ...c, reason: '😀'.repeat(1500) })).toContain('😀');
  expect(() => encodeLocalCustodyCancellation({ ...c, reason: '😀'.repeat(2001) })).toThrow();
});
it('every schema-maximum escaped/UTF8 original remains cancellable inside the unchanged64KiB envelope', () => {
  const refs = Array.from(
    { length: 10 },
    (_, i) =>
      `axiom-local-dispatch://${tenant}/11111111-1111-4111-8111-${String(i).padStart(12, '0')}/versions/999999999`,
  );
  const chars = ['\u0001', '"', '\\', '😀', 'ह'];
  const sizes: number[] = [];
  for (const policyChar of chars) {
    const policyText = encodeLocalCustodyPolicy({
      ...value,
      reason: policyChar.repeat(2000),
      keyPolicy: { primary: refs[0], readable: refs },
      servicePrincipals: {
        producer: `spiffe://${'a'.repeat(255)}/service/assessment-dispatch-producer`,
        controller: `spiffe://${'a'.repeat(255)}/controller/assessment`,
      },
      validity: { kind: 'until_revoked', reviewDueAt: Number.MAX_SAFE_INTEGER },
      acceptedLimitations: [
        'regional_custody_unavailable',
        'hardware_backing_unverified',
        'disaster_recovery_unverified',
        'physical_custody_operator_managed',
      ],
    });
    for (const eventChar of chars) {
      const originalRequestText = encodeLocalCustodyEvent({
        version: 1,
        operationKey: policyId,
        transition: 'review',
        policyText,
        policySha256: 'a'.repeat(64),
        previousEventId: tenant,
        nextReviewDueAt: Number.MAX_SAFE_INTEGER,
        reason: eventChar.repeat(2000),
        confirmed: true,
      });
      for (const cancellationChar of chars) {
        const resolution = {
          version: 1,
          operationKey: operator,
          originalRequestText,
          reason: cancellationChar.repeat(2000),
          confirmed: true,
        };
        encodeLocalCustodyCancellation(resolution);
        const bytes = new TextEncoder().encode(
          JSON.stringify({ resolution, challengeId: tenant, code: '\u0001'.repeat(256) }),
        ).length;
        sizes.push(bytes);
        expect(bytes).toBeLessThanOrEqual(65536);
      }
    }
  }
  expect(Math.max(...sizes)).toBeGreaterThan(40000);
});
