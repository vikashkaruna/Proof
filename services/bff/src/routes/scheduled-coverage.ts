import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { createSupabaseAdmin, createHumanActionWriter } from '@axiom/supabase';
import { parseCatalogueJson } from '@axiom/control-library';
import {
  coverageScopeIntent,
  coverageScopeOperation,
  coverageScopeContext,
  encodeCoverageScopeIntent,
} from '@axiom/types';
import { bindingSha256, type MfaService } from '../services/mfa.js';
import { boundedJsonBody } from '../middleware/evidence-body-limit.js';
import type { Variables } from '../types.js';
const uuid = z.uuid();
const envelope = z
  .object({
    intent: coverageScopeIntent,
    challengeId: uuid.optional(),
    code: z.string().min(1).max(256).optional(),
  })
  .strict();
export function scheduledCoverageRoutes(deps: {
  mfa: Pick<MfaService, 'issueChallenge' | 'verifyChallenge' | 'consumeChallenge'>;
  enabled: boolean;
  available?: (tenantId: string) => boolean | Promise<boolean>;
}) {
  const app = new Hono<{ Variables: Variables }>();
  const canAuthorize = async (tenantId: string) => {
    if (!deps.enabled || !deps.available) return false;
    try {
      return await deps.available(tenantId);
    } catch {
      return false;
    }
  };
  app.use('/scheduled-coverage/*', boundedJsonBody(20000));
  for (const path of ['/scheduled-coverage', '/scheduled-coverage/*'])
    app.use(path, async (c, next) => {
      c.header('Cache-Control', 'private, no-store');
      if (new URL(c.req.url).search) return c.json({ error: { code: 'invalid_request' } }, 400);
      if (c.get('role') !== 'owner')
        return c.json({ error: { code: 'current_owner_required' } }, 403);
      const expected = uuid.safeParse(c.req.header('X-Expected-Actor-Id'));
      if (
        !expected.success ||
        expected.data !== c.get('user')?.id ||
        !uuid.safeParse(c.get('sessionId')).success
      )
        return c.json({ error: { code: 'current_actor_session_required' } }, 409);
      await next();
    });
  app.get('/scheduled-coverage', async (c) => {
    try {
      const result = await createSupabaseAdmin()
        .rpc('scheduled_coverage_scope_context', {
          p_tenant_id: c.get('tenantId'),
          p_actor_id: c.get('user').id,
          p_session_id: c.get('sessionId'),
        })
        .abortSignal(AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(5000)]));
      if (result.error) throw Error();
      const context = coverageScopeContext.parse(result.data);
      if (context.tenantId !== c.get('tenantId') || context.actorId !== c.get('user').id)
        throw Error();
      // An unavailable producer cannot grant fresh findings.write authority;
      // original history and authority reduction remain independently usable.
      const candidates = (await canAuthorize(c.get('tenantId'))) ? context.candidates : [];
      return c.json({ data: { ...context, candidates } });
    } catch {
      return c.json({ error: { code: 'coverage_approval_context_unavailable' } }, 503);
    }
  });
  app.post('/scheduled-coverage/:step', async (c) => {
    const step = c.req.param('step');
    if (!['challenge', 'verify', 'record', 'recover', 'fence'].includes(step))
      return c.json({ error: { code: 'invalid_step' } }, 400);
    let parsed: z.infer<typeof envelope>;
    try {
      parsed = envelope.parse(parseCatalogueJson(await c.req.text(), 20000));
    } catch {
      return c.json({ error: { code: 'invalid_request' } }, 400);
    }
    const { intent } = parsed,
      t = c.get('tenantId'),
      a = c.get('user').id,
      s = c.get('sessionId');
    if (intent.phase === 'authorize' && !['recover', 'fence'].includes(step)) {
      if (!deps.enabled) return c.json({ error: { code: 'coverage_approval_unavailable' } }, 503);
      if (!(await canAuthorize(t)))
        return c.json({ error: { code: 'coverage_producer_unavailable' } }, 503);
    }
    const text = encodeCoverageScopeIntent(intent),
      sha = createHash('sha256').update(text).digest('hex');
    const args = { p_tenant_id: t, p_actor_id: a, p_session_id: s, p_intent_text: text };
    const operationProof = (raw: unknown) => {
      const value = coverageScopeOperation.parse(raw);
      if (
        value.tenantId !== t ||
        value.actorId !== a ||
        value.phase !== intent.phase ||
        value.operationKey !== intent.request.operationKey ||
        value.requestSha256 !== sha ||
        (value.recorded &&
          (value.scopeId !==
            (intent.phase === 'authorize' ? intent.request.operationKey : intent.request.scopeId) ||
            (intent.phase === 'revoke' && !value.revoked)))
      )
        throw Error('Coverage proof binding refused');
      return value;
    };
    try {
      const previous = await createSupabaseAdmin()
        .rpc('read_scheduled_coverage_scope_operation', args)
        .abortSignal(AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(5000)]));
      if (previous.error) throw Error();
      const recorded = operationProof(previous.data);
      if (recorded.requestSha256 !== sha) throw Error();
      if (step === 'recover' || recorded.recorded || recorded.fenced)
        return c.json({ data: recorded });
      if (step === 'fence') {
        if (parsed.code || parsed.challengeId)
          return c.json({ error: { code: 'invalid_request' } }, 400);
        const fenced = await createHumanActionWriter()
          .rpc('fence_scheduled_coverage_scope', args)
          .abortSignal(AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(5000)]));
        if (fenced.error) throw Error();
        const result = operationProof(fenced.data);
        if (result.requestSha256 !== sha || (!result.recorded && !result.fenced)) throw Error();
        return c.json({ data: result });
      }
      const preflight = await createSupabaseAdmin()
        .rpc('preflight_scheduled_coverage_scope', args)
        .abortSignal(AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(5000)]));
      if (preflight.error) throw Error();
      const proof = z
        .object({
          intent: coverageScopeIntent,
          tenantId: z.literal(t),
          actorId: z.literal(a),
          sessionId: z.literal(s),
          phase: z.literal(intent.phase),
          requestSha256: z.literal(sha),
        })
        .strict()
        .parse(preflight.data);
      if (encodeCoverageScopeIntent(proof.intent) !== text) throw Error();
      const binding = bindingSha256(['axiom.scheduled-coverage.' + intent.phase, 1, t, a, s, sha]);
      const op = intent.request.operationKey;
      if (step === 'challenge') {
        if (parsed.challengeId || parsed.code)
          return c.json({ error: { code: 'invalid_request' } }, 400);
        const issued = await deps.mfa.issueChallenge({
          tenantId: t,
          userId: a,
          sessionId: s,
          purpose: 'scheduled_coverage',
          boundResourceRef: op,
          boundPayloadSha256: binding,
          ttlMs: 300000,
        });
        return issued.ok
          ? c.json({ data: { challengeId: issued.challengeId, expiresAt: issued.expiresAt } })
          : c.json({ error: { code: 'coverage_mfa_unavailable' } }, 403);
      }
      if (!parsed.challengeId) return c.json({ error: { code: 'coverage_mfa_required' } }, 403);
      if (step === 'verify') {
        if (!parsed.code) return c.json({ error: { code: 'coverage_mfa_required' } }, 403);
        const verified = await deps.mfa.verifyChallenge({
          challengeId: parsed.challengeId,
          userId: a,
          tenantId: t,
          sessionId: s,
          code: parsed.code,
          boundResourceRef: op,
          boundPayloadSha256: binding,
        });
        if (
          !verified.ok ||
          verified.purpose !== 'scheduled_coverage' ||
          verified.boundResourceRef !== op
        )
          return c.json({ error: { code: 'coverage_mfa_refused' } }, 403);
        return c.json({ data: { verified: true, challengeId: parsed.challengeId } });
      }
      if (parsed.code) return c.json({ error: { code: 'invalid_request' } }, 400);
      const consumed = await deps.mfa.consumeChallenge({
        challengeId: parsed.challengeId,
        userId: a,
        tenantId: t,
        sessionId: s,
        purpose: 'scheduled_coverage',
        boundResourceRef: op,
        boundPayloadSha256: binding,
        consumedFor: op,
      });
      if (!consumed.ok && consumed.reason !== 'challenge_already_consumed')
        return c.json({ error: { code: 'coverage_mfa_refused' } }, 403);
      const saved = await createHumanActionWriter()
        .rpc('record_scheduled_coverage_scope', {
          ...args,
          p_challenge_id: parsed.challengeId,
        })
        .abortSignal(AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(5000)]));
      if (saved.error) throw Error();
      const result = operationProof(saved.data);
      if (!result.recorded || result.requestSha256 !== sha) throw Error();
      return c.json({ data: result });
    } catch {
      return c.json(
        {
          error: {
            code: 'coverage_operation_unconfirmed',
            message: 'Preserve the exact coverage intent and check its recorded receipt.',
          },
        },
        503,
      );
    }
  });
  return app;
}
