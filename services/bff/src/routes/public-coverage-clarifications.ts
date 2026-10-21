import { Hono } from 'hono';
import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import { parseCatalogueJson } from '@axiom/control-library';
import { createHumanActionWriter, createSupabaseAdmin } from '@axiom/supabase';
import {
  Capability,
  publicCoverageClarificationRequestSchema,
  publicCoverageClarificationRecordSchema,
} from '@axiom/types';
import type { Variables } from '../types.js';
import { requireCapability } from '../middleware/authorize.js';
import { boundedJsonBody } from '../middleware/evidence-body-limit.js';
import { parsePublicUrl } from '../connectors/public-website.js';
import { verifyPublicCoverageClarification } from '../services/public-coverage-clarifications.js';
const uuid = z.uuid().transform((v) => v.toLowerCase());
const query = z
  .object({ engagementId: uuid, checkId: uuid, payloadSha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
const response = z
  .object({ canClarify: z.boolean(), record: publicCoverageClarificationRecordSchema.nullable() })
  .strict();
const writeResponse = z
  .object({ record: publicCoverageClarificationRecordSchema, replayed: z.boolean() })
  .strict();
const errors = {
  invalid_record: 400,
  forbidden: 403,
  context_refused: 404,
  source_refused: 404,
  stale_revision: 409,
  idempotency_conflict: 409,
  explanation_required: 409,
} as const;
const refusal = z
  .object({
    error: z.enum(Object.keys(errors) as [keyof typeof errors, ...Array<keyof typeof errors>]),
  })
  .strict();
type Rpc = (
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<{ data: unknown; error: unknown }>;
export function publicCoverageClarificationRoutes(deps: { read?: Rpc; write?: Rpc } = {}) {
  const read: Rpc =
    deps.read ??
    (async (name, args, signal) => createSupabaseAdmin().rpc(name, args).abortSignal(signal));
  const write: Rpc =
    deps.write ??
    (async (name, args, signal) => createHumanActionWriter().rpc(name, args).abortSignal(signal));
  const app = new Hono<{ Variables: Variables }>();
  app.use('/public-coverage-clarifications', boundedJsonBody(16384));
  for (const path of [
    '/public-coverage-clarifications',
    '/public-coverage-clarifications/operations/:key',
  ]) {
    app.get(path, async (c) => {
      c.header('Cache-Control', 'private, no-store');
      const denied = requireCapability(c, Capability.POSTURE_READ);
      if (denied) return denied;
      const q = query.safeParse(c.req.query()),
        operation = c.req.param('key');
      if (
        !q.success ||
        Object.values(c.req.queries()).some((v) => v.length !== 1) ||
        (operation !== undefined && !uuid.safeParse(operation).success)
      )
        return c.json({ error: { code: 'invalid_request' } }, 400);
      const scope = { tenantId: c.get('tenantId').toLowerCase(), ...q.data };
      try {
        const result = await read(
          'read_public_coverage_clarification',
          {
            p_tenant_id: scope.tenantId,
            p_actor_id: c.get('user').id,
            p_engagement_id: scope.engagementId,
            p_check_id: scope.checkId,
            p_payload_sha256: scope.payloadSha256,
            p_operation_key: operation ?? null,
          },
          AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10000)]),
        );
        if (result.error) throw Error();
        const value = response.parse(result.data);
        if (value.record)
          verifyPublicCoverageClarification(value.record, {
            ...scope,
            ...(operation ? { operationKey: operation.toLowerCase() } : {}),
          });
        return c.json({ data: value });
      } catch {
        return c.json({ error: { code: 'coverage_clarification_unavailable' } }, 503);
      }
    });
  }
  app.post('/public-coverage-clarifications', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.ESTATE_MANAGE);
    if (denied) return denied;
    const actorId = c.get('user').id.toLowerCase(),
      tenantId = c.get('tenantId').toLowerCase();
    if (c.req.header('X-Expected-Actor-Id')?.toLowerCase() !== actorId)
      return c.json({ error: { code: 'actor_context_changed' } }, 409);
    if (!uuid.safeParse(c.get('sessionId')).success)
      return c.json({ error: { code: 'session_required' } }, 403);
    let request: z.infer<typeof publicCoverageClarificationRequestSchema>;
    try {
      request = publicCoverageClarificationRequestSchema.parse(
        parseCatalogueJson(
          new TextDecoder('utf-8', { fatal: true }).decode(await c.req.arrayBuffer()),
          16384,
        ),
      );
      if (request.operationKey !== c.get('idempotencyKey') || Object.keys(c.req.query()).length)
        throw Error();
      for (const entry of request.clarifications)
        if (
          entry.proposedPublicUrl &&
          parsePublicUrl(entry.proposedPublicUrl).href !== entry.proposedPublicUrl
        )
          throw Error();
    } catch {
      return c.json({ error: { code: 'invalid_request' } }, 400);
    }
    const requestText = canonicalJson(request);
    try {
      const result = await write(
        'submit_public_coverage_clarification',
        {
          p_tenant_id: tenantId,
          p_actor_id: actorId,
          p_session_id: c.get('sessionId'),
          p_request_text: requestText,
        },
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30000)]),
      );
      if (result.error) throw Error();
      const failed = refusal.safeParse(result.data);
      if (failed.success)
        return c.json({ error: { code: failed.data.error } }, errors[failed.data.error]);
      const value = writeResponse.parse(result.data);
      verifyPublicCoverageClarification(value.record, {
        tenantId,
        actorId,
        engagementId: request.engagementId,
        checkId: request.checkId,
        payloadSha256: request.payloadSha256,
        operationKey: request.operationKey,
        requestText,
      });
      return c.json({ data: value }, 201);
    } catch {
      return c.json({ error: { code: 'coverage_clarification_unavailable' } }, 503);
    }
  });
  return app;
}
