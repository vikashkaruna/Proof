import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { createHumanActionWriter, createSupabaseAdmin } from '@axiom/supabase';
import { parseCatalogueJson } from '@axiom/control-library';
import {
  monitoringReadScopeIntent,
  monitoringReadScopeOperation,
  monitoringReadScopeContext,
  encodeMonitoringReadScope,
} from '@axiom/types';
import type { Variables } from '../types.js';
import { bindingSha256, type MfaService } from '../services/mfa.js';
import { boundedJsonBody } from '../middleware/evidence-body-limit.js';
import type { DiscoveryRequestController } from './postgresql-discovery.js';
const uuid = z.uuid();
const envelope = z
  .object({
    intent: monitoringReadScopeIntent,
    challengeId: uuid.optional(),
    code: z.string().min(1).max(256).optional(),
  })
  .strict();
export function monitoringReadScopesEnabled() {
  return (
    process.env.AXIOM_SCHEDULED_POSTGRESQL_READ_ENABLED === 'true' &&
    ['local', 'test'].includes(process.env.ENVIRONMENT ?? '') &&
    (process.env.AXIOM_AUTH_MODE ?? 'strict') === 'strict'
  );
}
export function monitoringReadScopeRoutes(deps: {
  mfa: Pick<MfaService, 'issueChallenge' | 'verifyChallenge' | 'consumeChallenge'>;
  controller?: DiscoveryRequestController;
  enabled?: boolean;
}) {
  const app = new Hono<{ Variables: Variables }>();
  const enabled = deps.enabled ?? monitoringReadScopesEnabled();
  app.use('/monitoring/schedules/:schedule/read-scope/*', boundedJsonBody(16384));
  for (const path of [
    '/monitoring/schedules/:schedule/read-scope',
    '/monitoring/schedules/:schedule/read-scope/*',
  ])
    app.use(path, async (c, next) => {
      c.header('Cache-Control', 'private, no-store');
      if (new URL(c.req.url).search) return c.json({ error: { code: 'invalid_request' } }, 400);
      if (!enabled) return c.json({ error: { code: 'scheduled_reads_unavailable' } }, 503);
      if (c.get('role') !== 'owner') return c.json({ error: { code: 'owner_required' } }, 403);
      const expected = uuid.safeParse(c.req.header('X-Expected-Actor-Id'));
      if (
        !expected.success ||
        expected.data !== c.get('user')?.id ||
        !uuid.safeParse(c.get('sessionId')).success
      )
        return c.json({ error: { code: 'current_owner_session_required' } }, 409);
      await next();
    });
  app.get('/monitoring/schedules/:schedule/read-scope', async (c) => {
    try {
      const schedule = uuid.parse(c.req.param('schedule'));
      const reply = await createSupabaseAdmin()
        .rpc('monitoring_read_scope_context', {
          p_tenant_id: c.get('tenantId'),
          p_actor_id: c.get('user').id,
          p_session_id: c.get('sessionId'),
          p_schedule_id: schedule,
        })
        .abortSignal(c.req.raw.signal);
      if (reply.error) throw Error();
      const context = monitoringReadScopeContext.parse(reply.data);
      if (
        context.tenantId !== c.get('tenantId') ||
        context.actorId !== c.get('user').id ||
        context.scheduleId !== schedule
      )
        throw Error();
      return c.json({ data: context, preflightAvailable: !!deps.controller });
    } catch {
      return c.json({ error: { code: 'scheduled_read_context_unavailable' } }, 503);
    }
  });
  app.post('/monitoring/schedules/:schedule/read-scope/preflight', async (c) => {
    if (!deps.controller) return c.json({ error: { code: 'discovery_unavailable' } }, 503);
    try {
      const input = z
        .object({ operationKey: uuid, connectorId: uuid, engagementId: uuid })
        .strict()
        .parse(parseCatalogueJson(await c.req.text(), 16384));
      const schedule = uuid.parse(c.req.param('schedule'));
      const t = c.get('tenantId'),
        a = c.get('user').id;
      const reply = await createSupabaseAdmin()
        .rpc('monitoring_read_scope_context', {
          p_tenant_id: t,
          p_actor_id: a,
          p_session_id: c.get('sessionId'),
          p_schedule_id: schedule,
        })
        .abortSignal(c.req.raw.signal);
      if (reply.error) throw Error();
      const context = monitoringReadScopeContext.parse(reply.data);
      if (
        context.kind !== 'rediscovery' ||
        context.tenantId !== t ||
        context.actorId !== a ||
        context.scheduleId !== schedule ||
        !context.targets.some((x) => x.connectorId === input.connectorId) ||
        !context.engagements.some((x) => x.id === input.engagementId)
      )
        throw Error();
      const writer = createHumanActionWriter();
      const request = await writer
        .rpc('request_postgresql_discovery', {
          t,
          a,
          c: input.connectorId,
          j: input.operationKey,
          e: context.estateId,
          engagement: input.engagementId,
          op: 'enumerate',
          resource: null,
          lim: null,
          cursor: null,
        })
        .abortSignal(c.req.raw.signal);
      if (request.error) throw Error();
      const saved = z
        .object({
          requestId: z.literal(input.operationKey),
          status: z.string(),
          replayed: z.boolean(),
        })
        .strict()
        .parse(request.data);
      if (saved.replayed) return c.json({ data: saved });
      let clean = false;
      try {
        const actual = await deps.controller.run(t, input.operationKey);
        clean = actual.cleanupConfirmed && actual.workerStatus === 'read_completed';
      } catch {
        /* The original reference remains retained and read-backable. */
      }
      const finished = await writer
        .rpc('finish_postgresql_discovery', { t, a, j: input.operationKey, clean })
        .abortSignal(c.req.raw.signal);
      if (finished.error) throw Error();
      const result = z
        .object({
          requestId: z.literal(input.operationKey),
          status: z.enum(['completed', 'unconfirmed', 'failed']),
        })
        .strict()
        .parse(finished.data);
      return c.json({ data: result }, result.status === 'completed' ? 200 : 202);
    } catch {
      return c.json(
        {
          error: {
            code: 'scheduled_read_preflight_unconfirmed',
            message: 'Keep the original check reference and read its status before retrying.',
          },
        },
        503,
      );
    }
  });
  app.get('/monitoring/schedules/:schedule/read-scope/preflight/:operation', async (c) => {
    try {
      const operation = uuid.parse(c.req.param('operation')),
        schedule = uuid.parse(c.req.param('schedule'));
      const t = c.get('tenantId'),
        a = c.get('user').id,
        db = createSupabaseAdmin();
      const context = await db
        .rpc('monitoring_read_scope_context', {
          p_tenant_id: t,
          p_actor_id: a,
          p_session_id: c.get('sessionId'),
          p_schedule_id: schedule,
        })
        .abortSignal(c.req.raw.signal);
      if (context.error) throw Error();
      const scope = monitoringReadScopeContext.parse(context.data);
      if (scope.tenantId !== t || scope.actorId !== a || scope.scheduleId !== schedule)
        throw Error();
      const reply = await db
        .from('postgresql_discovery_requests')
        .select('id,connector_id,engagement_id,status,expires_at,cleanup_confirmed')
        .eq('tenant_id', t)
        .eq('actor_id', a)
        .eq('estate_id', scope.estateId)
        .eq('operation', 'enumerate')
        .eq('id', operation)
        .abortSignal(c.req.raw.signal)
        .maybeSingle();
      if (reply.error) throw Error();
      const result = z
        .object({
          id: z.literal(operation),
          connector_id: uuid,
          engagement_id: uuid,
          status: z.enum([
            'queued',
            'claimed',
            'read_completed',
            'completed',
            'failed',
            'unconfirmed',
          ]),
          expires_at: z.iso.datetime({ offset: true }),
          cleanup_confirmed: z.boolean().nullable(),
        })
        .strict()
        .nullable()
        .parse(reply.data);
      return c.json({ data: result });
    } catch {
      return c.json({ error: { code: 'scheduled_read_preflight_unavailable' } }, 503);
    }
  });
  app.post('/monitoring/schedules/:schedule/read-scope/:step', async (c) => {
    const step = c.req.param('step');
    if (!['challenge', 'verify', 'record', 'recover', 'fence'].includes(step))
      return c.json({ error: { code: 'invalid_step' } }, 400);
    let parsed: z.infer<typeof envelope>;
    try {
      parsed = envelope.parse(parseCatalogueJson(await c.req.text(), 16384));
    } catch {
      return c.json({ error: { code: 'invalid_request' } }, 400);
    }
    const { intent } = parsed,
      t = c.get('tenantId'),
      a = c.get('user').id,
      s = c.get('sessionId');
    const text = encodeMonitoringReadScope(intent),
      sha = createHash('sha256').update(text).digest('hex');
    const args = { p_tenant_id: t, p_actor_id: a, p_session_id: s, p_request_text: text };
    try {
      const schedule = uuid.parse(c.req.param('schedule'));
      // A revocation must refer to a scope belonging to this route's schedule.
      const context = await createSupabaseAdmin()
        .rpc('monitoring_read_scope_context', {
          p_tenant_id: t,
          p_actor_id: a,
          p_session_id: s,
          p_schedule_id: schedule,
        })
        .abortSignal(c.req.raw.signal);
      if (context.error) throw Error();
      const scope = monitoringReadScopeContext.parse(context.data);
      if (scope.tenantId !== t || scope.actorId !== a || scope.scheduleId !== schedule)
        throw Error();
      if (intent.phase === 'authorize') {
        if (intent.request.scheduleId !== schedule) throw Error();
      } else {
        const target = await createSupabaseAdmin()
          .from('monitoring_read_scopes')
          .select('schedule_id')
          .eq('tenant_id', t)
          .eq('id', intent.request.scopeId)
          .abortSignal(c.req.raw.signal)
          .maybeSingle();
        if (target.error || target.data?.schedule_id !== schedule) throw Error();
      }
      const previous = await createSupabaseAdmin()
        .rpc('read_monitoring_read_scope_operation', args)
        .abortSignal(c.req.raw.signal);
      if (previous.error) throw Error();
      const recorded = monitoringReadScopeOperation.parse(previous.data);
      if (recorded.requestSha256 !== sha) throw Error();
      if (step === 'recover' || recorded.recorded || recorded.fenced)
        return c.json({ data: recorded });
      if (step === 'fence') {
        if (parsed.code || parsed.challengeId)
          return c.json({ error: { code: 'invalid_request' } }, 400);
        const fenced = await createHumanActionWriter()
          .rpc('fence_monitoring_read_scope', { ...args, p_phase: intent.phase })
          .abortSignal(c.req.raw.signal);
        if (fenced.error) throw Error();
        const result = monitoringReadScopeOperation.parse(fenced.data);
        if (result.requestSha256 !== sha || (!result.recorded && !result.fenced)) throw Error();
        return c.json({ data: result });
      }
      const preflight = await createSupabaseAdmin()
        .rpc('preflight_monitoring_read_scope', { ...args, p_phase: intent.phase })
        .abortSignal(c.req.raw.signal);
      if (preflight.error) throw Error();
      const proof = z
        .object({
          request: z.unknown(),
          tenantId: z.literal(t),
          actorId: z.literal(a),
          sessionId: z.literal(s),
          phase: z.literal(intent.phase),
          requestSha256: z.literal(sha),
          scopeRevocationAvailable: z.literal(true),
          preflightDiscoveryId: uuid.optional(),
          preflightResultSha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict()
        .parse(preflight.data);
      if (
        encodeMonitoringReadScope(
          monitoringReadScopeIntent.parse({ phase: intent.phase, request: proof.request }),
        ) !== text
      )
        throw Error();
      if (
        intent.phase === 'authorize' &&
        (!proof.preflightDiscoveryId || !proof.preflightResultSha256)
      )
        throw Error();
      const binding = bindingSha256(['axiom.monitoring-read.' + intent.phase, 1, t, a, s, sha]);
      const op = intent.request.operationKey;
      if (step === 'challenge') {
        if (parsed.challengeId || parsed.code)
          return c.json({ error: { code: 'invalid_request' } }, 400);
        const issued = await deps.mfa.issueChallenge({
          tenantId: t,
          userId: a,
          sessionId: s,
          purpose: 'monitoring_read_scope',
          boundResourceRef: op,
          boundPayloadSha256: binding,
          ttlMs: 300000,
        });
        return issued.ok
          ? c.json({ data: { challengeId: issued.challengeId, expiresAt: issued.expiresAt } })
          : c.json({ error: { code: 'scope_mfa_unavailable' } }, 403);
      }
      if (!parsed.challengeId) return c.json({ error: { code: 'scope_mfa_required' } }, 403);
      if (step === 'verify') {
        if (!parsed.code) return c.json({ error: { code: 'scope_mfa_required' } }, 403);
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
          verified.purpose !== 'monitoring_read_scope' ||
          verified.boundResourceRef !== op
        )
          return c.json({ error: { code: 'scope_mfa_refused' } }, 403);
        return c.json({ data: { verified: true, challengeId: parsed.challengeId } });
      }
      if (parsed.code) return c.json({ error: { code: 'invalid_request' } }, 400);
      const consumed = await deps.mfa.consumeChallenge({
        challengeId: parsed.challengeId,
        userId: a,
        tenantId: t,
        sessionId: s,
        purpose: 'monitoring_read_scope',
        boundResourceRef: op,
        boundPayloadSha256: binding,
        consumedFor: op,
      });
      if (!consumed.ok && consumed.reason !== 'challenge_already_consumed')
        return c.json({ error: { code: 'scope_mfa_refused' } }, 403);
      const saved = await createHumanActionWriter()
        .rpc('record_monitoring_read_scope', {
          ...args,
          p_phase: intent.phase,
          p_challenge_id: parsed.challengeId,
        })
        .abortSignal(c.req.raw.signal);
      if (saved.error) throw Error();
      const result = monitoringReadScopeOperation.parse(saved.data);
      if (!result.recorded || result.requestSha256 !== sha) throw Error();
      return c.json({ data: result });
    } catch {
      return c.json(
        {
          error: {
            code: 'scope_operation_unconfirmed',
            message: 'Preserve the exact scope and check its recorded receipt.',
          },
        },
        503,
      );
    }
  });
  return app;
}
