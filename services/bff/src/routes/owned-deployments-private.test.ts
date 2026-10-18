import { expect, it, vi } from 'vitest';
import {
  ownedDeploymentPrivateRoutes,
  type OwnedDeploymentPrivateDeps,
} from './owned-deployments-private.js';
function fixture() {
  const deps: OwnedDeploymentPrivateDeps = {
    auth: { authenticate: vi.fn(async () => {}) },
    installer: {
      claim: vi.fn<OwnedDeploymentPrivateDeps['installer']['claim']>(async () => ({
        kind: 'idle',
        task: null,
      })),
      preflight: vi.fn(),
      authorize: vi.fn(),
      confirm: vi.fn(),
      unconfirmed: vi.fn(),
      issuerAuthorize: vi.fn(),
      issuerComplete: vi.fn(),
    },
  };
  const router = ownedDeploymentPrivateRoutes(deps);
  const request = (
    peer = '127.0.0.1',
    headers: Record<string, string> = {},
    raw = '{"claimId":"89110000-0000-4000-8000-000000000001"}',
    route = '/tasks/claim',
  ) =>
    router.request(
      'http://127.0.0.1' + route,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-axiom-local-operator': 'synthetic-transport-unit-value',
          ...headers,
        },
        body: raw,
      },
      { incoming: { socket: { remoteAddress: peer, remotePort: 4000, remoteFamily: 'IPv4' } } },
    );
  return { deps, router, request };
}
it('uses actual accepted socket, not forged Host or forwarded headers', async () => {
  const f = fixture(),
    reply = await f.request('203.0.113.10', { Host: 'localhost', 'X-Forwarded-For': '127.0.0.1' });
  expect(reply.status).toBe(403);
  expect(f.deps.auth.authenticate).not.toHaveBeenCalled();
  expect(f.deps.installer.claim).not.toHaveBeenCalled();
});
it.each(['Origin', 'Referer', 'Sec-Fetch-Site', 'Cookie', 'Authorization'])(
  'refuses browser/session header%s even on loopback',
  async (header) => {
    const f = fixture();
    expect((await f.request('127.0.0.1', { [header]: 'browser-unit-fixture' })).status).toBe(403);
    expect(f.deps.installer.claim).not.toHaveBeenCalled();
  },
);
it('authenticates protected transport before a fixed task claim and never enables CORS', async () => {
  const f = fixture(),
    reply = await f.request();
  expect(reply.status).toBe(200);
  expect(await reply.json()).toEqual({ data: { kind: 'idle', task: null } });
  expect(reply.headers.get('Cache-Control')).toBe('private, no-store');
  expect(reply.headers.get('Access-Control-Allow-Origin')).toBeNull();
  expect(f.deps.auth.authenticate).toHaveBeenCalledOnce();
  expect(f.deps.installer.claim).toHaveBeenCalledOnce();
});
it('refuses duplicate JSON keys and arbitrary RPC paths', async () => {
  const f = fixture();
  expect((await f.request('127.0.0.1', {}, '{"claimId":"one","claimId":"two"}')).status).toBe(503);
  expect(f.deps.installer.claim).not.toHaveBeenCalled();
  expect((await f.request('127.0.0.1', {}, '{}', '/rpc/grant_role')).status).toBe(404);
  expect(f.deps.installer.authorize).not.toHaveBeenCalled();
});
it('sanitizes uncertain provider replies and missing Node socket context', async () => {
  const f = fixture();
  vi.mocked(f.deps.installer.claim).mockRejectedValueOnce(Error('credential-body-unit-value'));
  const response = await f.request();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('credential-body-unit-value');
  expect(
    (
      await f.router.request('http://127.0.0.1/tasks/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
  ).toBe(403);
});
