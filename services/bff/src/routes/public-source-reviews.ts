import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { createHumanActionWriter } from '@axiom/supabase';
import {
  Capability,
  createPublicSourceReviewSchema,
  publicSourceReviewOperationKeySchema,
  publicSourceReviewRecordedSqlSchema,
  publicSourceReviewPageSqlSchema,
  publicSourceReviewRequestSqlSchema,
  publicSourceReadQuerySchema,
  publicSourceCursorSchema,
  type PublicSourceReview,
} from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
const uuid = z.uuid().transform((value) => value.toLowerCase());
const status = {
  invalid_record: 400,
  forbidden: 403,
  context_refused: 404,
  source_refused: 404,
  observation_refused: 404,
  digest_mismatch: 409,
  target_refused: 404,
  idempotency_conflict: 409,
  stale_review: 409,
} as const;
const errorSchema = z
  .object({
    error: z.enum(Object.keys(status) as [keyof typeof status, ...Array<keyof typeof status>]),
  })
  .strict();
type Ctx = Context<{ Variables: Variables }>;
function refusal(c: Ctx, value: unknown) {
  const parsed = errorSchema.safeParse(value);
  return parsed.success
    ? c.json({ error: { code: parsed.data.error } }, status[parsed.data.error])
    : c.json({ error: { code: 'public_source_review_unavailable' } }, 503);
}
const querySchema = publicSourceReadQuerySchema.extend({ engagementId: uuid }).strict();
const requestQuery = z.object({ engagementId: uuid }).strict();
const base = '/public-source-bindings/:bindingId/observations/:observationId/reviews';
function singleQuery(c: Ctx) {
  return Object.values(c.req.queries()).every((values) => values.length === 1);
}
type Scope = {
  tenant_id: string;
  engagement_id: string;
  binding_id: string;
  observation_id: string;
};
function sameScope(value: Scope, scope: Scope) {
  return Object.entries(scope).every(([key, v]) => value[key as keyof Scope] === v);
}
function scope(c: Ctx, engagement: string, binding: string, observation: string): Scope {
  return {
    tenant_id: c.get('tenantId').toLowerCase(),
    engagement_id: engagement,
    binding_id: binding,
    observation_id: observation,
  };
}
function cursor(value: string | undefined) {
  if (value === undefined) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) return undefined;
    return publicSourceCursorSchema.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    return undefined;
  }
}
type Cursor = z.infer<typeof publicSourceCursorSchema>;
function micros(timestamp: string) {
  return (
    BigInt(Date.parse(timestamp)) * 1000n +
    BigInt((timestamp.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0').slice(3, 6))
  );
}
function older(row: Cursor, prior: Cursor) {
  return (
    micros(row.created_at) < micros(prior.created_at) ||
    (micros(row.created_at) === micros(prior.created_at) && row.id < prior.id)
  );
}
function validPage(
  rows: PublicSourceReview[],
  page: { limit: number; has_more: boolean; next_cursor: Cursor | null },
  limit: number,
  prior: Cursor | null,
) {
  if (
    page.limit !== limit ||
    rows.length > limit ||
    new Set(rows.map((r) => r.review_id)).size !== rows.length
  )
    return false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const prev =
      i === 0 ? prior : { created_at: rows[i - 1]!.created_at, id: rows[i - 1]!.review_id };
    if (prev && !older({ created_at: row.created_at, id: row.review_id }, prev)) return false;
  }
  const last = rows.at(-1);
  return page.has_more
    ? rows.length === limit &&
        last !== undefined &&
        page.next_cursor?.id === last.review_id &&
        page.next_cursor.created_at === last.created_at
    : page.next_cursor === null;
}
const sourceKeys = [
  'agent',
  'dispatch_id',
  'run_id',
  'source_observation_id',
  'source_observation_sha256',
  'estate_id',
  'check_id',
  'projection_version',
  'root_content_sha256',
  'projection_sha256',
  'output_sha256',
  'source_request_sha256',
  'source_creation_receipt',
  'completion_receipt',
  'settlement_receipt',
] as const;
function sourceParity(rows: PublicSourceReview[]) {
  return rows.every((row) => sourceKeys.every((key) => row[key] === rows[0]![key]));
}
/** Durable SQL always validates current authority and recomputes chain-leaf state before replay. */
export function publicSourceReviewRoutes() {
  const app = new Hono<{ Variables: Variables }>();
  app.post(base, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.ASSESSMENT_RUN);
    if (denied) return denied;
    const binding = uuid.safeParse(c.req.param('bindingId'));
    const observation = uuid.safeParse(c.req.param('observationId'));
    const body = createPublicSourceReviewSchema.safeParse(await c.req.json().catch(() => null));
    const key = publicSourceReviewOperationKeySchema.safeParse(c.get('idempotencyKey'));
    if (
      !binding.success ||
      !observation.success ||
      !body.success ||
      !key.success ||
      Object.keys(c.req.query()).length
    )
      return c.json({ error: { code: 'invalid_request' } }, 400);
    const expected = scope(c, body.data.engagementId, binding.data, observation.data);
    const actor = c.get('user').id.toLowerCase();
    const target = body.data.target;
    try {
      const { data, error } = await createHumanActionWriter().rpc('submit_public_source_review', {
        p_tenant_id: expected.tenant_id,
        p_actor_id: actor,
        p_engagement_id: expected.engagement_id,
        p_binding_id: expected.binding_id,
        p_observation_id: expected.observation_id,
        p_expected_output_sha256: body.data.expectedOutputSha256,
        p_expected_projection_sha256: body.data.expectedProjectionSha256,
        p_target_kind: target.kind,
        p_page: target.kind === 'vibhaag_indicator' ? target.page : null,
        p_form_ordinal: target.kind === 'vibhaag_indicator' ? target.formOrdinal : null,
        p_control_ordinal: target.kind === 'vibhaag_indicator' ? target.controlOrdinal : null,
        p_expected_content_sha256:
          target.kind === 'vibhaag_indicator' ? target.expectedContentSha256 : null,
        p_decision: body.data.decision,
        p_justification: body.data.justification,
        p_expected_previous_review_id: body.data.expectedPreviousReviewId,
        p_operation_key: key.data,
      });
      if (error) return refusal(c, null);
      const parsed = publicSourceReviewRecordedSqlSchema.safeParse(data);
      if (!parsed.success) return refusal(c, data);
      const value = parsed.data;
      const row = value.data;
      if (
        !sameScope(value, expected) ||
        !sameScope(row, expected) ||
        row.reviewed_by !== actor ||
        row.operation_key !== key.data ||
        row.output_sha256 !== body.data.expectedOutputSha256 ||
        row.projection_sha256 !== body.data.expectedProjectionSha256 ||
        row.previous_review_id !== body.data.expectedPreviousReviewId ||
        row.target_kind !== target.kind ||
        row.decision !== body.data.decision ||
        row.justification !== body.data.justification ||
        (value.created && !row.is_current) ||
        (target.kind === 'vibhaag_indicator' &&
          (row.page !== target.page ||
            row.form_ordinal !== target.formOrdinal ||
            row.control_ordinal !== target.controlOrdinal ||
            row.content_sha256 !== target.expectedContentSha256))
      )
        return refusal(c, null);
      return c.json({ data: row, created: value.created, replayed: value.replayed }, 201);
    } catch {
      return refusal(c, null);
    }
  });
  app.get(base, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    const binding = uuid.safeParse(c.req.param('bindingId'));
    const observation = uuid.safeParse(c.req.param('observationId'));
    const query = querySchema.safeParse(c.req.query());
    if (!binding.success || !observation.success || !query.success || !singleQuery(c))
      return c.json({ error: { code: 'invalid_request' } }, 400);
    const after = cursor(query.data.cursor);
    if (after === undefined) return c.json({ error: { code: 'invalid_request' } }, 400);
    const expected = scope(c, query.data.engagementId, binding.data, observation.data);
    try {
      const { data, error } = await createHumanActionWriter().rpc('list_public_source_reviews', {
        p_tenant_id: expected.tenant_id,
        p_actor_id: c.get('user').id.toLowerCase(),
        p_engagement_id: expected.engagement_id,
        p_binding_id: expected.binding_id,
        p_observation_id: expected.observation_id,
        p_limit: query.data.limit,
        p_cursor_created_at: after?.created_at ?? null,
        p_cursor_id: after?.id ?? null,
      });
      if (error) return refusal(c, null);
      const parsed = publicSourceReviewPageSqlSchema.safeParse(data);
      if (!parsed.success) return refusal(c, data);
      const value = parsed.data;
      if (
        !sameScope(value, expected) ||
        value.data.some((row) => !sameScope(row, expected)) ||
        !sourceParity(value.data) ||
        !validPage(value.data, value, query.data.limit, after)
      )
        return refusal(c, null);
      return c.json({
        data: value.data,
        meta: {
          limit: value.limit,
          hasMore: value.has_more,
          nextCursor:
            value.next_cursor === null
              ? null
              : Buffer.from(JSON.stringify(value.next_cursor)).toString('base64url'),
        },
      });
    } catch {
      return refusal(c, null);
    }
  });
  app.get(base + '/request', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    const binding = uuid.safeParse(c.req.param('bindingId'));
    const observation = uuid.safeParse(c.req.param('observationId'));
    const query = requestQuery.safeParse(c.req.query());
    const key = publicSourceReviewOperationKeySchema.safeParse(
      c.req.header('X-Public-Source-Request-Key'),
    );
    if (
      !binding.success ||
      !observation.success ||
      !query.success ||
      !key.success ||
      !singleQuery(c)
    )
      return c.json({ error: { code: 'invalid_request' } }, 400);
    const expected = scope(c, query.data.engagementId, binding.data, observation.data);
    const actor = c.get('user').id.toLowerCase();
    try {
      const { data, error } = await createHumanActionWriter().rpc(
        'reconcile_public_source_review',
        {
          p_tenant_id: expected.tenant_id,
          p_actor_id: actor,
          p_engagement_id: expected.engagement_id,
          p_binding_id: expected.binding_id,
          p_observation_id: expected.observation_id,
          p_operation_key: key.data,
        },
      );
      if (error) return refusal(c, null);
      const parsed = publicSourceReviewRequestSqlSchema.safeParse(data);
      if (!parsed.success) return refusal(c, data);
      const value = parsed.data;
      if (
        !sameScope(value, expected) ||
        value.actor_id !== actor ||
        value.operation_key !== key.data ||
        (value.outcome.state === 'retained' &&
          (!sameScope(value.outcome.review, expected) ||
            value.outcome.review.reviewed_by !== actor ||
            value.outcome.review.operation_key !== key.data))
      )
        return refusal(c, null);
      return c.json({ data: value });
    } catch {
      return refusal(c, null);
    }
  });
  return app;
}
