import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { Capability, EngagementStatus } from '@axiom/types';
import { createHumanActionWriter } from '@axiom/supabase';
import { requireCapability } from '../middleware/authorize.js';
import { boundedJsonBody } from '../middleware/evidence-body-limit.js';
import type { Variables } from '../types.js';

const input = z.object({
  libraryVersion: z.string().min(1).max(200),
  estateId: z.uuid().optional(),
  title: z.string().min(3).max(200),
  requestKey: z.uuid().optional(),
});
const receipt = z
  .object({
    id: z.uuid(),
    tenant_id: z.uuid(),
    estate_id: z.uuid().nullable(),
    library_version: z.string().min(1).max(200),
    title: z.string(),
    status: z.enum(EngagementStatus),
    posture_score: z.number().min(0).max(100).nullable(),
    estimated_exposure_inr: z.number().nonnegative().nullable(),
    lead_reviewer_id: z.uuid().nullable(),
    started_at: z.iso.datetime({ offset: true }),
    completed_at: z.iso.datetime({ offset: true }).nullable(),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
    receipt: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .refine((v) => BigInt(v) <= 9223372036854775807n)
      .nullable(),
    legacy: z.boolean(),
    replayed: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.legacy && (value.receipt !== null || !value.replayed)) ||
      (!value.legacy && value.receipt === null)
    )
      ctx.addIssue({ code: 'custom', message: 'Intake receipt refused' });
  });
/** Confirm the actual saved row and atomic receipt before acknowledging creation. */
export function verifyEngagementIntakeReceipt(
  value: unknown,
  scope: { tenantId: string; actorId: string; request: z.infer<typeof input> },
) {
  const result = receipt.parse(value);
  if (result.tenant_id.toLowerCase() !== scope.tenantId.toLowerCase())
    throw new Error('intake_tenant_mismatch');
  if (
    !result.replayed &&
    (result.title !== scope.request.title ||
      result.library_version !== scope.request.libraryVersion ||
      result.estate_id !== (scope.request.estateId ?? null) ||
      result.lead_reviewer_id !== scope.actorId ||
      result.status !== 'intake')
  )
    throw new Error('intake_context_mismatch');
  if (
    scope.request.requestKey &&
    result.id.toLowerCase() !== scope.request.requestKey.toLowerCase()
  )
    throw new Error('intake_reference_mismatch');
  return result;
}
export function engagementIntakeRoutes() {
  const app = new Hono<{ Variables: Variables }>();
  app.use('/engagements', boundedJsonBody(4096));
  app.post('/engagements', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.ENGAGEMENT_CREATE);
    if (denied) return denied;
    const expected = c.req.header('X-Expected-Actor-Id');
    if (
      expected !== undefined &&
      (!z.uuid().safeParse(expected).success ||
        expected.toLowerCase() !== c.get('user').id.toLowerCase())
    )
      return c.json(
        {
          error: {
            code: 'actor_changed',
            message: 'Return to the account that prepared this request.',
          },
        },
        409,
      );
    const parsed = input.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error: {
            code: 'validation_failed',
            message: 'Review the assessment title, library and estate.',
          },
        },
        400,
      );
    const key = c.get('idempotencyKey');
    if (!key || key.length < 8 || key.length > 256)
      return c.json(
        { error: { code: 'idempotency_required', message: 'A retained request key is required.' } },
        400,
      );
    try {
      const { data, error } = await createHumanActionWriter()
        .rpc('create_engagement_intake', {
          p_tenant_id: c.get('tenantId'),
          p_actor_id: c.get('user').id,
          p_operation_key: key,
          p_request_key: parsed.data.requestKey ?? null,
          p_title: parsed.data.title,
          p_library_version: parsed.data.libraryVersion,
          p_estate_id: parsed.data.estateId ?? null,
          p_correlation_id: randomUUID(),
        })
        .abortSignal(AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10000)]));
      if (error) throw new Error('intake_unconfirmed');
      const refusal = z
        .object({
          error: z.enum([
            'forbidden',
            'invalid_library',
            'invalid_reference',
            'estate_archived',
            'request_key_conflict',
            'validation_failed',
          ]),
        })
        .strict()
        .safeParse(data);
      if (refusal.success) {
        const code = refusal.data.error;
        const status =
          code === 'forbidden'
            ? 403
            : code === 'invalid_library' || code === 'invalid_reference'
              ? 422
              : code === 'validation_failed'
                ? 400
                : 409;
        const message =
          code === 'invalid_library'
            ? 'Choose the current published control library.'
            : code === 'estate_archived'
              ? 'Restore the estate before starting an assessment.'
              : code === 'request_key_conflict'
                ? 'This request key belongs to a different assessment.'
                : code === 'forbidden'
                  ? 'Current assessment creation authority is required.'
                  : 'The request was refused. Check the original recorded request before changing its intent.';
        return c.json({ error: { code, message } }, status);
      }
      const result = verifyEngagementIntakeReceipt(data, {
        tenantId: c.get('tenantId'),
        actorId: c.get('user').id,
        request: parsed.data,
      });
      return c.json(result, result.replayed ? 200 : 201);
    } catch {
      return c.json(
        {
          error: {
            code: 'outcome_unavailable',
            message:
              'The creation outcome could not be confirmed. Keep the original request and check it again.',
          },
        },
        503,
      );
    }
  });
  return app;
}
