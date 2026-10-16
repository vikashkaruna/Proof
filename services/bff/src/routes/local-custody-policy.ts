import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { parseCatalogueJson } from '@axiom/control-library';
import { createHumanActionWriter, createSupabaseAdmin } from '@axiom/supabase';
import {
  encodeLocalCustodyEvent,
  localCustodyEventRequestSchema,
  LOCAL_CUSTODY_MAX_BYTES,
} from '@axiom/types';
import type { Variables } from '../types.js';
import { boundedJsonBody } from '../middleware/evidence-body-limit.js';
import { bindingSha256, type MfaService } from '../services/mfa.js';
import {
  verifyLocalCustodyPolicy,
  verifyLocalCustodyReceipt,
  type LocalCustodyReadRpc,
} from '../workloads/local-key-admission.js';
const uuid = z.uuid();
const envelope = z
  .object({
    request: localCustodyEventRequestSchema,
    challengeId: uuid.optional(),
    code: z.string().min(1).max(256).optional(),
  })
  .strict();
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
/** UNMOUNTED. Normal verified Auth/tenant middleware is required by composition.
 * The SQL writer repeats live authority + fresh retained MFA; this factory adds
 * no global capability, bypass, provider configuration or automatic mutation. */
export function localCustodyPolicyRoutes(deps: {
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
  app.use('/local-custody-policy/*', boundedJsonBody(LOCAL_CUSTODY_MAX_BYTES * 4));
  app.post('/local-custody-policy/:step', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const step = c.req.param('step');
    if (!['challenge', 'verify', 'record', 'recover'].includes(step) || new URL(c.req.url).search)
      return c.json({ error: { code: 'invalid_request' } }, 400);
    const tenantId = uuid.safeParse(c.get('tenantId')),
      actorId = uuid.safeParse(c.get('user')?.id),
      sessionId = uuid.safeParse(c.get('sessionId')),
      expected = uuid.safeParse(c.req.header('X-Expected-Actor-Id'));
    if (!tenantId.success || !actorId.success || !sessionId.success)
      return c.json({ error: { code: 'current_session_required' } }, 401);
    if (!expected.success) return c.json({ error: { code: 'expected_actor_required' } }, 400);
    if (expected.data.toLowerCase() !== actorId.data.toLowerCase())
      return c.json({ error: { code: 'custody_actor_changed' } }, 409);
    if (!['owner', 'founder', 'axiom_analyst'].includes(c.get('role')))
      return c.json({ error: { code: 'custody_forbidden' } }, 403);
    let parsed: z.infer<typeof envelope>, text: string;
    try {
      parsed = envelope.parse(parseCatalogueJson(await c.req.text(), LOCAL_CUSTODY_MAX_BYTES * 4));
      text = encodeLocalCustodyEvent(parsed.request);
      const policy = verifyLocalCustodyPolicy(
        parsed.request.policyText,
        parsed.request.policySha256,
      );
      if (policy.tenantId !== tenantId.data.toLowerCase()) throw Error();
    } catch {
      return c.json({ error: { code: 'invalid_custody_request' } }, 400);
    }
    const key = uuid.safeParse(c.req.header('Idempotency-Key'));
    if (!key.success || key.data.toLowerCase() !== parsed.request.operationKey)
      return c.json({ error: { code: 'custody_operation_key_mismatch' } }, 400);
    const t = tenantId.data.toLowerCase(),
      a = actorId.data.toLowerCase(),
      s = sessionId.data.toLowerCase(),
      sha = digest(text);
    const args = { p_tenant_id: t, p_actor_id: a, p_session_id: s, p_request_text: text };
    try {
      if (step === 'recover' || step === 'record') {
        const outcome = await read('read_local_custody_policy_event', args, c.req.raw.signal);
        if (outcome.error) throw Error();
        const state = z
          .object({ state: z.literal('not_found') })
          .strict()
          .safeParse(outcome.data);
        if (!state.success)
          return c.json({
            data: verifyLocalCustodyReceipt(outcome.data, {
              tenantId: t,
              actorId: a,
              requestText: text,
            }),
          });
        if (step === 'recover') return c.json({ data: state.data });
      }
      const current = await read('preflight_local_custody_policy_event', args, c.req.raw.signal);
      if (current.error) throw Error();
      z.object({
        authorized: z.literal(true),
        tenantId: z.literal(t),
        actorId: z.literal(a),
        sessionId: z.literal(s),
        operationKey: z.literal(parsed.request.operationKey),
        requestSha256: z.literal(sha),
      })
        .strict()
        .parse(current.data);
      const binding = bindingSha256(['axiom.local-custody.transition', 1, t, a, s, sha]);
      if (step === 'challenge') {
        if (parsed.challengeId || parsed.code)
          return c.json({ error: { code: 'invalid_request' } }, 400);
        const result = await deps.mfa.issueChallenge({
          userId: a,
          tenantId: t,
          purpose: 'local_custody_policy',
          sessionId: s,
          boundResourceRef: parsed.request.operationKey,
          boundPayloadSha256: binding,
          ttlMs: 300000,
        });
        return result.ok
          ? c.json({ data: { challengeId: result.challengeId, expiresAt: result.expiresAt } })
          : c.json({ error: { code: 'custody_mfa_unavailable' } }, 403);
      }
      if (!parsed.challengeId) return c.json({ error: { code: 'custody_mfa_required' } }, 403);
      if (step === 'verify') {
        if (!parsed.code) return c.json({ error: { code: 'custody_mfa_required' } }, 403);
        const result = await deps.mfa.verifyChallenge({
          challengeId: parsed.challengeId,
          userId: a,
          code: parsed.code,
          sessionId: s,
          tenantId: t,
          boundResourceRef: parsed.request.operationKey,
          boundPayloadSha256: binding,
        });
        if (
          !result.ok ||
          result.purpose !== 'local_custody_policy' ||
          result.boundResourceRef !== parsed.request.operationKey
        )
          return c.json({ error: { code: 'custody_mfa_refused' } }, 403);
        return c.json({ data: { verified: true, challengeId: result.challengeId } });
      }
      if (parsed.code) return c.json({ error: { code: 'invalid_request' } }, 400);
      const consumed = await deps.mfa.consumeChallenge({
        userId: a,
        tenantId: t,
        purpose: 'local_custody_policy',
        challengeId: parsed.challengeId,
        boundResourceRef: parsed.request.operationKey,
        boundPayloadSha256: binding,
        consumedFor: parsed.request.operationKey,
      });
      if (!consumed.ok) return c.json({ error: { code: 'custody_mfa_refused' } }, 403);
      const response = await write(
        'record_local_custody_policy_event',
        { ...args, p_challenge_id: parsed.challengeId },
        c.req.raw.signal,
      );
      if (response.error) throw Error();
      return c.json(
        {
          data: verifyLocalCustodyReceipt(response.data, {
            tenantId: t,
            actorId: a,
            requestText: text,
          }),
        },
        201,
      );
    } catch {
      return c.json(
        {
          error: {
            code: 'custody_outcome_unconfirmed',
            message:
              'Check the retained request with the same operation key. No new policy or key should be inferred from this response.',
          },
        },
        503,
      );
    }
  });
  return app;
}
