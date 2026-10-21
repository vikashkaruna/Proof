import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import {
  Capability,
  CatalogueEngagementResponseSchema,
  CatalogueReauditRequestSchema,
  CatalogueReauditDecisionSchema,
  CatalogueReauditReceiptSchema,
} from '@axiom/types';
import { createHumanActionWriter, createSupabaseAdmin } from '@axiom/supabase';
import type { Variables } from '../types.js';
import { requireCapability } from '../middleware/authorize.js';
import { boundedJsonBody } from '../middleware/evidence-body-limit.js';
import { bindingSha256, type MfaService } from '../services/mfa.js';
import type { LocalCustodyReadRpc } from '../workloads/local-key-admission.js';

function errorCode(error: unknown): string | null {
  const parsed = z.object({ code: z.string() }).safeParse(error);
  return parsed.success ? parsed.data.code : null;
}

const challengeFields = {
  challengeId: z.uuid().optional(),
  code: z.string().min(1).max(256).optional(),
};
const requestEnvelope = z
  .object({ request: CatalogueReauditRequestSchema, ...challengeFields })
  .strict();
const decisionEnvelope = z
  .object({ request: CatalogueReauditDecisionSchema, ...challengeFields })
  .strict();

/** The organization read model does not adopt a version. SQL repeats membership,
 * live founder designation, immutable source fingerprints and fresh bound MFA. */
export function catalogueEngagementRoutes(deps: {
  mfa: MfaService;
  read?: LocalCustodyReadRpc;
  write?: LocalCustodyReadRpc;
}) {
  const read =
    deps.read ??
    (async (name, args, signal) => createSupabaseAdmin().rpc(name, args).abortSignal(signal));
  const write =
    deps.write ??
    (async (name, args, signal) => createHumanActionWriter().rpc(name, args).abortSignal(signal));
  const app = new Hono<{ Variables: Variables }>();
  app.use('/catalogue-engagement/*', boundedJsonBody(8192));
  app.get('/catalogue-engagement', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const refused = requireCapability(c, Capability.POSTURE_READ);
    if (refused) return refused;
    if (new URL(c.req.url).search) return c.json({ error: { code: 'invalid_request' } }, 400);
    if (!z.uuid().safeParse(c.get('sessionId')).success)
      return c.json({ error: { code: 'current_session_required' } }, 401);
    try {
      const result = await read(
        'read_catalogue_engagement',
        {
          p_tenant_id: c.get('tenantId'),
          p_actor_id: c.get('user').id,
          p_session_id: c.get('sessionId'),
        },
        c.req.raw.signal,
      );
      if (result.error)
        return c.json(
          { error: { code: 'catalogue_engagement_unavailable' } },
          errorCode(result.error) === '42501' ? 403 : 503,
        );
      return c.json({ data: CatalogueEngagementResponseSchema.parse(result.data) });
    } catch {
      return c.json({ error: { code: 'catalogue_engagement_unavailable' } }, 503);
    }
  });
  app.post('/catalogue-engagement/:kind/:step', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const kind = c.req.param('kind'),
      step = c.req.param('step');
    if (
      !['request', 'decision'].includes(kind) ||
      !['challenge', 'verify', 'submit'].includes(step) ||
      new URL(c.req.url).search
    )
      return c.json({ error: { code: 'invalid_request' } }, 400);
    const deciding = kind === 'decision';
    if (c.get('role') !== (deciding ? 'founder' : 'owner'))
      return c.json({ error: { code: deciding ? 'founder_required' : 'owner_required' } }, 403);
    const tenantId = c.get('tenantId'),
      actorId = c.get('user').id,
      sessionId = c.get('sessionId');
    if (!z.uuid().safeParse(sessionId).success)
      return c.json({ error: { code: 'current_session_required' } }, 401);
    if (c.req.header('X-Expected-Actor-Id') !== actorId)
      return c.json({ error: { code: 'catalogue_actor_changed' } }, 409);
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = deciding ? decisionEnvelope.safeParse(body) : requestEnvelope.safeParse(body);
    if (!parsed.success)
      return c.json({ error: { code: 'invalid_catalogue_reaudit_request' } }, 400);
    const { request, challengeId, code } = parsed.data;
    if (c.req.header('Idempotency-Key') !== request.operationKey)
      return c.json({ error: { code: 'catalogue_operation_key_mismatch' } }, 400);
    const text = canonicalJson(request),
      hash = createHash('sha256').update(text).digest('hex');
    const args = {
      p_tenant_id: tenantId,
      p_actor_id: actorId,
      p_session_id: sessionId,
      p_request_text: text,
      p_decision: deciding,
    };
    try {
      const preflight = await read('preflight_catalogue_reaudit', args, c.req.raw.signal);
      if (preflight.error) {
        const status =
          errorCode(preflight.error) === '42501'
            ? 403
            : errorCode(preflight.error) === '23514' || errorCode(preflight.error) === '23505'
              ? 409
              : 503;
        return c.json(
          {
            error: {
              code:
                status === 409 ? 'catalogue_reaudit_source_changed' : 'catalogue_reaudit_refused',
            },
          },
          status,
        );
      }
      z.object({ authorized: z.literal(true), requestSha256: z.literal(hash) })
        .passthrough()
        .parse(preflight.data);
      const binding = bindingSha256([
        deciding ? 'axiom.catalogue-reaudit.decision' : 'axiom.catalogue-reaudit.request',
        1,
        tenantId,
        actorId,
        sessionId,
        hash,
      ]);
      const scope = {
        userId: actorId,
        tenantId,
        sessionId,
        boundResourceRef: request.operationKey,
        boundPayloadSha256: binding,
      };
      if (step === 'challenge') {
        if (challengeId || code) return c.json({ error: { code: 'invalid_request' } }, 400);
        const result = await deps.mfa.issueChallenge({
          ...scope,
          purpose: 'catalogue_adoption',
          ttlMs: 300000,
        });
        return result.ok
          ? c.json({ data: { challengeId: result.challengeId, expiresAt: result.expiresAt } })
          : c.json({ error: { code: 'catalogue_mfa_unavailable' } }, 403);
      }
      if (!challengeId) return c.json({ error: { code: 'catalogue_mfa_required' } }, 403);
      if (step === 'verify') {
        if (!code) return c.json({ error: { code: 'catalogue_mfa_required' } }, 403);
        const result = await deps.mfa.verifyChallenge({ ...scope, challengeId, code });
        if (
          !result.ok ||
          result.purpose !== 'catalogue_adoption' ||
          result.boundResourceRef !== request.operationKey
        )
          return c.json({ error: { code: 'catalogue_mfa_refused' } }, 403);
        return c.json({ data: { verified: true } });
      }
      if (code) return c.json({ error: { code: 'invalid_request' } }, 400);
      const consumed = await deps.mfa.consumeChallenge({
        ...scope,
        challengeId,
        purpose: 'catalogue_adoption',
        consumedFor: request.operationKey,
      });
      if (!consumed.ok) return c.json({ error: { code: 'catalogue_mfa_refused' } }, 403);
      const result = await write(
        'submit_catalogue_reaudit',
        { ...args, p_challenge_id: challengeId },
        c.req.raw.signal,
      );
      if (result.error) throw new Error('unconfirmed');
      return c.json({ data: CatalogueReauditReceiptSchema.parse(result.data) });
    } catch {
      return c.json(
        {
          error: {
            code: 'catalogue_reaudit_unconfirmed',
            message: 'Keep this request and refresh the catalogue workspace before retrying.',
          },
        },
        503,
      );
    }
  });
  return app;
}
