import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import { publicCoverageClarificationRoutes } from './public-coverage-clarifications';
import type { Variables } from '../types';
vi.hoisted(() =>
  Object.assign(process.env, {
    SUPABASE_URL: 'http://localhost:55321',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
    APPROVAL_SIGNING_KEY: 'k'.repeat(48),
    AXIOM_MFA_ENCRYPTION_KEY: 'm'.repeat(48),
  }),
);
const id = (n: number) => `99179000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const request = {
  version: 1,
  operationKey: id(1),
  engagementId: id(2),
  checkId: id(3),
  payloadSha256: 'a'.repeat(64),
  expectedPreviousRevisionId: null,
  clarifications: [],
};
function setup(role: Variables['role'] = 'owner', session = id(7)) {
  const read = vi.fn().mockResolvedValue({ data: { canClarify: true, record: null }, error: null }),
    write = vi.fn().mockResolvedValue({ data: { error: 'explanation_required' }, error: null });
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', id(4));
    c.set('user', { id: id(5) } as Variables['user']);
    c.set('role', role);
    c.set('sessionId', session);
    c.set('idempotencyKey', id(1));
    await next();
  });
  app.route('/', publicCoverageClarificationRoutes({ read, write }));
  return { app, read, write };
}
function post(app: ReturnType<typeof setup>['app'], body = canonicalJson(request), actor = id(5)) {
  return app.request('/public-coverage-clarifications', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-expected-actor-id': actor },
    body,
  });
}
it('narrowly scopes reads and keeps declarations private', async () => {
  const { app, read } = setup();
  const response = await app.request(
    `/public-coverage-clarifications?engagementId=${id(2)}&checkId=${id(3)}&payloadSha256=${'a'.repeat(64)}`,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(read.mock.calls[0]![1]).toMatchObject({
    p_actor_id: id(5),
    p_tenant_id: id(4),
    p_operation_key: null,
  });
});
it('rejects duplicate read scope parameters', async () => {
  const { app, read } = setup();
  expect(
    (
      await app.request(
        `/public-coverage-clarifications?engagementId=${id(2)}&engagementId=${id(3)}&checkId=${id(3)}&payloadSha256=${'a'.repeat(64)}`,
      )
    ).status,
  ).toBe(400);
  expect(read).not.toHaveBeenCalled();
});
it.each(['viewer', 'reviewer', 'approver'] as const)(
  'blocks %s writes before database access',
  async (role) => {
    const { app, write } = setup(role);
    expect((await post(app)).status).toBe(403);
    expect(write).not.toHaveBeenCalled();
  },
);
it('rejects changed actor and absent live session before writing', async () => {
  const { app, write } = setup();
  expect((await post(app, canonicalJson(request), id(9))).status).toBe(409);
  expect(write).not.toHaveBeenCalled();
  const other = setup('owner', '');
  expect((await post(other.app)).status).toBe(403);
  expect(other.write).not.toHaveBeenCalled();
});
it('passes exact canonical request to scoped writer and preserves missing-explanation refusal', async () => {
  const { app, write } = setup();
  expect((await post(app)).status).toBe(409);
  expect(write.mock.calls[0]![1]).toEqual({
    p_actor_id: id(5),
    p_tenant_id: id(4),
    p_session_id: id(7),
    p_request_text: canonicalJson(request),
  });
});
it('refuses unsafe owner-supplied URL without writing', async () => {
  const { app, write } = setup();
  const body = canonicalJson({
    ...request,
    clarifications: [
      {
        page: 'privacy',
        sourceState: 'unexamined',
        sourceTruncated: false,
        reasonCategory: 'needs_investigation',
        reason: 'Owner must investigate the public page coverage.',
        proposedPublicUrl: 'http://127.0.0.1/private',
      },
    ],
  });
  expect((await post(app, body)).status).toBe(400);
  expect(write).not.toHaveBeenCalled();
});
it('fails closed on malformed positive receipt', async () => {
  const { app, write } = setup();
  write.mockResolvedValue({ data: { record: { receiptId: '1' }, replayed: false }, error: null });
  expect((await post(app)).status).toBe(503);
});
