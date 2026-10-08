/** Disjoint source routes. Mount only behind normal Auth/tenant middleware and trusted controller ports. */
import { Hono } from 'hono';
import { z } from 'zod';
import { Capability } from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
import {
  ownedHash,
  ownedPlanReceiptSchema,
  ownedPlanRequestSchema,
  produceOwnedPostgresMeasuredPlan,
  OwnedPlanRefused,
  type OwnedPlanContext,
  type OwnedPostgresPlanPorts,
} from '../services/owned-execution-plan.js';
import {
  cancelOwnedPendingRequest,
  ownedCancellationReceiptSchema,
  ownedCancellationRequestSchema,
  OwnedCancellationRefused,
  type OwnedCancellationPorts,
} from '../services/owned-execution-cancellation.js';
const uuid = z.uuid().transform((value) => value.toLowerCase());
const targetList = z
  .object({
    tenantId: uuid,
    actorId: uuid,
    engagementId: uuid,
    targets: z
      .array(
        z
          .object({
            bindingId: uuid,
            engagementId: uuid,
            label: z.literal('Owned synthetic audit configuration'),
            scope: z.literal('owned_synthetic_config.audit_log_enable'),
            auditLogEnabled: z.boolean(),
            currentVersion: z
              .number()
              .int()
              .nonnegative()
              .max(Number.MAX_SAFE_INTEGER - 2),
            snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export interface OwnedSyntheticRouteDeps {
  isKilled(tenantId: string): Promise<boolean>;
  planPorts(context: OwnedPlanContext): OwnedPostgresPlanPorts;
  cancellationPorts(context: OwnedPlanContext): OwnedCancellationPorts;
  readTargets(context: OwnedPlanContext, engagementId: string): Promise<unknown>;
  /** Atomic source reader authorizes current human membership/MFA, including read-only stopped-source recovery. */
  readOriginalOutcome(
    context: OwnedPlanContext,
    operationKey: string,
    requestHash: string,
  ): Promise<unknown>;
}
export function ownedSyntheticPlanRoutes(deps: OwnedSyntheticRouteDeps) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    if (!uuid.safeParse(c.get('user')?.id).success || !uuid.safeParse(c.get('tenantId')).success)
      return c.json({ error: { code: 'unauthorized' } }, 401);
    for (const capability of [Capability.PLAN_CREATE, Capability.PLAN_EXECUTE]) {
      const denied = requireCapability(c, capability);
      if (denied) return denied;
    }
    const expected = uuid.safeParse(c.req.header('X-Expected-Actor-Id'));
    if (!expected.success || expected.data !== c.get('user').id.toLowerCase())
      return c.json({ error: { code: 'expected_actor_refused' } }, 409);
    if (!c.get('sessionId') || c.get('sessionId').length > 256)
      return c.json({ error: { code: 'mfa_required' } }, 403);
    if ([...new URL(c.req.url).searchParams].length)
      return c.json({ error: { code: 'validation_failed' } }, 400);
    return next();
  });
  const context = (
    tenantId: string,
    actorId: string,
    sessionId: string,
    key: string,
  ): OwnedPlanContext => ({
    tenantId: tenantId.toLowerCase(),
    actorId: actorId.toLowerCase(),
    expectedActorId: actorId.toLowerCase(),
    sessionId,
    idempotencyKey: key,
  });
  app.get('/plans/owned-synthetic/targets/:engagementId', async (c) => {
    const engagement = uuid.safeParse(c.req.param('engagementId'));
    if (!engagement.success) return c.json({ error: { code: 'validation_failed' } }, 400);
    const ctx = context(c.get('tenantId'), c.get('user').id, c.get('sessionId'), '');
    try {
      if (await deps.isKilled(ctx.tenantId))
        return c.json({ error: { code: 'kill_switch_active' } }, 423);
      const source = targetList.safeParse(await deps.readTargets(ctx, engagement.data));
      if (
        !source.success ||
        source.data.tenantId !== ctx.tenantId ||
        source.data.actorId !== ctx.actorId ||
        source.data.engagementId !== engagement.data ||
        source.data.targets.some((t) => t.engagementId !== engagement.data)
      )
        return c.json({ error: { code: 'owned_source_unconfirmed' } }, 503);
      return c.json(source.data);
    } catch {
      return c.json({ error: { code: 'owned_source_unconfirmed' } }, 503);
    }
  });
  app.post('/plans/owned-synthetic', async (c) => {
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, 'utf8') > 16384)
      return c.json({ error: { code: 'request_too_large' } }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: { code: 'validation_failed' } }, 400);
    }
    const parsed = ownedPlanRequestSchema.safeParse(body),
      key = uuid.safeParse(c.req.header('Idempotency-Key'));
    if (!parsed.success || !key.success || key.data !== parsed.data.operationKey)
      return c.json({ error: { code: 'validation_failed' } }, 400);
    const ctx = context(c.get('tenantId'), c.get('user').id, c.get('sessionId'), key.data);
    try {
      if (await deps.isKilled(ctx.tenantId))
        return c.json({ error: { code: 'kill_switch_active' } }, 423);
      return c.json(
        await produceOwnedPostgresMeasuredPlan(ctx, parsed.data, deps.planPorts(ctx)),
        201,
      );
    } catch (error) {
      const code =
        error instanceof OwnedPlanRefused ? error.code : 'owned_plan_outcome_unconfirmed';
      return c.json({ error: { code } }, code === 'owned_plan_invalid' ? 400 : 503);
    }
  });
  app.post('/plans/owned-synthetic/cancel', async (c) => {
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, 'utf8') > 16384)
      return c.json({ error: { code: 'request_too_large' } }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: { code: 'validation_failed' } }, 400);
    }
    const parsed = ownedCancellationRequestSchema.safeParse(body),
      key = uuid.safeParse(c.req.header('Idempotency-Key'));
    if (!parsed.success || !key.success || key.data !== parsed.data.cancellationKey)
      return c.json({ error: { code: 'validation_failed' } }, 400);
    const ctx = context(c.get('tenantId'), c.get('user').id, c.get('sessionId'), key.data);
    try {
      return c.json(
        await cancelOwnedPendingRequest(ctx, parsed.data, deps.cancellationPorts(ctx)),
        200,
      );
    } catch (error) {
      const code =
        error instanceof OwnedCancellationRefused
          ? error.code
          : 'owned_cancellation_outcome_unconfirmed';
      return c.json({ error: { code } }, code === 'owned_cancellation_invalid' ? 400 : 503);
    }
  });
  app.post('/plans/owned-synthetic/outcome', async (c) => {
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, 'utf8') > 16384)
      return c.json({ error: { code: 'request_too_large' } }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: { code: 'validation_failed' } }, 400);
    }
    const parsed = ownedPlanRequestSchema.safeParse(body),
      key = uuid.safeParse(c.req.header('Idempotency-Key'));
    if (!parsed.success || !key.success || key.data !== parsed.data.operationKey)
      return c.json({ error: { code: 'validation_failed' } }, 400);
    const ctx = context(c.get('tenantId'), c.get('user').id, c.get('sessionId'), key.data);
    try {
      const requestHash = ownedHash({
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        request: parsed.data,
      });
      // Full final-receipt binding is enforced by the source controller and again by the browser journal.
      const result = z
        .object({ state: z.enum(['pending', 'recorded', 'cancelled']), receipt: z.unknown() })
        .strict()
        .safeParse(await deps.readOriginalOutcome(ctx, parsed.data.operationKey, requestHash));
      if (!result.success) return c.json({ error: { code: 'owned_source_unconfirmed' } }, 503);
      if (result.data.state === 'pending') {
        if (result.data.receipt !== null)
          return c.json({ error: { code: 'owned_source_unconfirmed' } }, 503);
      } else {
        const receipt =
          result.data.state === 'recorded'
            ? ownedPlanReceiptSchema.safeParse(result.data.receipt)
            : ownedCancellationReceiptSchema.safeParse(result.data.receipt);
        if (
          !receipt.success ||
          receipt.data.tenantId !== ctx.tenantId ||
          receipt.data.actorId !== ctx.actorId ||
          receipt.data.operationKey !== parsed.data.operationKey ||
          receipt.data.requestHash !== requestHash
        )
          return c.json({ error: { code: 'owned_source_unconfirmed' } }, 503);
        if (result.data.state === 'recorded') {
          const plan = ownedPlanReceiptSchema.parse(receipt.data);
          if (
            plan.bindingId !== parsed.data.bindingId ||
            plan.engagementId !== parsed.data.engagementId ||
            plan.snapshotHash !== parsed.data.expectedSnapshotHash
          )
            return c.json({ error: { code: 'owned_source_unconfirmed' } }, 503);
        }
        result.data.receipt = receipt.data;
      }
      return c.json(result.data);
    } catch {
      return c.json({ error: { code: 'owned_source_unconfirmed' } }, 503);
    }
  });
  return app;
}
