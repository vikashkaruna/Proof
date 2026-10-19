import { describe, it, expect } from 'vitest';
import {
  onboardingCreate,
  encodeOnboardingRequest,
  verifyOnboardingOperation,
} from './onboarding-operation';
const actorId = '11111111-1111-4111-8111-111111111111',
  operationKey = '22222222-2222-4222-8222-222222222222',
  requestSha256 = 'a'.repeat(64);
const request = {
  name: 'Synthetic company',
  slug: null,
  tier: 'growth' as const,
  is_sdf: false,
  processes_health_data: false,
  processes_children_data: false,
  dpo_name: null,
  dpo_email: null,
  systems: [],
};
describe('exact onboarding contract', () => {
  it('has one strict canonical representation and refuses inferred authority', () => {
    expect(encodeOnboardingRequest(request)).toBe(
      encodeOnboardingRequest({ ...request, name: ' Synthetic company ' }),
    );
    expect(onboardingCreate.safeParse({ operationKey, request, userId: actorId }).success).toBe(
      false,
    );
    expect(
      onboardingCreate.safeParse({ operationKey, request: { ...request, role: 'founder' } })
        .success,
    ).toBe(false);
  });
  it.each(['actorId', 'operationKey', 'requestSha256'] as const)(
    'rejects substituted %s proof',
    (field) => {
      const op = { actorId, operationKey, requestSha256, state: 'fenced' };
      expect(() =>
        verifyOnboardingOperation(
          {
            ...op,
            [field]:
              field === 'requestSha256' ? 'b'.repeat(64) : '33333333-3333-4333-8333-333333333333',
          },
          op,
        ),
      ).toThrow();
    },
  );
  it('accepts non-disclosing withdrawn-access proof without inventing tenant authority', () => {
    expect(
      verifyOnboardingOperation(
        { actorId, operationKey, requestSha256, state: 'recorded_access_withdrawn' },
        { actorId, operationKey, requestSha256 },
      ).state,
    ).toBe('recorded_access_withdrawn');
  });
});
