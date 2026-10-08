import { Hono } from 'hono';
import { z } from 'zod';
import { Capability, sudhaarReviewAdoptionRequestSchema } from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
import type { KillSwitchService } from '../services/kill-switch.js';
import {
  adoptSudhaarReview,
  ReviewAdoptionRefused,
  type ReviewAdoptionWriterFactory,
} from '../services/sudhaar-review-adoption.js';
export function sudhaarReviewAdoptionRoutes(deps: {
  killSwitch: Pick<KillSwitchService, 'isActive'>;
  writerFactory?: ReviewAdoptionWriterFactory;
}) {
  const app = new Hono<{ Variables: Variables }>();
  app.post('/plans/proposals/:operationKey/adopt', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.PLAN_CREATE);
    if (denied) return denied;
    const actorId = c.get('user').id.toLowerCase(),
      tenantId = c.get('tenantId').toLowerCase();
    const expected = z.uuid().safeParse(c.req.header('X-Expected-Actor-Id'));
    if (!expected.success || expected.data.toLowerCase() !== actorId)
      return c.json({ error: { code: 'expected_actor_refused' } }, 409);
    const operation = z.uuid().safeParse(c.req.param('operationKey'));
    if (!operation.success || [...new URL(c.req.url).searchParams].length)
      return c.json({ error: { code: 'validation_failed' } }, 400);
    const text = await c.req.text();
    if (Buffer.byteLength(text, 'utf8') > 16384)
      return c.json({ error: { code: 'request_too_large' } }, 413);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return c.json({ error: { code: 'validation_failed' } }, 400);
    }
    const body = sudhaarReviewAdoptionRequestSchema.safeParse(raw),
      key = z.uuid().safeParse(c.req.header('Idempotency-Key'));
    if (!body.success || !key.success || key.data.toLowerCase() !== body.data.adoptionKey)
      return c.json({ error: { code: 'validation_failed' } }, 400);
    try {
      if (await deps.killSwitch.isActive(tenantId))
        return c.json({ error: { code: 'kill_switch_active' } }, 423);
      return c.json(
        await adoptSudhaarReview(
          tenantId,
          actorId,
          operation.data.toLowerCase(),
          body.data,
          deps.writerFactory,
        ),
        201,
      );
    } catch (error) {
      const code =
        error instanceof ReviewAdoptionRefused ? error.code : 'review_adoption_uncertain';
      return c.json({ error: { code } }, code === 'review_adoption_conflict' ? 409 : 503);
    }
  });
  return app;
}
