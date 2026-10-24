import { Hono } from 'hono';
import { z } from 'zod';
import { createHumanActionWriter, createSupabaseAdmin } from '@axiom/supabase';
import type { Variables } from '../types.js';
import type { RecoveryRpc } from './mfa-recovery.js';

const RequestBody = z
  .object({
    requestId: z.uuid(),
    reviewerUserId: z.uuid(),
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();

/** Password-authenticated help requests. These never open a recovery case. */
export function mfaRecoveryRequestRoutes(
  deps: { readRpc?: RecoveryRpc; writeRpc?: RecoveryRpc } = {},
) {
  const app = new Hono<{ Variables: Variables }>();
  const read: RecoveryRpc =
    deps.readRpc ?? (async (name, args) => createSupabaseAdmin().rpc(name, args));
  const write: RecoveryRpc =
    deps.writeRpc ?? (async (name, args) => createHumanActionWriter().rpc(name, args));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    if (!z.uuid().safeParse(c.get('sessionId')).success)
      return c.json({ error: { code: 'current_session_required' } }, 401);
    return next();
  });
  async function call(rpc: RecoveryRpc, name: string, args: Record<string, unknown>) {
    try {
      return await rpc(name, args);
    } catch {
      return { data: null, error: { code: 'unavailable', message: 'unavailable' } };
    }
  }
  function failure(error: { code?: string }) {
    if (error.code === 'PT409') return { status: 409 as const, code: 'recovery_request_conflict' };
    if (error.code === '42501') return { status: 403 as const, code: 'recovery_request_refused' };
    return { status: 503 as const, code: 'recovery_requests_unavailable' };
  }
  app.get('/', async (c) => {
    const { data, error } = await call(read, 'read_mfa_recovery_requests', {
      p_actor_id: c.get('user').id,
      p_session_id: c.get('sessionId'),
      p_tenant_id: c.get('tenantId'),
    });
    if (error) {
      const r = failure(error);
      return c.json({ error: { code: r.code } }, r.status);
    }
    return c.json(data);
  });
  app.post('/', async (c) => {
    const body = RequestBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: 'validation_failed' } }, 400);
    if (body.data.reviewerUserId.toLowerCase() === c.get('user').id.toLowerCase())
      return c.json({ error: { code: 'recovery_request_refused' } }, 403);
    const { data, error } = await call(write, 'record_mfa_recovery_request', {
      p_actor_id: c.get('user').id,
      p_session_id: c.get('sessionId'),
      p_tenant_id: c.get('tenantId'),
      p_request_id: body.data.requestId,
      p_reviewer_id: body.data.reviewerUserId,
      p_reason: body.data.reason,
    });
    if (error) {
      const r = failure(error);
      return c.json({ error: { code: r.code } }, r.status);
    }
    return c.json(data, 201);
  });
  app.post('/:id/cancel', async (c) => {
    const id = z.uuid().safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: { code: 'validation_failed' } }, 400);
    const { data, error } = await call(write, 'cancel_mfa_recovery_request', {
      p_actor_id: c.get('user').id,
      p_session_id: c.get('sessionId'),
      p_tenant_id: c.get('tenantId'),
      p_request_id: id.data,
    });
    if (error) {
      const r = failure(error);
      return c.json({ error: { code: r.code } }, r.status);
    }
    return c.json(data);
  });
  return app;
}
