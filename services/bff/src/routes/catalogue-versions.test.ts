import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, expect, it, vi } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import { catalogueVersionRoutes } from './catalogue-versions.js';
import type { Variables } from '../types.js';
import type { MfaService } from '../services/mfa.js';
import { bindingSha256 } from '../services/mfa.js';
vi.hoisted(() =>
  Object.assign(process.env, {
    SUPABASE_URL: 'http://localhost:55321',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
    APPROVAL_SIGNING_KEY: 'k'.repeat(48),
    AXIOM_MFA_ENCRYPTION_KEY: 'm'.repeat(48),
  }),
);
const id = (n: number) => `99161000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const request = {
  version: 1 as const,
  operationKey: id(1),
  libraryVersion: '0.2.0' as const,
  rowsHash: 'a'.repeat(64),
  questionnaireDigest: 'b'.repeat(64),
  manifestSha256: 'c'.repeat(64),
  mappingVersion: 'public-evidence-1' as const,
  reason: 'Reviewed corrected source',
  confirmed: true as const,
};
const read = vi.fn(),
  write = vi.fn();
const mfa = { issueChallenge: vi.fn(), verifyChallenge: vi.fn(), consumeChallenge: vi.fn() };
let role: Variables['role'];
function app() {
  const server = new Hono<{ Variables: Variables }>();
  server.use('*', async (c, next) => {
    c.set('tenantId', id(11));
    c.set('user', { id: id(2) } as Variables['user']);
    c.set('role', role);
    c.set('sessionId', id(3));
    await next();
  });
  server.route('/v1', catalogueVersionRoutes({ mfa: mfa as unknown as MfaService, read, write }));
  return server;
}
function post(step: string, body: unknown = { request }, headers: Record<string, string> = {}) {
  return app().request(`/v1/catalogue-versions/${step}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-expected-actor-id': id(2),
      'idempotency-key': request.operationKey,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  role = 'founder';
  read
    .mockReset()
    .mockImplementation(async () => ({
      data: {
        authorized: true,
        requestSha256: createHash('sha256').update(canonicalJson(request)).digest('hex'),
      },
      error: null,
    }));
  write
    .mockReset()
    .mockResolvedValue({
      data: { approved: true, libraryVersion: '0.2.0', receiptId: '161', replayed: false },
      error: null,
    });
  mfa.issueChallenge
    .mockReset()
    .mockResolvedValue({ ok: true, challengeId: id(4), expiresAt: '2026-10-19T01:00:00Z' });
  mfa.verifyChallenge
    .mockReset()
    .mockResolvedValue({
      ok: true,
      purpose: 'catalogue_adoption',
      boundResourceRef: request.operationKey,
    });
  mfa.consumeChallenge.mockReset().mockResolvedValue({ ok: true });
});
it.each(['owner', 'admin', 'axiom_analyst', 'approver', 'viewer', 'agent'] as const)(
  'refuses %s before privileged ports',
  async (roleName) => {
    role = roleName;
    expect((await post('challenge')).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  },
);
it('binds the challenge to current actor, tenant, session and exact version review', async () => {
  expect((await post('challenge')).status).toBe(200);
  const digest = createHash('sha256').update(canonicalJson(request)).digest('hex');
  expect(mfa.issueChallenge).toHaveBeenCalledWith(
    expect.objectContaining({
      purpose: 'catalogue_adoption',
      boundResourceRef: request.operationKey,
      boundPayloadSha256: bindingSha256([
        'axiom.catalogue-version.approve',
        1,
        id(11),
        id(2),
        id(3),
        digest,
      ]),
    }),
  );
  expect(write).not.toHaveBeenCalled();
});
it('refuses actor drift, operation mismatch and extra client authority', async () => {
  expect((await post('challenge', { request }, { 'x-expected-actor-id': id(9) })).status).toBe(409);
  expect((await post('challenge', { request }, { 'idempotency-key': id(8) })).status).toBe(400);
  expect((await post('challenge', { request: { ...request, approved: true } })).status).toBe(400);
  expect(read).not.toHaveBeenCalled();
});
it('fails closed on current authority or digest changes', async () => {
  read.mockResolvedValue({ data: null, error: { code: '42501' } });
  expect((await post('challenge')).status).toBe(503);
  expect(mfa.issueChallenge).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
it('never writes after refused MFA', async () => {
  mfa.consumeChallenge.mockResolvedValue({ ok: false });
  expect((await post('approve', { request, challengeId: id(4) })).status).toBe(403);
  expect(write).not.toHaveBeenCalled();
});
it('records only after consuming the version-specific challenge', async () => {
  const response = await post('approve', { request, challengeId: id(4) });
  expect(response.status).toBe(200);
  expect(write).toHaveBeenCalledWith(
    'approve_catalogue_version',
    expect.objectContaining({
      p_tenant_id: id(11),
      p_actor_id: id(2),
      p_session_id: id(3),
      p_request_text: canonicalJson(request),
      p_challenge_id: id(4),
    }),
    expect.anything(),
  );
  expect(mfa.consumeChallenge.mock.invocationCallOrder[0]).toBeLessThan(
    write.mock.invocationCallOrder[0]!,
  );
});
it('does not claim success when the database refuses the approval', async () => {
  write.mockResolvedValue({ data: null, error: { code: '42501' } });
  const response = await post('approve', { request, challengeId: id(4) });
  expect(response.status).toBe(503);
  expect(await response.text()).toContain('catalogue_approval_unconfirmed');
});
it('requires explicit MFA verification before accepting the code and checks purpose', async () => {
  mfa.verifyChallenge.mockResolvedValue({
    ok: true,
    purpose: 'login',
    boundResourceRef: request.operationKey,
  });
  expect((await post('verify', { request, challengeId: id(4), code: '123456' })).status).toBe(403);
  expect(write).not.toHaveBeenCalled();
});
