/**
 * W2 Parity API Routes: ROPA, Policy drafts, Playbooks, and Classification reviews.
 */
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { Capability } from '@axiom/types';
import { createSupabaseAdmin } from '@axiom/supabase';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
import { EvidenceError, type EvidenceDatabase } from '../services/evidence-ingestion.js';
import {
  W2ParityService,
  createRopaRecordInputSchema,
  createPolicyDraftInputSchema,
  reviewPolicyDraftInputSchema,
  createPlaybookEntryInputSchema,
  submitClassificationReviewInputSchema,
} from '../services/w2-parity.js';

type Ctx = Context<{ Variables: Variables }>;

function failure(c: Ctx, cause: unknown) {
  if (cause instanceof EvidenceError) {
    return c.json({ error: { code: cause.code } }, cause.status);
  }
  return c.json({ error: { code: 'database_unavailable' } }, 503);
}

function invalid(c: Ctx, message?: string) {
  return c.json({ error: { code: 'validation_failed', message } }, 400);
}

export function w2ParityRoutes(
  dependencies: { db?: EvidenceDatabase; service?: W2ParityService } = {},
) {
  const app = new Hono<{ Variables: Variables }>();
  const service = () =>
    dependencies.service ?? new W2ParityService(dependencies.db ?? createSupabaseAdmin());

  // ─── 1. ROPA Records ──────────────────────────────────────────────────
  app.post('/ropa', async (c) => {
    const denied = requireCapability(c, Capability.ESTATE_MANAGE);
    if (denied) return denied;

    const body = await c.req.json().catch(() => null);
    const parsed = createRopaRecordInputSchema.safeParse(body);
    if (!parsed.success) return invalid(c);

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
    const correlationId = randomUUID();
    try {
      const result = await service().createRopaRecord(
        c.get('tenantId'),
        c.get('user').id,
        parsed.data,
        correlationId,
        signal,
      );
      return c.json(result, 201);
    } catch (cause) {
      return failure(c, cause);
    }
  });

  app.get('/ropa', async (c) => {
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
    try {
      const result = await service().listRopaRecords(c.get('tenantId'), signal);
      return c.json({ records: result });
    } catch (cause) {
      return failure(c, cause);
    }
  });

  // ─── 2. Policy Drafts ─────────────────────────────────────────────────
  app.post('/policies/drafts', async (c) => {
    const denied = requireCapability(c, Capability.ESTATE_MANAGE);
    if (denied) return denied;

    const body = await c.req.json().catch(() => null);
    const parsed = createPolicyDraftInputSchema.safeParse(body);
    if (!parsed.success) return invalid(c);

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
    const correlationId = randomUUID();
    try {
      const result = await service().createPolicyDraft(
        c.get('tenantId'),
        c.get('user').id,
        parsed.data,
        correlationId,
        signal,
      );
      return c.json(result, 201);
    } catch (cause) {
      return failure(c, cause);
    }
  });

  app.post('/policies/drafts/:id/review', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_REVIEW);
    if (denied) return denied;

    const draftId = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = reviewPolicyDraftInputSchema.safeParse(body);
    if (!parsed.success) return invalid(c);

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
    const correlationId = randomUUID();
    try {
      const result = await service().reviewPolicyDraft(
        c.get('tenantId'),
        c.get('user').id,
        draftId,
        parsed.data,
        correlationId,
        signal,
      );
      return c.json(result, 200);
    } catch (cause) {
      return failure(c, cause);
    }
  });

  app.get('/policies/drafts', async (c) => {
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
    try {
      const result = await service().listPolicyDrafts(c.get('tenantId'), signal);
      return c.json({ drafts: result });
    } catch (cause) {
      return failure(c, cause);
    }
  });

  // ─── 3. Playbook Entries ──────────────────────────────────────────────
  app.post('/playbooks', async (c) => {
    const denied = requireCapability(c, Capability.ESTATE_MANAGE);
    if (denied) return denied;

    const body = await c.req.json().catch(() => null);
    const parsed = createPlaybookEntryInputSchema.safeParse(body);
    if (!parsed.success) return invalid(c);

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
    const correlationId = randomUUID();
    try {
      const result = await service().createPlaybookEntry(
        c.get('tenantId'),
        c.get('user').id,
        parsed.data,
        correlationId,
        signal,
      );
      return c.json(result, 201);
    } catch (cause) {
      return failure(c, cause);
    }
  });

  app.get('/playbooks', async (c) => {
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
    try {
      const result = await service().listPlaybookEntries(c.get('tenantId'), signal);
      return c.json({ playbooks: result });
    } catch (cause) {
      return failure(c, cause);
    }
  });

  // ─── 4. Classification Reviews ────────────────────────────────────────
  app.post('/classification/reviews', async (c) => {
    const denied = requireCapability(c, Capability.ASSESSMENT_RUN);
    if (denied) return denied;

    const body = await c.req.json().catch(() => null);
    const parsed = submitClassificationReviewInputSchema.safeParse(body);
    if (!parsed.success) return invalid(c);

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
    const correlationId = randomUUID();
    try {
      const result = await service().submitClassificationReview(
        c.get('tenantId'),
        c.get('user').id,
        parsed.data,
        correlationId,
        signal,
      );
      return c.json(result, 201);
    } catch (cause) {
      return failure(c, cause);
    }
  });

  app.get('/classification/reviews', async (c) => {
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
    try {
      const result = await service().listClassificationReviews(c.get('tenantId'), signal);
      return c.json({ reviews: result });
    } catch (cause) {
      return failure(c, cause);
    }
  });

  return app;
}
