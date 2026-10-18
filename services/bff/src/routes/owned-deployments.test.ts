import { expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';
import type { Variables } from '../types.js';
import { ownedDeploymentRoutes, type OwnedDeploymentRouteController } from './owned-deployments.js';
const id = (n: number) => `89110000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(role: Variables['role'] = 'owner', configured = true) {
  const controller: OwnedDeploymentRouteController = {
    list: vi.fn(async () => []),
    options: vi.fn(async () => []),
    request: vi.fn(),
    preflight: vi.fn(),
    fence: vi.fn(),
    readOperation: vi.fn(),
    mfa: vi.fn(),
    install: vi.fn(),
  };
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', id(1));
    c.set('user', { id: id(11) } as User);
    c.set('sessionId', id(12));
    c.set('role', role);
    c.set('approvalScopes', []);
    return next();
  });
  app.route('/v1/owned-deployments', ownedDeploymentRoutes(configured ? controller : null));
  const request = (
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request('/v1/owned-deployments' + path, {
      method,
      headers: { 'X-Expected-Actor-Id': id(11), 'Content-Type': 'application/json', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { app, controller, request };
}
it('normal owner list is scoped and explicitly noncacheable', async () => {
  const f = fixture(),
    reply = await f.request('');
  expect(reply.status).toBe(200);
  expect(await reply.json()).toEqual({ data: [] });
  expect(reply.headers.get('Cache-Control')).toBe('private, no-store');
  expect(f.controller.list).toHaveBeenCalledWith({
    tenantId: id(1),
    actorId: id(11),
    sessionId: id(12),
    expectedActorId: id(11),
  });
});
it('refuses viewer and analyst roles before calling any enrollment controller', async () => {
  for (const role of ['viewer', 'axiom_analyst', 'reviewer', 'approver'] as const) {
    const f = fixture(role),
      response = await f.request('');
    expect(response.status).toBe(403);
    expect(f.controller.list).not.toHaveBeenCalled();
  }
});
it('does not infer enabled deployment from a valid authenticated owner', async () => {
  const f = fixture('owner', false);
  expect((await f.request('')).status).toBe(503);
  expect(f.controller.list).not.toHaveBeenCalled();
});
it('refuses stale actor pins and arbitrary query/body instructions', async () => {
  const f = fixture();
  expect((await f.request('', 'GET', undefined, { 'X-Expected-Actor-Id': id(99) })).status).toBe(
    409,
  );
  expect((await f.request('?tenantId=' + id(99))).status).toBe(400);
  expect((await f.request('', 'POST', { operationKey: id(10), sql: 'arbitrary' })).status).toBe(
    400,
  );
  expect(f.controller.request).not.toHaveBeenCalled();
});
it('requires exact decision operation key on every phase before MFA', async () => {
  const f = fixture(),
    decision = {
      operationKey: id(13),
      expectedManifestSha256: 'a'.repeat(64),
      expectedPreflightSha256: 'b'.repeat(64),
      expectedRollbackSha256: 'c'.repeat(64),
      reason: 'Only approve the owned synthetic scope',
      acknowledgeOwnedSynthetic: true,
    };
  for (const phase of ['challenge', 'verify', 'approve']) {
    expect(
      (
        await f.request(
          '/' + id(10) + '/' + phase,
          'POST',
          { request: decision },
          { 'Idempotency-Key': id(99) },
        )
      ).status,
    ).toBe(400);
  }
  expect(f.controller.mfa).not.toHaveBeenCalled();
});
it('does not serialize thrown provider/credential data into public errors', async () => {
  const f = fixture();
  vi.mocked(f.controller.list).mockRejectedValueOnce(Error('secret-transport-fixture-value'));
  const result = await f.request('');
  expect(result.status).toBe(503);
  expect(await result.text()).not.toContain('secret-transport-fixture-value');
});
