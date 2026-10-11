import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Capability, UserRole } from '@axiom/types';
import type { Variables } from '../types.js';
import type { MfaService } from '../services/mfa.js';
import type { KillSwitchService } from '../services/kill-switch.js';
import { requireCapability } from '../middleware/authorize.js';
import { boundedJsonBody } from '../middleware/evidence-body-limit.js';
import {
  invokeGenericAgent,
  type GenericAgentInvocationDeps,
} from '../services/generic-agent-invocation.js';
import {
  readRetainedSanketCapture,
  recoverRetainedSanketOutput,
  retainedSanketInput,
  RetainedSanketRefused,
  validateRetainedSanketOutput,
} from '../services/retained-sanket-source.js';
import { retainedSanketTransport } from '../services/retained-sanket-transport.js';

const id = z.uuid().refine((value) => value.length === 36 && value === value.toLowerCase());
const digest = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);
const selectionSchema = z.strictObject({ engagementId: id, checkId: id, sourceDigest: digest });
const requestSchema = selectionSchema.extend({
  operationKey: id,
  confirmSourceReview: z.literal(true),
});
type ContextWithActor = Context<{ Variables: Variables }>;
type Deps = Omit<
  GenericAgentInvocationDeps,
  | 'retainedSanket'
  | 'reviewedWorkflow'
  | 'stagedEvidence'
  | 'prepareDispatch'
  | 'validateOutput'
  | 'sudhaarDispatch'
  | 'settleSudhaarSuccess'
  | 'runtimeUrl'
  | 'runtimeToken'
> & {
  enabled: boolean;
  runtimeUrl?: string;
  runtimeToken?: string;
  mfa: Pick<MfaService, 'requiresLoginMfa' | 'isEnrolled' | 'sessionAttestation'>;
  killSwitch: Pick<KillSwitchService, 'isActive'>;
};

/** Unmounted. Parent mounts behind normal Auth/tenant middleware and exact
 * durable-idempotency/ingress guards. No wildcard middleware is added here.
 */
export function retainedSanketRoutes(deps: Deps) {
  const app = new Hono<{ Variables: Variables }>();
  async function authority(c: ContextWithActor) {
    c.header('Cache-Control', 'private, no-store');
    const actor = id.safeParse(c.get('user')?.id),
      tenant = id.safeParse(c.get('tenantId'));
    if (!actor.success || !tenant.success || !c.get('role'))
      return c.json({ error: { code: 'unauthorized' } }, 401);
    try {
      if (await deps.mfa.requiresLoginMfa({ tenantId: tenant.data, role: c.get('role') })) {
        if (!(await deps.mfa.isEnrolled(actor.data)))
          return c.json({ error: { code: 'mfa_enrolment_required' } }, 403);
        const sessionId = c.get('sessionId');
        if (!sessionId || !(await deps.mfa.sessionAttestation({ userId: actor.data, sessionId })))
          return c.json({ error: { code: 'mfa_verification_required' } }, 401);
      }
      const denied = requireCapability(c, Capability.AGENT_INVOKE);
      if (denied) return denied;
      if (![UserRole.FOUNDER, UserRole.AXIOM_ANALYST].some((role) => role === c.get('role')))
        return c.json({ error: { code: 'role_forbidden' } }, 403);
      const expected = id.safeParse(c.req.header('X-Expected-Actor-Id'));
      if (!expected.success) return c.json({ error: { code: 'expected_actor_required' } }, 400);
      if (expected.data !== actor.data)
        return c.json({ error: { code: 'sanket_actor_changed' } }, 409);
      if (!deps.enabled) return c.json({ error: { code: 'sanket_unavailable' } }, 503);
      if (await deps.killSwitch.isActive(tenant.data))
        return c.json({ error: { code: 'kill_switch_active' } }, 423);
    } catch {
      return c.json({ error: { code: 'sanket_authority_unavailable' } }, 503);
    }
    return null;
  }
  function refusal(c: ContextWithActor, error: unknown) {
    return error instanceof RetainedSanketRefused
      ? c.json({ error: { code: error.code } }, 409)
      : c.json({ error: { code: 'sanket_output_uncertain' } }, 503);
  }
  function singleQuery(c: ContextWithActor) {
    return !Object.values(c.req.queries()).some((values) => values.length !== 1);
  }
  async function load(c: ContextWithActor, selected: z.infer<typeof selectionSchema>, key: string) {
    const loaded = await readRetainedSanketCapture(
      c.get('tenantId'),
      c.get('user').id,
      selected.engagementId,
      selected.checkId,
      deps.writerFactory,
    );
    if (loaded.sourceHash !== selected.sourceDigest)
      throw new RetainedSanketRefused('sanket_source_conflict');
    return {
      loaded,
      input: retainedSanketInput(c.get('tenantId'), selected.engagementId, key, loaded.capture),
    };
  }
  app.get('/retained-public-observations/source', async (c) => {
    const denied = await authority(c);
    if (denied) return denied;
    const selected = z.strictObject({ engagementId: id, checkId: id }).safeParse(c.req.query());
    if (!selected.success || !singleQuery(c))
      return c.json({ error: { code: 'invalid_sanket_request' } }, 400);
    try {
      const loaded = await readRetainedSanketCapture(
        c.get('tenantId'),
        c.get('user').id,
        selected.data.engagementId,
        selected.data.checkId,
        deps.writerFactory,
      );
      // The opaque PG result witness is exclusively service-side. The browser
      // reviews only the exact bounded public title/headings and original receipt.
      return c.json({ source: loaded.capture, sourceDigest: loaded.sourceHash });
    } catch (error) {
      return refusal(c, error);
    }
  });
  app.get('/retained-public-observations/runs/:operationKey', async (c) => {
    const denied = await authority(c);
    if (denied) return denied;
    const selected = selectionSchema.safeParse(c.req.query()),
      key = id.safeParse(c.req.param('operationKey'));
    if (!selected.success || !key.success || !singleQuery(c))
      return c.json({ error: { code: 'invalid_sanket_request' } }, 400);
    try {
      const { input } = await load(c, selected.data, key.data);
      const recovered = await recoverRetainedSanketOutput(
        c.get('tenantId'),
        c.get('user').id,
        input,
        deps.writerFactory,
      );
      return recovered ? c.json(recovered) : c.json({ missing: true }, 404);
    } catch (error) {
      return refusal(c, error);
    }
  });
  app.post(
    '/retained-public-observations/runs',
    async (c, next) => {
      const denied = await authority(c);
      return denied ?? next();
    },
    boundedJsonBody(4096),
    async (c) => {
      const request = requestSchema.safeParse(await c.req.json().catch(() => null)),
        key = id.safeParse(c.req.header('Idempotency-Key'));
      if (
        !request.success ||
        !key.success ||
        key.data !== request.data.operationKey ||
        new URL(c.req.url).search
      )
        return c.json({ error: { code: 'invalid_sanket_request' } }, 400);
      try {
        const { loaded, input } = await load(c, request.data, key.data);
        const recovered = await recoverRetainedSanketOutput(
          c.get('tenantId'),
          c.get('user').id,
          input,
          deps.writerFactory,
        );
        if (recovered) return c.json(recovered);
        if (!deps.runtimeUrl || !deps.runtimeToken)
          return c.json({ error: { code: 'sanket_runtime_unavailable' } }, 503);
        const outcome = await invokeGenericAgent(
          {
            agent: 'sanket',
            tenantId: c.get('tenantId'),
            actorId: c.get('user').id,
            engagementId: input.engagement_id,
            correlationId: key.data,
            input,
          },
          {
            ...deps,
            runtimeUrl: deps.runtimeUrl,
            runtimeToken: deps.runtimeToken,
            retainedSanket: retainedSanketTransport(
              c.get('user').id,
              input,
              loaded,
              deps.writerFactory,
            ),
            validateOutput: async (raw) => {
              await validateRetainedSanketOutput(input, raw);
            },
          },
        );
        if (outcome.status !== 200) return c.json(outcome.body, outcome.status);
        const recorded = await recoverRetainedSanketOutput(
          c.get('tenantId'),
          c.get('user').id,
          input,
          deps.writerFactory,
        );
        if (
          !recorded ||
          recorded.invocation.runId !== outcome.run.runId ||
          recorded.invocation.requestHash !== outcome.run.requestHash ||
          recorded.invocation.responseHash !== outcome.run.responseHash
        )
          throw new RetainedSanketRefused('sanket_output_uncertain');
        await validateRetainedSanketOutput(input, recorded.data);
        return c.json(recorded, 201);
      } catch (error) {
        return refusal(c, error);
      }
    },
  );
  return app;
}
