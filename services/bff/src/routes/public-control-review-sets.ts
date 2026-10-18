import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import { parseCatalogueJson } from '@axiom/control-library';
import { createHumanActionWriter, createSupabaseAdmin } from '@axiom/supabase';
import {
  Capability,
  parsePublicControlReviewSetAnyRequestText as parsePublicControlReviewSetRequestText,
  publicControlReviewSetAnyRowSchema as publicControlReviewSetRowSchema,
  recordedPublicControlReviewAnySetSchema as recordedPublicControlReviewSetSchema,
  readPublicControlReviewAnySetSchema as readPublicControlReviewSetSchema,
  readPublicControlReviewAnyOperationSchema as readPublicControlReviewOperationSchema,
  cancelPublicControlReviewAnyOperationRequestSchema as cancelPublicControlReviewOperationRequestSchema,
  PUBLIC_CONTROL_REVIEW_MAX_BYTES,
} from '@axiom/types';
import {
  questionnaireHash,
  verifyPublicControlReviewRow,
  verifyPublicControlReviewCancellation,
} from '../services/public-control-review-record.js';
export {
  verifyPublicControlReviewRow,
  verifyPublicControlReviewCancellation,
} from '../services/public-control-review-record.js';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
import {
  decodeRetainedPublicWebsiteReview,
  retainedPublicWebsiteReviewSchema,
} from './public-website-control-review.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
type Ctx = Context<{ Variables: Variables }>;
const refusals = {
  invalid_record: 400,
  forbidden: 403,
  context_refused: 404,
  source_refused: 404,
  website_recapture_required: 409,
  stale_review: 409,
  idempotency_conflict: 409,
  catalogue_refused: 503,
  operation_cancelled: 409,
  association_context_required: 409,
} as const;
const sqlError = z
  .object({
    error: z.enum(
      Object.keys(refusals) as [keyof typeof refusals, ...Array<keyof typeof refusals>],
    ),
  })
  .strict();
function refused(c: Ctx, value: unknown) {
  const result = sqlError.safeParse(value);
  return result.success
    ? c.json({ error: { code: result.data.error } }, refusals[result.data.error])
    : c.json({ error: { code: 'public_control_review_unavailable' } }, 503);
}

const headContext = retainedPublicWebsiteReviewSchema
  .extend({
    estateId: uuid.nullable(),
    catalogueManifestSha256: digest,
    mappingVersion: z.literal('public-evidence-1'),
    questionnaireDigest: digest,
  })
  .strict();
const headResponse = z
  .object({ context: headContext, data: publicControlReviewSetRowSchema.nullable() })
  .strict();
const query = z.object({ engagementId: uuid, checkId: uuid }).strict();
function selection(c: Ctx) {
  if (Object.values(c.req.queries()).some((values) => values.length !== 1))
    throw new Error('invalid_query');
  return query.parse(c.req.query());
}

/** Human declarations only. No agent dispatch, score, release or evidence certification. */
export function publicControlReviewSetRoutes() {
  const app = new Hono<{ Variables: Variables }>();
  app.get('/public-control-review-sets/current', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    let wanted: z.infer<typeof query>;
    try {
      wanted = selection(c);
    } catch {
      return c.json({ error: { code: 'invalid_request' } }, 400);
    }
    try {
      const tenantId = c.get('tenantId').toLowerCase();
      const result = await createSupabaseAdmin()
        .rpc('read_public_control_review_head', {
          p_tenant_id: tenantId,
          p_actor_id: c.get('user').id,
          p_engagement_id: wanted.engagementId,
          p_check_id: wanted.checkId,
        })
        .abortSignal(AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10000)]));
      if (result.error) throw new Error();
      if (sqlError.safeParse(result.data).success) return refused(c, result.data);
      const head = headResponse.parse(result.data);
      const {
        estateId,
        catalogueManifestSha256,
        mappingVersion,
        questionnaireDigest,
        ...retained
      } = head.context;
      const verified = decodeRetainedPublicWebsiteReview(retained, { tenantId, ...wanted });
      if (
        verified.assessment.catalogue.manifestSha256 !== catalogueManifestSha256 ||
        questionnaireHash(retained.libraryVersion) !== questionnaireDigest
      )
        throw new Error();
      const review = head.data
        ? verifyPublicControlReviewRow(head.data, { tenantId, ...wanted })
        : null;
      if (
        review &&
        (review.snapshot.request.expectedSource.payloadSha256 !== retained.payloadSha256 ||
          review.snapshot.checkedAt !== retained.checkedAt ||
          review.snapshot.captureReceipt !== retained.captureReceipt)
      )
        throw new Error('review_capture_refused');
      return c.json({
        data: {
          tenantId,
          ...wanted,
          estateId,
          expectedSource: {
            payloadSha256: retained.payloadSha256,
            catalogueManifestSha256,
            mappingVersion,
            libraryVersion: retained.libraryVersion,
            questionnaireDigest,
          },
          review,
        },
      });
    } catch {
      return refused(c, null);
    }
  });

  app.post('/public-control-review-sets', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.ASSESSMENT_RUN);
    if (denied) return denied;
    const actor = uuid.safeParse(c.req.header('X-Expected-Actor-Id'));
    if (!actor.success || actor.data !== c.get('user').id.toLowerCase())
      return c.json({ error: { code: 'review_actor_changed' } }, 409);
    let request: ReturnType<typeof parsePublicControlReviewSetRequestText>, text: string;
    try {
      text = await c.req.text();
      request = parsePublicControlReviewSetRequestText(text);
      if (new URL(c.req.url).search || c.req.header('Idempotency-Key') !== request.operationKey)
        throw new Error();
    } catch {
      return c.json({ error: { code: 'invalid_request' } }, 400);
    }
    try {
      const tenantId = c.get('tenantId').toLowerCase(),
        writer = createHumanActionWriter();
      const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10000)]);
      const result = await writer
        .rpc('record_public_control_review_set', {
          p_tenant_id: tenantId,
          p_actor_id: actor.data,
          p_request_text: text,
        })
        .abortSignal(signal);
      if (result.error) throw new Error();
      const recorded = recordedPublicControlReviewSetSchema.safeParse(result.data);
      if (!recorded.success) return refused(c, result.data);
      const row = verifyPublicControlReviewRow(recorded.data.data, {
        tenantId,
        engagementId: request.engagementId,
        checkId: request.checkId,
      });
      if (row.actor_id !== actor.data || row.request_text !== text) throw new Error();
      // A replayed receipt may have been superseded; read its current status.
      const read = await writer
        .rpc('read_public_control_review_set', {
          p_tenant_id: tenantId,
          p_actor_id: actor.data,
          p_review_id: row.id,
        })
        .abortSignal(signal);
      if (read.error) throw new Error();
      const state = readPublicControlReviewSetSchema.parse(read.data);
      if (canonicalJson(state.data) !== canonicalJson(recorded.data.data)) throw new Error();
      return c.json(
        {
          data: { review: row, isCurrent: state.isCurrent, contextCurrent: state.contextCurrent },
          replayed: recorded.data.replayed,
        },
        recorded.data.replayed ? 200 : 201,
      );
    } catch {
      return refused(c, null);
    }
  });

  app.get('/public-control-review-sets/operations/:operationKey', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    const operation = uuid.safeParse(c.req.param('operationKey'));
    let wanted: z.infer<typeof query>;
    try {
      wanted = selection(c);
      if (!operation.success) throw new Error();
    } catch {
      return c.json({ error: { code: 'invalid_request' } }, 400);
    }
    try {
      const tenantId = c.get('tenantId').toLowerCase();
      const result = await createSupabaseAdmin()
        .rpc('read_public_control_review_operation', {
          p_tenant_id: tenantId,
          p_actor_id: c.get('user').id,
          p_engagement_id: wanted.engagementId,
          p_check_id: wanted.checkId,
          p_operation_key: operation.data,
        })
        .abortSignal(AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10000)]));
      if (result.error) throw new Error();
      const state = readPublicControlReviewOperationSchema.safeParse(result.data);
      if (!state.success) return refused(c, result.data);
      if (state.data.state === 'not_found') return c.json({ data: state.data });
      if (state.data.state === 'cancelled') {
        const row = verifyPublicControlReviewCancellation(state.data.data, { tenantId, ...wanted });
        if (row.operation_key !== operation.data || row.actor_id !== c.get('user').id.toLowerCase())
          throw new Error();
        return c.json({ data: { state: 'cancelled' as const, data: row } });
      }
      const row = verifyPublicControlReviewRow(state.data.data, { tenantId, ...wanted });
      if (row.operation_key !== operation.data || row.actor_id !== c.get('user').id.toLowerCase())
        throw new Error();
      return c.json({ data: { ...state.data, data: row } });
    } catch {
      return refused(c, null);
    }
  });
  app.post('/public-control-review-sets/operations/:operationKey/cancel', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.ASSESSMENT_RUN);
    if (denied) return denied;
    const actor = uuid.safeParse(c.req.header('X-Expected-Actor-Id'));
    if (!actor.success || actor.data !== c.get('user').id.toLowerCase())
      return c.json({ error: { code: 'review_actor_changed' } }, 409);
    let body: z.infer<typeof cancelPublicControlReviewOperationRequestSchema>;
    try {
      body = cancelPublicControlReviewOperationRequestSchema.parse(
        parseCatalogueJson(await c.req.text(), PUBLIC_CONTROL_REVIEW_MAX_BYTES + 8192),
      );
      if (
        new URL(c.req.url).search ||
        c.req.param('operationKey') !== body.request.operationKey ||
        c.req.header('Idempotency-Key') !== body.request.operationKey
      )
        throw new Error();
    } catch {
      return c.json({ error: { code: 'invalid_request' } }, 400);
    }
    try {
      const tenantId = c.get('tenantId').toLowerCase();
      const result = await createHumanActionWriter()
        .rpc('cancel_public_control_review_operation', {
          p_tenant_id: tenantId,
          p_actor_id: actor.data,
          p_request_text: canonicalJson(body.request),
          p_reason: body.reason,
        })
        .abortSignal(AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10000)]));
      if (result.error) throw new Error();
      const state = readPublicControlReviewOperationSchema.safeParse(result.data);
      if (!state.success || state.data.state === 'not_found') return refused(c, result.data);
      const row =
        state.data.state === 'recorded'
          ? verifyPublicControlReviewRow(state.data.data, {
              tenantId,
              engagementId: body.request.engagementId,
              checkId: body.request.checkId,
            })
          : verifyPublicControlReviewCancellation(state.data.data, {
              tenantId,
              engagementId: body.request.engagementId,
              checkId: body.request.checkId,
            });
      if (
        (state.data.state === 'cancelled' && state.data.data.reason !== body.reason) ||
        row.actor_id !== actor.data ||
        row.request_text !== canonicalJson(body.request)
      )
        throw new Error();
      return c.json({ data: { ...state.data, data: row } });
    } catch {
      return refused(c, null);
    }
  });
  return app;
}
