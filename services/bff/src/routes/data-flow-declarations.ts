import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { createSupabaseAdmin, createHumanActionWriter } from '@axiom/supabase';
import { parseCatalogueJson } from '@axiom/control-library';
import {
  dataFlowIntent,
  dataFlowOperation,
  dataFlowContext,
  encodeDataFlowIntent,
  dataFlowSource,
  dataFlowConfiguration,
  Capability,
} from '@axiom/types';
import { bindingSha256, type MfaService } from '../services/mfa.js';
import { boundedJsonBody } from '../middleware/evidence-body-limit.js';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
const uuid = z.uuid();
const envelope = z
  .object({
    intent: dataFlowIntent,
    challengeId: uuid.optional(),
    code: z.string().min(1).max(256).optional(),
  })
  .strict();
export function dataFlowDeclarationRoutes(deps: {
  mfa: Pick<MfaService, 'issueChallenge' | 'verifyChallenge' | 'consumeChallenge'>;
  enabled: boolean;
}) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('/data-flows/*', boundedJsonBody(20000));
  for (const path of ['/data-flows', '/data-flows/*'])
    app.use(path, async (c, next) => {
      c.header('Cache-Control', 'private, no-store');
      if (new URL(c.req.url).search) return c.json({ error: { code: 'invalid_request' } }, 400);
      const refused = requireCapability(c, Capability.POSTURE_READ);
      if (refused) return refused;
      const expected = uuid.safeParse(c.req.header('X-Expected-Actor-Id'));
      if (
        !expected.success ||
        expected.data !== c.get('user')?.id ||
        !uuid.safeParse(c.get('sessionId')).success
      )
        return c.json({ error: { code: 'current_actor_session_required' } }, 409);
      if (!deps.enabled && !c.req.path.endsWith('/data-flows/configuration'))
        return c.json({ error: { code: 'data_flow_unavailable' } }, 503);
      await next();
    });
  app.get('/data-flows/configuration', (c) =>
    c.json({
      data: dataFlowConfiguration.parse({
        tenantId: c.get('tenantId'),
        actorId: c.get('user').id,
        enabled: deps.enabled,
        metadataOnly: true,
      }),
    }),
  );
  app.get('/data-flows/:revisionId?', async (c) => {
    try {
      const revisionId = c.req.param('revisionId');
      if (revisionId && !uuid.safeParse(revisionId).success)
        return c.json({ error: { code: 'invalid_revision' } }, 400);
      const result = await createSupabaseAdmin()
        .rpc('data_flow_declaration_context', {
          p_tenant_id: c.get('tenantId'),
          p_actor_id: c.get('user').id,
          p_session_id: c.get('sessionId'),
          p_revision_id: c.req.param('revisionId') ?? null,
        })
        .abortSignal(AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(5000)]));
      if (result.error) throw Error();
      const context = dataFlowContext.parse(result.data);
      if (
        revisionId &&
        (context.revisions.length !== 1 || context.revisions[0]?.revisionId !== revisionId)
      )
        return c.json({ error: { code: 'declaration_not_found' } }, 404);
      if (context.tenantId !== c.get('tenantId') || context.actorId !== c.get('user').id)
        throw Error();
      return c.json({ data: context });
    } catch {
      return c.json({ error: { code: 'data_flow_context_unavailable' } }, 503);
    }
  });
  app.post('/data-flows/:step', async (c) => {
    const step = c.req.param('step');
    if (!['challenge', 'verify', 'record', 'recover', 'fence'].includes(step))
      return c.json({ error: { code: 'invalid_step' } }, 400);
    let parsed: z.infer<typeof envelope>;
    try {
      parsed = envelope.parse(parseCatalogueJson(await c.req.text(), 20000));
    } catch {
      return c.json({ error: { code: 'invalid_request' } }, 400);
    }
    if (['recover', 'fence'].includes(step) && (parsed.code || parsed.challengeId))
      return c.json({ error: { code: 'invalid_request' } }, 400);
    if (step !== 'recover') {
      const refused = requireCapability(c, Capability.ESTATE_MANAGE);
      if (refused) return refused;
    }
    const { intent } = parsed,
      t = c.get('tenantId'),
      a = c.get('user').id,
      s = c.get('sessionId');
    const text = encodeDataFlowIntent(intent),
      sha = createHash('sha256').update(text).digest('hex');
    const args = { p_tenant_id: t, p_actor_id: a, p_session_id: s, p_intent_text: text };
    const operationProof = (raw: unknown) => {
      const value = dataFlowOperation.parse(raw);
      if (
        value.tenantId !== t ||
        value.actorId !== a ||
        value.phase !== intent.phase ||
        value.operationKey !== intent.request.operationKey ||
        value.requestSha256 !== sha
      )
        throw Error('Data flow proof binding refused');
      if (
        value.recorded &&
        value.revisionId !==
          (intent.phase === 'declare' ? intent.request.operationKey : intent.request.revisionId)
      )
        throw Error('Data flow revision binding refused');
      return value;
    };
    try {
      const previous = await createSupabaseAdmin()
        .rpc('read_data_flow_declaration_operation', args)
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
          .rpc('fence_data_flow_declaration', args)
          .abortSignal(AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(5000)]));
        if (fenced.error) throw Error();
        const result = operationProof(fenced.data);
        if (result.requestSha256 !== sha || (!result.recorded && !result.fenced)) throw Error();
        return c.json({ data: result });
      }
      const preflight = await createSupabaseAdmin()
        .rpc('preflight_data_flow_declaration', args)
        .abortSignal(AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(5000)]));
      if (preflight.error) {
        if (['40001', '23505'].includes(preflight.error.code))
          return c.json({ error: { code: 'data_flow_source_changed' } }, 409);
        if (preflight.error.code === '42501')
          return c.json({ error: { code: 'data_flow_source_refused' } }, 403);
        if (preflight.error.code === '22023')
          return c.json({ error: { code: 'invalid_request' } }, 400);
        throw Error();
      }
      const proof = z
        .object({
          intent: dataFlowIntent,
          tenantId: z.literal(t),
          actorId: z.literal(a),
          sessionId: z.literal(s),
          phase: z.literal(intent.phase),
          requestSha256: z.literal(sha),
          source: dataFlowSource,
          sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(preflight.data);
      if (encodeDataFlowIntent(proof.intent) !== text) throw Error();
      const binding = bindingSha256(['axiom.data-flow.' + intent.phase, 1, t, a, s, sha]);
      const op = intent.request.operationKey;
      if (step === 'challenge') {
        if (parsed.challengeId || parsed.code)
          return c.json({ error: { code: 'invalid_request' } }, 400);
        const issued = await deps.mfa.issueChallenge({
          tenantId: t,
          userId: a,
          sessionId: s,
          purpose: 'data_flow_declaration',
          boundResourceRef: op,
          boundPayloadSha256: binding,
          ttlMs: 300000,
        });
        return issued.ok
          ? c.json({ data: { challengeId: issued.challengeId, expiresAt: issued.expiresAt } })
          : c.json({ error: { code: 'data_flow_mfa_unavailable' } }, 403);
      }
      if (!parsed.challengeId) return c.json({ error: { code: 'data_flow_mfa_required' } }, 403);
      if (step === 'verify') {
        if (!parsed.code) return c.json({ error: { code: 'data_flow_mfa_required' } }, 403);
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
          verified.purpose !== 'data_flow_declaration' ||
          verified.boundResourceRef !== op
        )
          return c.json({ error: { code: 'data_flow_mfa_refused' } }, 403);
        return c.json({ data: { verified: true, challengeId: parsed.challengeId } });
      }
      if (parsed.code) return c.json({ error: { code: 'invalid_request' } }, 400);
      const consumed = await deps.mfa.consumeChallenge({
        challengeId: parsed.challengeId,
        userId: a,
        tenantId: t,
        sessionId: s,
        purpose: 'data_flow_declaration',
        boundResourceRef: op,
        boundPayloadSha256: binding,
        consumedFor: op,
      });
      if (!consumed.ok && consumed.reason !== 'challenge_already_consumed')
        return c.json({ error: { code: 'data_flow_mfa_refused' } }, 403);
      const saved = await createHumanActionWriter()
        .rpc('record_data_flow_declaration', {
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
            code: 'data_flow_operation_unconfirmed',
            message: 'Preserve the exact declaration intent and check its recorded receipt.',
          },
        },
        503,
      );
    }
  });
  return app;
}
