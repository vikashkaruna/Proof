import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { canonicalJson, sha256 } from '@axiom/ledger';
import { createHumanActionWriter } from '@axiom/supabase';
import {
  Capability,
  createPublicAgentRunSchema,
  drishtiPublicInputSchema,
  drishtiPublicResultSchema,
  publicAgentObservationSchema,
  vibhaagPublicInputSchema,
  vibhaagPublicResultSchema,
} from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import { invokeGenericAgent } from '../services/generic-agent-invocation.js';
import type { RealtimeService } from '../services/realtime.js';
import type { Variables } from '../types.js';

type Ctx = Context<{ Variables: Variables }>;
const uuid = z.uuid().transform((value) => value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receipt = z.string().regex(/^[1-9][0-9]{0,18}$/);
const dispatchSchema = z
  .object({ dispatch_id: uuid, created: z.boolean(), replayed: z.boolean() })
  .strict()
  .refine((value) => value.created !== value.replayed);
const recordedSchema = z
  .object({
    observation_id: uuid,
    dispatch_id: uuid,
    created: z.boolean(),
    replayed: z.boolean(),
    output_sha256: digest,
    completion_receipt: receipt,
  })
  .strict()
  .refine((value) => value.created !== value.replayed);
const inputEnvelope = z
  .object({ input: z.unknown(), binding_id: uuid, observation_id: uuid.optional() })
  .strict();
const refusalStatus = {
  forbidden: 403,
  context_refused: 404,
  source_refused: 404,
  observation_refused: 404,
  invalid_record: 400,
  input_refused: 409,
} as const;

function refuse(c: Ctx, value: unknown) {
  const parsed = z
    .object({
      error: z.enum(
        Object.keys(refusalStatus) as [
          keyof typeof refusalStatus,
          ...Array<keyof typeof refusalStatus>,
        ],
      ),
    })
    .strict()
    .safeParse(value);
  return parsed.success
    ? c.json({ error: { code: parsed.data.error } }, refusalStatus[parsed.data.error])
    : c.json({ error: { code: 'public_source_agent_unavailable' } }, 503);
}

export function publicSourceAgentRoutes(deps: {
  runtimeUrl: string | undefined;
  runtimeToken: string | undefined;
  realtime: Pick<RealtimeService, 'broadcast'>;
}) {
  const app = new Hono<{ Variables: Variables }>();
  app.post('/public-source-bindings/:bindingId/agents/:name/run', async (c) => {
    const denied = requireCapability(c, Capability.AGENT_INVOKE);
    if (denied) return denied;
    c.header('Cache-Control', 'private, no-store');
    const agent = c.req.param('name').toLowerCase();
    const binding = uuid.safeParse(c.req.param('bindingId'));
    const body = createPublicAgentRunSchema.safeParse(await c.req.json().catch(() => null));
    if (
      !binding.success ||
      !body.success ||
      !c.get('idempotencyKey') ||
      !['drishti', 'vibhaag'].includes(agent) ||
      (agent === 'drishti'
        ? body.data.observationId !== undefined
        : body.data.observationId === undefined)
    )
      return c.json({ error: { code: 'invalid_request' } }, 400);
    if (!deps.runtimeUrl || !deps.runtimeToken) return refuse(c, null);
    const tenant = c.get('tenantId').toLowerCase();
    const actor = c.get('user').id.toLowerCase();
    // A failed response must not permit the same human request to dispatch again.
    const hex = await sha256(
      canonicalJson({
        version: 1,
        operation: 'public_source_agent_run',
        tenant,
        actor,
        key: c.get('idempotencyKey'),
      }),
    );
    const correlationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    try {
      const writer = createHumanActionWriter();
      const { data, error } = await writer.rpc('get_public_source_agent_input', {
        p_tenant_id: tenant,
        p_actor_id: actor,
        p_engagement_id: body.data.engagementId,
        p_binding_id: binding.data,
        p_agent: agent,
        p_observation_id: body.data.observationId ?? null,
      });
      if (error) return refuse(c, null);
      const loaded = inputEnvelope.safeParse(data);
      if (!loaded.success) return refuse(c, data);
      const parsed = (
        agent === 'drishti' ? drishtiPublicInputSchema : vibhaagPublicInputSchema
      ).safeParse(loaded.data.input);
      if (!parsed.success) return refuse(c, null);
      const input = parsed.data;
      const source = 'source' in input ? input.source.binding : input.source_binding;
      if (
        loaded.data.binding_id !== binding.data ||
        loaded.data.observation_id !== body.data.observationId ||
        input.tenant_id !== tenant ||
        input.engagement_id !== body.data.engagementId
      )
        return refuse(c, null);
      if (source.projection_sha256 !== body.data.expectedProjectionSha256)
        return c.json({ error: { code: 'stale_source' } }, 409);
      let dispatchId: string | undefined;
      const outcome = await invokeGenericAgent(
        {
          agent,
          tenantId: tenant,
          actorId: actor,
          engagementId: body.data.engagementId,
          correlationId,
          input,
        },
        {
          runtimeUrl: deps.runtimeUrl,
          runtimeToken: deps.runtimeToken,
          realtime: deps.realtime,
          writerFactory: () => writer,
          prepareDispatch: async (context) => {
            const linked = await writer.rpc('record_public_source_dispatch', {
              p_tenant_id: tenant,
              p_actor_id: actor,
              p_engagement_id: body.data.engagementId,
              p_binding_id: binding.data,
              p_agent: agent,
              p_observation_id: body.data.observationId ?? null,
              p_run_id: context.runId,
              p_input: JSON.parse(context.canonicalInput),
              p_input_utf8: context.canonicalInput,
            });
            const confirmed = dispatchSchema.safeParse(linked.data);
            if (linked.error || !confirmed.success) throw new Error('source_dispatch_unconfirmed');
            dispatchId = confirmed.data.dispatch_id;
            return { kind: 'public_source' };
          },
        },
      );
      if (outcome.status !== 200) return c.json(outcome.body, outcome.status);
      const paired = (
        agent === 'drishti' ? drishtiPublicResultSchema : vibhaagPublicResultSchema
      ).safeParse({ input, output: outcome.body.output });
      if (!paired.success || dispatchId === undefined)
        return c.json(
          {
            error: {
              code: 'public_source_output_refused',
              runId: outcome.run.runId,
            },
          },
          502,
        );
      const output = outcome.body.output;
      const outputUtf8 = canonicalJson(output);
      const outputHash = await sha256(outputUtf8);
      let saved: Awaited<ReturnType<typeof writer.rpc>>;
      try {
        saved = await writer.rpc('record_public_source_observation', {
          p_tenant_id: tenant,
          p_actor_id: actor,
          p_run_id: outcome.run.runId,
          p_output: output,
          p_output_utf8: outputUtf8,
        });
      } catch {
        return c.json(
          {
            error: {
              code: 'public_source_observation_unconfirmed',
              runId: outcome.run.runId,
            },
          },
          503,
        );
      }
      const recorded = recordedSchema.safeParse(saved.data);
      if (
        saved.error ||
        !recorded.success ||
        recorded.data.dispatch_id !== dispatchId ||
        recorded.data.output_sha256 !== outputHash ||
        outputHash !== outcome.run.responseHash ||
        recorded.data.completion_receipt !== outcome.body.ledger_entry_ids[1]
      )
        return c.json(
          {
            error: {
              code: 'public_source_observation_unconfirmed',
              runId: outcome.run.runId,
            },
          },
          503,
        );
      const observation = publicAgentObservationSchema.safeParse({
        observation_id: recorded.data.observation_id,
        dispatch_id: recorded.data.dispatch_id,
        output_sha256: recorded.data.output_sha256,
        completion_receipt: recorded.data.completion_receipt,
        binding_id: binding.data,
        run_id: outcome.run.runId,
        agent,
        output,
      });
      if (!observation.success) return refuse(c, null);
      return c.json({ data: observation.data }, recorded.data.created ? 201 : 200);
    } catch {
      return refuse(c, null);
    }
  });

  app.get('/public-source-observations/:observationId', async (c) => {
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    c.header('Cache-Control', 'private, no-store');
    const id = uuid.safeParse(c.req.param('observationId'));
    const engagement = uuid.safeParse(c.req.query('engagementId'));
    if (!id.success || !engagement.success)
      return c.json({ error: { code: 'invalid_request' } }, 400);
    try {
      const { data, error } = await createHumanActionWriter().rpc('get_public_source_observation', {
        p_tenant_id: c.get('tenantId'),
        p_actor_id: c.get('user').id,
        p_engagement_id: engagement.data,
        p_observation_id: id.data,
      });
      if (error) return refuse(c, null);
      const parsed = publicAgentObservationSchema.safeParse(data);
      if (!parsed.success) return refuse(c, data);
      const source =
        parsed.data.agent === 'drishti'
          ? parsed.data.output.observation.binding
          : parsed.data.output.source_binding;
      if (
        parsed.data.observation_id !== id.data ||
        source.tenant_id !== c.get('tenantId').toLowerCase() ||
        source.engagement_id !== engagement.data ||
        (await sha256(canonicalJson(parsed.data.output))) !== parsed.data.output_sha256
      )
        return refuse(c, null);
      return c.json({ data: parsed.data });
    } catch {
      return refuse(c, null);
    }
  });
  return app;
}
