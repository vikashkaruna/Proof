import { afterEach, expect, it, vi } from 'vitest';
import {
  checkCustodyReceipt,
  checkCustodyOutcome,
  custodyResolutionStep,
  custodyStep,
  loadCustodyContext,
} from './custody-client';
import {
  tenant,
  actor,
  event,
  other,
  request,
  receipt,
  context,
  cancellation,
  cancellationReceipt,
} from './__tests__/fixtures';
afterEach(() => vi.unstubAllGlobals());
it('sends exact operation key/body and explicit tenant+actor for every retry', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: receipt() }));
  vi.stubGlobal('fetch', fetcher);
  await custodyStep({ tenantId: tenant, actorId: actor }, 'recover', request());
  await custodyStep({ tenantId: tenant, actorId: actor }, 'recover', request());
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]?.[1]?.body).toEqual(fetcher.mock.calls[1]?.[1]?.body);
  expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual(fetcher.mock.calls[1]?.[1]?.headers);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    headers: {
      'x-tenant-id': tenant,
      'x-expected-actor-id': actor,
      'idempotency-key': request().operationKey,
    },
    body: JSON.stringify({ request: request() }),
  });
});
it('refuses wrong scope before transport and malformed/foreign receipts', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(
    custodyStep({ tenantId: other, actorId: actor }, 'record', request(), event),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  for (const changed of [
    { actorId: other },
    { tenantId: other },
    { requestText: '{}' },
    { operationKey: other },
    { policySha256: 'c'.repeat(64) },
    { transition: 'activate' },
  ])
    expect(() =>
      checkCustodyReceipt(
        { ...receipt(), ...changed },
        { tenantId: tenant, actorId: actor },
        request(),
      ),
    ).toThrow();
});
it('not_found stays an explicit non-positive state; 5xx/network/malformed never become receipts', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => Response.json({ data: { state: 'not_found' } })),
  );
  expect(await custodyStep({ tenantId: tenant, actorId: actor }, 'recover', request())).toEqual({
    state: 'not_found',
  });
  for (const response of [
    new Response('', { status: 503 }),
    Response.json({ data: { state: 'recorded' } }),
    new Response('{'),
  ]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );
    await expect(
      custodyStep({ tenantId: tenant, actorId: actor }, 'recover', request()),
    ).rejects.toThrow();
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Error('network');
    }),
  );
  await expect(
    custodyStep({ tenantId: tenant, actorId: actor }, 'record', request(), event),
  ).rejects.toThrow();
});
it('strictly verifies challenge/verification and current context binding', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () =>
      Response.json({
        data: { challengeId: event, expiresAt: new Date(Date.now() + 60000).toISOString() },
      }),
    ),
  );
  expect(
    await custodyStep({ tenantId: tenant, actorId: actor }, 'challenge', request()),
  ).toHaveProperty('challengeId', event);
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () =>
      Response.json({ data: { verified: true, challengeId: other } }),
    ),
  );
  await expect(
    custodyStep({ tenantId: tenant, actorId: actor }, 'verify', request(), event, '123456'),
  ).rejects.toThrow();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => Response.json({ data: context(other) })),
  );
  await expect(loadCustodyContext({ tenantId: tenant, actorId: actor })).rejects.toThrow();
});

it('loads valid scoped context and refuses unavailable, oversized and invalid UTF8 bytes', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => Response.json({ data: context() })),
  );
  expect(await loadCustodyContext({ tenantId: tenant, actorId: actor })).toEqual(context());
  for (const response of [
    new Response(null),
    new Response(new Uint8Array([255])),
    new Response('x'.repeat(2097153)),
  ]) {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => response),
    );
    await expect(loadCustodyContext({ tenantId: tenant, actorId: actor })).rejects.toThrow();
  }
});
it('requires the exact selected policy, verified MFA and current receipt context', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => Response.json({ data: context() })),
  );
  await expect(
    loadCustodyContext({ tenantId: tenant, actorId: actor }, { policyId: other }),
  ).rejects.toThrow();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () =>
      Response.json({ data: { verified: true, challengeId: event } }),
    ),
  );
  expect(
    await custodyStep({ tenantId: tenant, actorId: actor }, 'verify', request(), event, '123456'),
  ).toEqual({ verified: true, challengeId: event });
  for (const changed of [
    { previousEventId: other },
    { policyId: other },
    { keyPolicySha256: 'a'.repeat(64) },
  ])
    expect(() =>
      checkCustodyReceipt(
        { ...receipt(), ...changed },
        { tenantId: tenant, actorId: actor },
        request(),
      ),
    ).toThrow();
});

it('strict cancellation recovery binds original bytes, actor and exact resolution reason; record-first preserves original receipt', async () => {
  const scope = { tenantId: tenant, actorId: actor },
    c = cancellation();
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: cancellationReceipt(c) }));
  vi.stubGlobal('fetch', fetcher);
  expect(await custodyResolutionStep(scope, 'recover', c)).toMatchObject({
    state: 'cancelled',
    operationKey: other,
  });
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    body: JSON.stringify({ resolution: c }),
    headers: { 'idempotency-key': other, 'x-expected-actor-id': actor, 'x-tenant-id': tenant },
  });
  for (const change of [
    { actorId: other },
    { originalRequestText: '{}' },
    { operationKey: event },
    { cancellationText: JSON.stringify({ ...c, reason: 'different' }) },
  ])
    expect(() =>
      checkCustodyOutcome({ ...cancellationReceipt(c), ...change }, scope, request(), c),
    ).toThrow();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ data: receipt() })),
  );
  expect(await custodyResolutionStep(scope, 'record', c, event)).toMatchObject({
    state: 'recorded',
  });
});
it('never treats cancellation not_found or transport loss as abandonment proof', async () => {
  const scope = { tenantId: tenant, actorId: actor };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ data: { state: 'not_found' } })),
  );
  expect(await custodyResolutionStep(scope, 'recover', cancellation())).toEqual({
    state: 'not_found',
  });
  await expect(custodyResolutionStep(scope, 'record', cancellation(), event)).rejects.toThrow();
});
