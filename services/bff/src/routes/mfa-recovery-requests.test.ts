import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Variables } from '../types.js';
import type { RecoveryRpc } from './mfa-recovery.js';
import { mfaRecoveryRequestRoutes } from './mfa-recovery-requests.js';

const actor = '00000000-0000-4000-8000-000000000001';
const session = '00000000-0000-4000-8000-000000000002';
const tenant = '00000000-0000-4000-8000-000000000003';
const recipient = '00000000-0000-4000-8000-000000000004';
const requestId = '00000000-0000-4000-8000-000000000005';
function fixture(sessionId: string | null = session) {
  const read = vi.fn<RecoveryRpc>(async () => ({
    data: { own: [], inbox: [], reviewers: [] },
    error: null,
  }));
  const write = vi.fn<RecoveryRpc>(async () => ({ data: { id: requestId }, error: null }));
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: actor } as Variables['user']);
    c.set('tenantId', tenant);
    c.set('sessionId', sessionId as string);
    await next();
  });
  app.route('/requests', mfaRecoveryRequestRoutes({ readRpc: read, writeRpc: write }));
  return { app, read, write };
}
function post(body: unknown, path = '/requests') {
  return new Request(`http://test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const body = { requestId, reviewerUserId: recipient, reason: 'Lost phone and recovery codes' };
describe('password-authenticated recovery help requests', () => {
  it('uses read credentials only for a caller-bound, uncached overview', async () => {
    const f = fixture();
    const r = await f.app.request('/requests');
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
    expect(f.read).toHaveBeenCalledWith('read_mfa_recovery_requests', {
      p_actor_id: actor,
      p_session_id: session,
      p_tenant_id: tenant,
    });
    expect(f.write).not.toHaveBeenCalled();
  });
  it('records only a request using the restricted writer and session-derived subject', async () => {
    const f = fixture();
    const r = await f.app.request(post(body));
    expect(r.status).toBe(201);
    expect(f.write).toHaveBeenCalledWith('record_mfa_recovery_request', {
      p_actor_id: actor,
      p_session_id: session,
      p_tenant_id: tenant,
      p_request_id: requestId,
      p_reviewer_id: recipient,
      p_reason: body.reason,
    });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...body, subjectUserId: recipient },
    { ...body, tenantId: recipient },
    { ...body, sessionId: recipient },
    { ...body, reason: 'too short' },
  ])('refuses caller-supplied identity or invalid notes', async (input) => {
    const f = fixture();
    expect((await f.app.request(post(input))).status).toBe(400);
    expect(f.write).not.toHaveBeenCalled();
  });
  it('refuses self-nomination and absent sessions without SQL', async () => {
    const f = fixture();
    expect((await f.app.request(post({ ...body, reviewerUserId: actor }))).status).toBe(403);
    expect(f.write).not.toHaveBeenCalled();
    const stale = fixture(null);
    expect((await stale.app.request(post(body))).status).toBe(401);
    expect(stale.write).not.toHaveBeenCalled();
  });
  it('cancels only through a subject-bound writer call', async () => {
    const f = fixture();
    expect((await f.app.request(post({}, `/requests/${requestId}/cancel`))).status).toBe(200);
    expect(f.write).toHaveBeenCalledWith('cancel_mfa_recovery_request', {
      p_actor_id: actor,
      p_session_id: session,
      p_tenant_id: tenant,
      p_request_id: requestId,
    });
  });
  it.each([
    ['42501', 403],
    ['PT409', 409],
    ['unavailable', 503],
  ] as const)('reports refusal %s without exposing database messages', async (code, status) => {
    const f = fixture();
    f.write.mockResolvedValue({ data: null, error: { code, message: 'private database detail' } });
    const r = await f.app.request(post(body));
    expect(r.status).toBe(status);
    expect(await r.text()).not.toContain('private database detail');
  });
});
