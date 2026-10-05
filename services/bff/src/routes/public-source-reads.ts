import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { canonicalJson, sha256 } from '@axiom/ledger';
import { createHumanActionWriter } from '@axiom/supabase';
import {
  Capability,
  publicSourceCursorSchema,
  publicSourceReadQuerySchema,
  publicSourceRequestKeySchema,
  publicSourceEngagementPageSchema,
  publicSourceObservationPageSchema,
  publicSourceRequestStateSchema,
} from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';

type Ctx = Context<{ Variables: Variables }>;
const uuid = z.uuid().transform((value) => value.toLowerCase());
const statuses = {
  invalid_record: 400,
  forbidden: 403,
  context_refused: 404,
  source_refused: 404,
  request_context_conflict: 409,
} as const;
const errorSchema = z
  .object({
    error: z.enum([
      'invalid_record',
      'forbidden',
      'context_refused',
      'source_refused',
      'request_context_conflict',
    ]),
  })
  .strict();
function refusal(c: Ctx, value: unknown) {
  const parsed = errorSchema.safeParse(value);
  return parsed.success
    ? c.json({ error: { code: parsed.data.error } }, statuses[parsed.data.error])
    : c.json({ error: { code: 'public_source_read_unavailable' } }, 503);
}
function cursor(value?: string) {
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
function micros(timestamp: string): bigint {
  const fraction = (timestamp.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0');
  return BigInt(Date.parse(timestamp)) * 1000n + BigInt(fraction.slice(3, 6));
}
function older(row: Cursor, prior: Cursor): boolean {
  const currentTime = micros(row.created_at);
  const priorTime = micros(prior.created_at);
  return currentTime < priorTime || (currentTime === priorTime && row.id < prior.id);
}
function validPage(
  rows: Cursor[],
  page: { limit: number; has_more: boolean; next_cursor: Cursor | null },
  limit: number,
  prior: Cursor | null,
): boolean {
  if (
    page.limit !== limit ||
    rows.length > limit ||
    new Set(rows.map((row) => row.id)).size !== rows.length
  )
    return false;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const previous = index === 0 ? prior : rows[index - 1]!;
    if (previous && !older(row, previous)) return false;
  }
  const last = rows.at(-1);
  return page.has_more
    ? rows.length === limit &&
        last !== undefined &&
        page.next_cursor?.id === last.id &&
        page.next_cursor.created_at === last.created_at
    : page.next_cursor === null;
}
function meta(value: { limit: number; has_more: boolean; next_cursor: Cursor | null }) {
  return {
    limit: value.limit,
    hasMore: value.has_more,
    nextCursor:
      value.next_cursor === null
        ? null
        : Buffer.from(JSON.stringify(value.next_cursor)).toString('base64url'),
  };
}
const listQuery = publicSourceReadQuerySchema.extend({ engagementId: uuid }).strict();

/** These GETs never dispatch, claim execution, retry, append or retain results. */
export function publicSourceReadRoutes() {
  const app = new Hono<{ Variables: Variables }>();
  app.get('/public-source/options/engagements', async (c) => {
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    c.header('Cache-Control', 'private, no-store');
    const query = publicSourceReadQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: { code: 'invalid_request' } }, 400);
    const after = cursor(query.data.cursor);
    if (after === undefined) return c.json({ error: { code: 'invalid_request' } }, 400);
    try {
      const { data, error } = await createHumanActionWriter().rpc(
        'list_public_source_engagements',
        {
          p_tenant_id: c.get('tenantId'),
          p_actor_id: c.get('user').id,
          p_limit: query.data.limit,
          p_cursor_created_at: after?.created_at ?? null,
          p_cursor_id: after?.id ?? null,
        },
      );
      if (error) return refusal(c, null);
      const parsed = publicSourceEngagementPageSchema.safeParse(data);
      if (!parsed.success) return refusal(c, data);
      const result = parsed.data;
      const tenant = c.get('tenantId').toLowerCase();
      if (
        result.tenant_id !== tenant ||
        result.data.some((row) => row.tenant_id !== tenant) ||
        !validPage(result.data, result, query.data.limit, after)
      )
        return refusal(c, null);
      return c.json({ data: result.data, meta: meta(result) });
    } catch {
      return refusal(c, null);
    }
  });
  app.get('/public-source-bindings/:bindingId/observations', async (c) => {
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    c.header('Cache-Control', 'private, no-store');
    const binding = uuid.safeParse(c.req.param('bindingId'));
    const query = listQuery.safeParse(c.req.query());
    if (!binding.success || !query.success)
      return c.json({ error: { code: 'invalid_request' } }, 400);
    const after = cursor(query.data.cursor);
    if (after === undefined) return c.json({ error: { code: 'invalid_request' } }, 400);
    try {
      const { data, error } = await createHumanActionWriter().rpc(
        'list_public_source_observations',
        {
          p_tenant_id: c.get('tenantId'),
          p_actor_id: c.get('user').id,
          p_engagement_id: query.data.engagementId,
          p_binding_id: binding.data,
          p_limit: query.data.limit,
          p_cursor_created_at: after?.created_at ?? null,
          p_cursor_id: after?.id ?? null,
        },
      );
      if (error) return refusal(c, null);
      const parsed = publicSourceObservationPageSchema.safeParse(data);
      if (!parsed.success) return refusal(c, data);
      const result = parsed.data;
      const tenant = c.get('tenantId').toLowerCase();
      if (
        result.tenant_id !== tenant ||
        result.engagement_id !== query.data.engagementId ||
        result.binding_id !== binding.data ||
        result.data.some(
          (row) =>
            row.tenant_id !== tenant ||
            row.engagement_id !== query.data.engagementId ||
            row.binding_id !== binding.data,
        ) ||
        !validPage(
          result.data.map((row) => ({ id: row.observation_id, created_at: row.created_at })),
          result,
          query.data.limit,
          after,
        )
      )
        return refusal(c, null);
      return c.json({ data: result.data, meta: meta(result) });
    } catch {
      return refusal(c, null);
    }
  });
  app.get('/public-source-bindings/:bindingId/agents/:name/request', async (c) => {
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    c.header('Cache-Control', 'private, no-store');
    const binding = uuid.safeParse(c.req.param('bindingId'));
    const agent = z.enum(['drishti', 'vibhaag']).safeParse(c.req.param('name'));
    const query = z.object({ engagementId: uuid }).strict().safeParse(c.req.query());
    const key = publicSourceRequestKeySchema.safeParse(c.req.header('X-Public-Source-Request-Key'));
    if (!binding.success || !agent.success || !query.success || !key.success)
      return c.json({ error: { code: 'invalid_request' } }, 400);
    const tenant = c.get('tenantId').toLowerCase();
    const actor = c.get('user').id.toLowerCase();
    const hex = await sha256(
      canonicalJson({
        version: 1,
        operation: 'public_source_agent_run',
        tenant,
        actor,
        key: key.data,
      }),
    );
    const correlation = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    try {
      const { data, error } = await createHumanActionWriter().rpc(
        'reconcile_public_source_request',
        {
          p_tenant_id: tenant,
          p_actor_id: actor,
          p_engagement_id: query.data.engagementId,
          p_binding_id: binding.data,
          p_agent: agent.data,
          p_correlation_id: correlation,
        },
      );
      if (error) return refusal(c, null);
      const parsed = publicSourceRequestStateSchema.safeParse(data);
      if (!parsed.success) return refusal(c, data);
      const result = parsed.data;
      if (
        result.tenant_id !== tenant ||
        result.actor_id !== actor ||
        result.engagement_id !== query.data.engagementId ||
        result.binding_id !== binding.data ||
        result.agent !== agent.data ||
        result.correlation_id !== correlation
      )
        return refusal(c, null);
      return c.json({ data: result });
    } catch {
      return refusal(c, null);
    }
  });
  return app;
}
