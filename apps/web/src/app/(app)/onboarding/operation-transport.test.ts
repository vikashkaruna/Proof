import { it, expect, vi, afterEach } from 'vitest';
import { onboardingRequest, readBoundedOnboardingResponse } from './operation-transport';
const journal = {
  schemaVersion: 1 as const,
  actorId: '11111111-1111-4111-8111-111111111111',
  operationKey: '22222222-2222-4222-8222-222222222222',
  requestSha256: 'a'.repeat(64),
};
afterEach(() => vi.unstubAllGlobals());
it('reads only the exact retained original account/operation/hash', async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      data: {
        actorId: journal.actorId,
        operationKey: journal.operationKey,
        requestSha256: journal.requestSha256,
        state: 'unconfirmed',
      },
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  expect((await onboardingRequest(journal, 'read')).state).toBe('unconfirmed');
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    `/api/bff/v1/organizations/onboarding-operations/${journal.operationKey}?requestSha256=${journal.requestSha256}`,
  );
  expect(fetcher.mock.calls[0]?.[1].method).toBe('GET');
});
it('rejects oversized response before JSON is consumed', async () => {
  await expect(readBoundedOnboardingResponse(new Response('x'.repeat(16385)))).rejects.toThrow(
    'limit',
  );
});
it('never accepts foreign original-proof bindings', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        data: {
          actorId: journal.actorId,
          operationKey: '33333333-3333-4333-8333-333333333333',
          requestSha256: journal.requestSha256,
          state: 'fenced',
        },
      }),
    ),
  );
  await expect(onboardingRequest(journal, 'fence')).rejects.toThrow();
});
