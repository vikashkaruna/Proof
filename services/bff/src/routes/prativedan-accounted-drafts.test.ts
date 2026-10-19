import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { UserRole } from '@axiom/types';
import type { Variables } from '../types.js';
import type { MfaService } from '../services/mfa.js';
import { prativedanAccountedDraftRoutes } from './prativedan-accounted-drafts.js';
const actor = '11111111-1111-4111-8111-111111111111';
function fixture(role: UserRole, enabled = false) {
  const handle = vi.fn();
  const mfa = { sessionAttestation: vi.fn().mockResolvedValue(null) } as unknown as MfaService;
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('role', role);
    c.set('user', { id: actor } as Variables['user']);
    c.set('tenantId', actor);
    c.set('sessionId', actor);
    await next();
  });
  app.route(
    '/',
    prativedanAccountedDraftRoutes({ mfa, ...(enabled ? { client: { handle } } : {}) }),
  );
  const request = () =>
    app.request('/reports/accounted-drafts/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Expected-Actor-Id': actor },
      body: '{}',
    });
  return { app, request, handle };
}
it('actual mounted configuration reports disabled without a private controller', async () => {
  const f = fixture(UserRole.FOUNDER);
  const response = await f.app.request('/reports/accounted-drafts/configuration');
  expect(await response.json()).toMatchObject({
    data: { enabled: false, modelInference: false, publicationAllowed: false },
  });
  expect((await f.request()).status).toBe(503);
  expect(f.handle).not.toHaveBeenCalled();
});
it('owner cannot enter dedicated founder computation', async () => {
  const f = fixture(UserRole.OWNER, true);
  expect((await f.request()).status).toBe(403);
  expect(f.handle).not.toHaveBeenCalled();
});
it('missing current MFA refuses before any private invocation', async () => {
  const f = fixture(UserRole.FOUNDER, true);
  expect((await f.request()).status).toBe(409);
  expect(f.handle).not.toHaveBeenCalled();
});
