import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createMarketingIdleGate, type MarketingIdleConfig } from './marketing-idle-gate.js';

const config: MarketingIdleConfig = {
  ENVIRONMENT: 'preprod',
  GCP_PROJECT_ID: 'axiom-proof',
  GCP_REGION: 'asia-south1',
  AXIOM_IDLE_PROJECT_ID: 'axiom-proof',
  AXIOM_IDLE_CONTROLLER_URL: 'https://axiom-proof-preprod-idle-abc-el.a.run.app',
  AXIOM_IDLE_CONTROLLER_AUDIENCE: 'https://axiom-proof-preprod-idle-abc-el.a.run.app',
  SUPABASE_URL: 'https://axiom-proof-preprod-gateway-abc-el.a.run.app',
};
const identity = 'header.payload.signature';

function harness(
  options: {
    acquireStatus?: number;
    dbError?: boolean;
    pendingDb?: boolean;
    dbOutcome?: 'unknown' | 'not-started';
    metadataError?: boolean;
    metadataNoFlavor?: boolean;
    metadataOversize?: boolean;
    badAdmission?: boolean;
    badDbTarget?: boolean;
    bodyError?: boolean;
    pendingBody?: boolean;
    requestMaxSeconds?: number;
    slowFirstDbMs?: number;
  } = {},
) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const transport: typeof fetch = vi.fn(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith('http://metadata.google.internal/')) {
        if (options.metadataError) throw new Error('metadata unavailable');
        return new Response(options.metadataOversize ? `h.${'a'.repeat(16_384)}.s` : identity, {
          status: 200,
          headers: options.metadataNoFlavor ? {} : { 'Metadata-Flavor': 'Google' },
        });
      }
      if (url.endsWith('/gate/acquire')) {
        const request = JSON.parse(String(init?.body)) as { requestId: string };
        return Response.json(
          options.acquireStatus === 503
            ? { status: 'starting', saved: false }
            : options.badAdmission
              ? { status: 'admitted', requestId: 'wrong-id', requestMaxSeconds: 25 }
              : {
                  status: 'admitted',
                  requestId: request.requestId,
                  expiresAt: Date.now() / 1000 + 100,
                  requestMaxSeconds: options.requestMaxSeconds ?? 25,
                },
          { status: options.acquireStatus ?? 200 },
        );
      }
      if (url.endsWith('/gate/release')) return Response.json({ status: 'released' });
      if (url === `${config.SUPABASE_URL}/rest/v1/table`) {
        if (options.slowFirstDbMs && calls.filter((call) => call.url === url).length === 1)
          await new Promise((resolve) => setTimeout(resolve, options.slowFirstDbMs));
        if (options.dbError) throw new Error('upstream connection interrupted');
        if (options.pendingDb) return new Promise<Response>(() => {});
        if (options.bodyError)
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('body interrupted'));
              },
            }),
            { status: 200 },
          );
        if (options.pendingBody)
          return new Response(new ReadableStream({ start() {} }), { status: 200 });
        if (options.dbOutcome)
          return Response.json(
            { error: 'unavailable' },
            { status: 503, headers: { 'X-Axiom-DB-Outcome': options.dbOutcome } },
          );
        return Response.json({ saved: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  ) as typeof fetch;
  const gate = createMarketingIdleGate(config, transport);
  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true }));
  app.use('/public/*', gate.middleware);
  app.get('/public/contact/config', (c) => c.json({ enabled: false }));
  app.post('/public/contact', async (c) => {
    const target = options.badDbTarget
      ? 'https://attacker.invalid/rest/v1/table'
      : `${config.SUPABASE_URL}/rest/v1/table`;
    if (options.pendingDb) {
      void gate.databaseFetch(target, {
        headers: { Authorization: 'Bearer supabase-jwt' },
      });
      return c.json({ saved: true }, 201);
    }
    try {
      const database = await gate.databaseFetch(target, {
        headers: { Authorization: 'Bearer supabase-jwt' },
      });
      if (!database.ok) return c.json({ saved: false }, 503);
      return c.json({ saved: true }, 201);
    } catch {
      return c.json({ saved: false }, 503);
    }
  });
  app.post('/public/two', async (c) => {
    await gate.databaseFetch(`${config.SUPABASE_URL}/rest/v1/table`);
    await gate.databaseFetch(`${config.SUPABASE_URL}/rest/v1/table`);
    return c.json({ saved: true });
  });
  return { app, calls };
}

describe('marketing idle gate', () => {
  it('refuses wrong profile, project, region, audience and non-run.app URL', () => {
    for (const change of [
      { ENVIRONMENT: 'production' },
      { GCP_REGION: 'us-central1' },
      { AXIOM_IDLE_PROJECT_ID: 'different-project' },
      { AXIOM_IDLE_CONTROLLER_AUDIENCE: 'https://different-el.a.run.app' },
      { AXIOM_IDLE_CONTROLLER_URL: 'https://attacker.invalid' },
      { AXIOM_IDLE_CONTROLLER_URL: 'https://controller-el.a.run.app/path' },
      { AXIOM_IDLE_CONTROLLER_URL: 'https://user@controller-el.a.run.app' },
      { SUPABASE_URL: 'https://database.example.invalid' },
    ]) {
      expect(() => createMarketingIdleGate({ ...config, ...change })).toThrow(
        'Invalid marketing idle controller configuration',
      );
    }
  });

  it('excludes health/config but wraps each DB-bound HTTP request with independent leases', async () => {
    const { app, calls } = harness();
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/public/contact/config')).status).toBe(200);
    expect(calls).toHaveLength(0);
    for (let i = 0; i < 2; i++) {
      const response = await app.request('/public/contact', { method: 'POST' });
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ saved: true });
    }
    const acquire = calls.filter((call) => call.url.endsWith('/gate/acquire'));
    const release = calls.filter((call) => call.url.endsWith('/gate/release'));
    expect(acquire).toHaveLength(2);
    expect(release).toHaveLength(2);
    const bodies = acquire.map(
      (call) => JSON.parse(String(call.init?.body)) as { requestId: string; leaseToken: string },
    );
    expect(new Set(bodies.map((body) => body.requestId)).size).toBe(2);
    expect(new Set(bodies.map((body) => body.leaseToken)).size).toBe(2);
    for (const body of bodies) {
      expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.leaseToken).toMatch(/^[a-f0-9]{64}$/);
      expect(release.some((call) => call.init?.body === JSON.stringify(body))).toBe(true);
    }
    const database = calls.filter((call) => call.url === `${config.SUPABASE_URL}/rest/v1/table`);
    expect(database).toHaveLength(2);
    for (const call of database) {
      expect(new Headers(call.init?.headers).get('Authorization')).toBe('Bearer supabase-jwt');
      expect(new Headers(call.init?.headers).get('X-Serverless-Authorization')).toBe(
        `Bearer ${identity}`,
      );
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
      expect(call.init?.redirect).toBe('error');
    }
    const metadata = calls.filter((call) =>
      call.url.startsWith('http://metadata.google.internal/'),
    );
    expect(metadata).toHaveLength(6);
    for (const call of metadata) {
      expect(call.url).toContain('audience=');
      expect(new Headers(call.init?.headers).get('Metadata-Flavor')).toBe('Google');
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
    for (const call of [...acquire, ...release]) {
      expect(new Headers(call.init?.headers).get('Authorization')).toBe(`Bearer ${identity}`);
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('fails closed before any database work when the controller is starting', async () => {
    const { app, calls } = harness({ acquireStatus: 503 });
    const response = await app.request('/public/contact', { method: 'POST' });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ saved: false });
    expect(response.headers.get('retry-after')).toBe('5');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(calls.some((call) => call.url === `${config.SUPABASE_URL}/rest/v1/table`)).toBe(false);
    expect(calls.some((call) => call.url.endsWith('/gate/release'))).toBe(false);
  });

  it('fails closed if metadata identity or admission proof is unavailable', async () => {
    for (const options of [
      { metadataError: true },
      { metadataNoFlavor: true },
      { metadataOversize: true },
      { badAdmission: true },
    ]) {
      const { app, calls } = harness(options);
      const response = await app.request('/public/contact', { method: 'POST' });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ saved: false });
      expect(response.headers.get('retry-after')).toBe('5');
      expect(calls.some((call) => call.url === `${config.SUPABASE_URL}/rest/v1/table`)).toBe(false);
      expect(calls.some((call) => call.url.endsWith('/gate/release'))).toBe(false);
    }
  });

  it('retains the lease and reports unknown outcome when database response fails', async () => {
    const { app, calls } = harness({ dbError: true });
    const response = await app.request('/public/contact', { method: 'POST' });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ saved: null, outcome: 'unknown' });
    expect(response.headers.get('retry-after')).toBeNull();
    expect(calls.some((call) => call.url.endsWith('/gate/release'))).toBe(false);
    const database = calls.find((call) => call.url === `${config.SUPABASE_URL}/rest/v1/table`);
    expect(database?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('retains a lease if the gateway response body fails after headers', async () => {
    const { app, calls } = harness({ bodyError: true });
    const response = await app.request('/public/contact', { method: 'POST' });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ saved: null, outcome: 'unknown' });
    expect(calls.some((call) => call.url.endsWith('/gate/release'))).toBe(false);
  });

  it('bounds a stalled gateway response body by the execution deadline', async () => {
    const { app, calls } = harness({ pendingBody: true, requestMaxSeconds: 1 });
    const response = await app.request('/public/contact', { method: 'POST' });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ saved: null, outcome: 'unknown' });
    expect(calls.some((call) => call.url.endsWith('/gate/release'))).toBe(false);
  });

  it('shares the admitted execution deadline across sequential database fetches', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const { app } = harness({ requestMaxSeconds: 1, slowFirstDbMs: 650 });
      const response = await app.request('/public/two', { method: 'POST' });
      expect(response.status).toBe(200);
      const durations = timeout.mock.calls.map(([milliseconds]) => milliseconds);
      expect(
        durations.filter((milliseconds) => milliseconds > 0 && milliseconds <= 1_000),
      ).toHaveLength(2);
      expect(durations.some((milliseconds) => milliseconds > 0 && milliseconds < 500)).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });

  it('does not send a database request to any URL outside the configured gateway', async () => {
    const { app, calls } = harness({ badDbTarget: true });
    const response = await app.request('/public/contact', { method: 'POST' });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ saved: null, outcome: 'unknown' });
    expect(calls.some((call) => call.url.includes('attacker.invalid'))).toBe(false);
    expect(calls.some((call) => call.url.endsWith('/gate/release'))).toBe(false);
  });

  it('retains a lease when a handler responds before its database request completes', async () => {
    const { app, calls } = harness({ pendingDb: true });
    const response = await app.request('/public/contact', { method: 'POST' });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ saved: null, outcome: 'unknown' });
    expect(calls.some((call) => call.url.endsWith('/gate/release'))).toBe(false);
  });

  it('retains a lease for a gateway response with unknown database outcome', async () => {
    const { app, calls } = harness({ dbOutcome: 'unknown' });
    const response = await app.request('/public/contact', { method: 'POST' });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ saved: null, outcome: 'unknown' });
    expect(calls.some((call) => call.url.endsWith('/gate/release'))).toBe(false);
  });

  it('releases after a gateway proves the database request was not started', async () => {
    const { app, calls } = harness({ dbOutcome: 'not-started' });
    const response = await app.request('/public/contact', { method: 'POST' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ saved: false });
    expect(calls.some((call) => call.url.endsWith('/gate/release'))).toBe(true);
  });
});
