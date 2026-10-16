import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { parseCatalogueJson } from '@axiom/control-library';
import { createHumanActionWriter, createSupabaseAdmin } from '@axiom/supabase';
import {
  encodeLocalCustodyEvent,
  encodeLocalCustodyCancellation,
  localCustodyCancellationSchema,
  localCustodyEventRequestSchema,
  LOCAL_CUSTODY_MAX_BYTES,
} from '@axiom/types';
import type { Variables } from '../types.js';
import { boundedJsonBody } from '../middleware/evidence-body-limit.js';
import { bindingSha256, type MfaService } from '../services/mfa.js';
import {
  verifyLocalCustodyPolicy,
  verifyLocalCustodyContext,
  verifyLocalCustodyReceipt,
  verifyLocalCustodyCancellation,
  type LocalCustodyReadRpc,
} from '../workloads/local-key-admission.js';
const uuid = z.uuid();
const extra = { challengeId: uuid.optional(), code: z.string().min(1).max(256).optional() };
const envelope = z.union([
  z.object({ request: localCustodyEventRequestSchema, ...extra }).strict(),
  z.object({ resolution: localCustodyCancellationSchema, ...extra }).strict(),
]);
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
/** Mounted behind normal verified Auth/tenant middleware.
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
  app.get('/local-custody-policy/context', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const tenant = uuid.safeParse(c.get('tenantId')),
      actor = uuid.safeParse(c.get('user')?.id),
      session = uuid.safeParse(c.get('sessionId')),
      expected = uuid.safeParse(c.req.header('X-Expected-Actor-Id'));
    if (!tenant.success || !actor.success || !session.success)
      return c.json({ error: { code: 'current_session_required' } }, 401);
    if (!expected.success) return c.json({ error: { code: 'expected_actor_required' } }, 400);
    if (expected.data.toLowerCase() !== actor.data.toLowerCase())
      return c.json({ error: { code: 'custody_actor_changed' } }, 409);
    if (!['owner', 'founder', 'axiom_analyst'].includes(c.get('role')))
      return c.json({ error: { code: 'custody_forbidden' } }, 403);
    const query = z
      .object({
        policyId: uuid.optional(),
        after: uuid.optional(),
        beforeReceiptId: z
          .string()
          .regex(/^[1-9][0-9]{0,18}$/)
          .optional(),
      })
      .strict()
      .safeParse(c.req.query());
    if (
      !query.success ||
      (query.data.policyId && query.data.after) ||
      (!query.data.policyId && query.data.beforeReceiptId) ||
      new URL(c.req.url).searchParams.size !== Object.keys(c.req.query()).length
    )
      return c.json({ error: { code: 'invalid_custody_context' } }, 400);
    const t = tenant.data.toLowerCase(),
      a = actor.data.toLowerCase(),
      policyId = query.data.policyId?.toLowerCase() ?? null;
    try {
      const response = await read(
        'read_local_custody_operator_context',
        {
          p_tenant_id: t,
          p_actor_id: a,
          p_session_id: session.data.toLowerCase(),
          p_policy_id: policyId,
          p_after_policy_id: query.data.after?.toLowerCase() ?? null,
          p_before_receipt_id: query.data.beforeReceiptId ?? null,
        },
        c.req.raw.signal,
      );
      if (response.error) throw Error();
      return c.json({
        data: verifyLocalCustodyContext(response.data, {
          tenantId: t,
          actorId: a,
          policyId,
          historyPage: query.data.beforeReceiptId !== undefined,
        }),
      });
    } catch {
      return c.json(
        {
          error: {
            code: 'custody_context_unavailable',
            message: 'Current custody context could not be verified. Refresh before acting.',
          },
        },
        503,
      );
    }
  });
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
    let parsed: z.infer<typeof envelope>, text: string, originalText: string;
    let resolution = false,
      operationKey: string;
    try {
      parsed = envelope.parse(parseCatalogueJson(await c.req.text(), LOCAL_CUSTODY_MAX_BYTES * 4));
      resolution = 'resolution' in parsed;
      text =
        'resolution' in parsed
          ? encodeLocalCustodyCancellation(parsed.resolution)
          : encodeLocalCustodyEvent(parsed.request);
      const original =
        'resolution' in parsed
          ? localCustodyEventRequestSchema.parse(JSON.parse(parsed.resolution.originalRequestText))
          : parsed.request;
      originalText = encodeLocalCustodyEvent(original);
      operationKey =
        'resolution' in parsed ? parsed.resolution.operationKey : parsed.request.operationKey;
      const policy = verifyLocalCustodyPolicy(original.policyText, original.policySha256);
      if (policy.tenantId !== tenantId.data.toLowerCase()) throw Error();
    } catch {
      return c.json({ error: { code: 'invalid_custody_request' } }, 400);
    }
    const key = uuid.safeParse(c.req.header('Idempotency-Key'));
    if (!key.success || key.data.toLowerCase() !== operationKey)
      return c.json({ error: { code: 'custody_operation_key_mismatch' } }, 400);
    const t = tenantId.data.toLowerCase(),
      a = actorId.data.toLowerCase(),
      s = sessionId.data.toLowerCase(),
      sha = digest(text);
    const args = { p_tenant_id: t, p_actor_id: a, p_session_id: s, p_request_text: text };
    try {
      const outcome = await read(
        resolution ? 'read_local_custody_policy_cancellation' : 'read_local_custody_policy_outcome',
        args,
        c.req.raw.signal,
      );
      if (outcome.error) throw Error();
      const state = z
        .object({ state: z.literal('not_found') })
        .strict()
        .safeParse(outcome.data);
      if (!state.success)
        return c.json({
          data:
            typeof outcome.data === 'object' &&
            outcome.data !== null &&
            'state' in outcome.data &&
            outcome.data.state === 'cancelled'
              ? verifyLocalCustodyCancellation(outcome.data, {
                  tenantId: t,
                  actorId: a,
                  originalRequestText: originalText,
                  ...(resolution ? { cancellationText: text } : {}),
                })
              : verifyLocalCustodyReceipt(outcome.data, {
                  tenantId: t,
                  actorId: a,
                  requestText: originalText,
                }),
        });
      if (step === 'recover') return c.json({ data: state.data });
      const current = await read(
        resolution
          ? 'preflight_local_custody_policy_cancellation'
          : 'preflight_local_custody_policy_event',
        args,
        c.req.raw.signal,
      );
      if (current.error) throw Error();
      z.object({
        authorized: z.literal(true),
        tenantId: z.literal(t),
        actorId: z.literal(a),
        sessionId: z.literal(s),
        operationKey: z.literal(operationKey),
        requestSha256: z.literal(sha),
      })
        .strict()
        .parse(current.data);
      const binding = bindingSha256([
        resolution ? 'axiom.local-custody.cancel' : 'axiom.local-custody.transition',
        1,
        t,
        a,
        s,
        sha,
      ]);
      if (step === 'challenge') {
        if (parsed.challengeId || parsed.code)
          return c.json({ error: { code: 'invalid_request' } }, 400);
        const result = await deps.mfa.issueChallenge({
          userId: a,
          tenantId: t,
          purpose: 'local_custody_policy',
          sessionId: s,
          boundResourceRef: operationKey,
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
          boundResourceRef: operationKey,
          boundPayloadSha256: binding,
        });
        if (
          !result.ok ||
          result.purpose !== 'local_custody_policy' ||
          result.boundResourceRef !== operationKey
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
        boundResourceRef: operationKey,
        boundPayloadSha256: binding,
        consumedFor: operationKey,
      });
      if (!consumed.ok) return c.json({ error: { code: 'custody_mfa_refused' } }, 403);
      const response = await write(
        resolution
          ? 'record_local_custody_policy_cancellation'
          : 'record_local_custody_policy_event',
        { ...args, p_challenge_id: parsed.challengeId },
        c.req.raw.signal,
      );
      if (response.error) throw Error();
      return c.json(
        {
          data: resolution
            ? typeof response.data === 'object' &&
              response.data !== null &&
              'state' in response.data &&
              response.data.state === 'recorded'
              ? verifyLocalCustodyReceipt(response.data, {
                  tenantId: t,
                  actorId: a,
                  requestText: originalText,
                })
              : verifyLocalCustodyCancellation(response.data, {
                  tenantId: t,
                  actorId: a,
                  originalRequestText: originalText,
                  cancellationText: text,
                })
            : verifyLocalCustodyReceipt(response.data, {
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
