import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServiceAuthCacheForTests, serviceAuthHeaders } from './service-auth.js';
import { dispatchDryRun } from './dry-run-dispatch.js';
import { dispatchExecution } from './execution-dispatch.js';
import { dispatchRollback } from './rollback-dispatch.js';

const ON = { AXIOM_SERVICE_AUTH: 'gcp-id-token' };

function jwt(exp: number | null): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256' })}.${enc(exp === null ? {} : { exp })}.sig`;
}
const NOW = 1_800_000_000_000;
const exp = (ms: number) => Math.floor(ms / 1000);

beforeEach(() => {
  resetServiceAuthCacheForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('serviceAuthHeaders', () => {
  it('is a no-op with no network call when the mode is unset or empty', async () => {
    const fetchImpl = vi.fn();
    expect(await serviceAuthHeaders('https://rt.run.app', { fetchImpl, env: {} })).toEqual({});
    expect(
      await serviceAuthHeaders('https://rt.run.app', {
        fetchImpl,
        env: { AXIOM_SERVICE_AUTH: '' },
      }),
    ).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches an ID token whose audience is the origin of the target URL', async () => {
    const token = jwt(exp(NOW + 3_600_000));
    const fetchImpl = vi.fn().mockResolvedValue(new Response(token, { status: 200 }));
    const headers = await serviceAuthHeaders('https://rt-abc.a.run.app/internal/execute?x=1', {
      fetchImpl,
      env: ON,
      now: () => NOW,
    });
    expect(headers).toEqual({ 'X-Serverless-Authorization': `Bearer ${token}` });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=https%3A%2F%2Frt-abc.a.run.app&format=full',
    );
    expect(init.headers).toEqual({ 'Metadata-Flavor': 'Google' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('serves the second call from the cache', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response(jwt(exp(NOW + 3_600_000)), { status: 200 }));
    const deps = { fetchImpl, env: ON, now: () => NOW };
    await serviceAuthHeaders('https://rt.run.app', deps);
    await serviceAuthHeaders('https://rt.run.app/other', deps);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await serviceAuthHeaders('https://gw.run.app', deps);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refetches once the token is within 300 s of expiry', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response(jwt(exp(NOW + 3_600_000)), { status: 200 }));
    await serviceAuthHeaders('https://rt.run.app', { fetchImpl, env: ON, now: () => NOW });
    await serviceAuthHeaders('https://rt.run.app', {
      fetchImpl,
      env: ON,
      now: () => NOW + 3_600_000 - 301_000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await serviceAuthHeaders('https://rt.run.app', {
      fetchImpl,
      env: ON,
      now: () => NOW + 3_600_000 - 299_000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('caches 50 minutes when exp cannot be parsed', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response('not-a-jwt', { status: 200 }));
    await serviceAuthHeaders('https://rt.run.app', { fetchImpl, env: ON, now: () => NOW });
    await serviceAuthHeaders('https://rt.run.app', {
      fetchImpl,
      env: ON,
      now: () => NOW + 49 * 60_000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await serviceAuthHeaders('https://rt.run.app', {
      fetchImpl,
      env: ON,
      now: () => NOW + 51 * 60_000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent fetches for the same audience', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response(jwt(exp(NOW + 3_600_000)), { status: 200 }));
    const deps = { fetchImpl, env: ON, now: () => NOW };
    const all = await Promise.all([
      serviceAuthHeaders('https://rt.run.app/a', deps),
      serviceAuthHeaders('https://rt.run.app/b', deps),
      serviceAuthHeaders('https://rt.run.app/c', deps),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new Set(all.map((h) => h['X-Serverless-Authorization'])).size).toBe(1);
  });

  it('fails closed on a network error, a non-200 and an empty body', async () => {
    const cases = [
      vi.fn().mockRejectedValue(new Error('timeout')),
      vi.fn().mockResolvedValue(new Response('denied', { status: 403 })),
      vi.fn().mockResolvedValue(new Response('  ', { status: 200 })),
    ];
    for (const fetchImpl of cases) {
      await expect(
        serviceAuthHeaders('https://rt.run.app', { fetchImpl, env: ON }),
      ).rejects.toThrow(/service auth/);
    }
  });

  it('does not cache or wedge after a failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(new Response(jwt(exp(NOW + 3_600_000)), { status: 200 }));
    const deps = { fetchImpl, env: ON, now: () => NOW };
    await expect(serviceAuthHeaders('https://rt.run.app', deps)).rejects.toThrow();
    await expect(serviceAuthHeaders('https://rt.run.app', deps)).resolves.toHaveProperty(
      'X-Serverless-Authorization',
    );
  });

  it('throws on an unknown mode rather than disabling auth', async () => {
    const fetchImpl = vi.fn();
    await expect(
      serviceAuthHeaders('https://rt.run.app', { fetchImpl, env: { AXIOM_SERVICE_AUTH: 'gcp' } }),
    ).rejects.toThrow(/unsupported/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('dispatch wiring', () => {
  const token = jwt(exp(Date.now() + 3_600_000));
  const dryAck = {
    accepted: true,
    contract_version: 1,
    correlation_id: 'c-1',
    dry_run: {
      id: 'dr-1',
      status: 'succeeded',
      renderable: true,
      refusalReason: null,
      expiresAt: 'x',
      createdAt: 'y',
    },
  };
  const payload = { correlation_id: 'c-1' };

  function stubFetch() {
    const downstream = vi.fn().mockResolvedValue(Response.json(dryAck));
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: string, init?: RequestInit) =>
          url.startsWith('http://metadata.google.internal')
            ? Promise.resolve(new Response(token, { status: 200 }))
            : downstream(url, init),
        ),
    );
    return downstream;
  }

  it('adds the header, keeping X-Internal-Token, when enabled', async () => {
    vi.stubEnv('AXIOM_SERVICE_AUTH', 'gcp-id-token');
    const downstream = stubFetch();
    expect(await dispatchDryRun('https://rt.run.app', 'internal', payload)).toMatchObject({
      status: 'recorded',
    });
    const init = downstream.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({
      'X-Internal-Token': 'internal',
      'X-Serverless-Authorization': `Bearer ${token}`,
    });
  });

  it('sends no auth header when disabled', async () => {
    vi.stubEnv('AXIOM_SERVICE_AUTH', '');
    const downstream = stubFetch();
    await dispatchDryRun('https://rt.run.app', 'internal', payload);
    const init = downstream.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Internal-Token': 'internal',
    });
  });

  it('never calls downstream when the token cannot be obtained', async () => {
    vi.stubEnv('AXIOM_SERVICE_AUTH', 'gcp-id-token');
    const downstream = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: string, init?: RequestInit) =>
          url.startsWith('http://metadata.google.internal')
            ? Promise.resolve(new Response('no', { status: 500 }))
            : downstream(url, init),
        ),
    );
    expect(await dispatchDryRun('https://rt.run.app', 'i', payload)).toMatchObject({
      status: 'unavailable',
    });
    expect(await dispatchExecution('https://rt.run.app', 'i', payload)).toMatchObject({
      status: 'unknown',
    });
    expect(await dispatchRollback('https://rt.run.app', 'i', payload)).toMatchObject({
      status: 'unknown',
    });
    expect(downstream).not.toHaveBeenCalled();
  });
});
