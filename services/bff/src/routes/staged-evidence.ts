/** Dedicated human Saakshi evidence routes. Parent composition supplies authenticated middleware/config. */
import { Hono } from 'hono';
import { z } from 'zod';
import { Capability } from '@axiom/types';
import type { Variables } from '../types.js';
import { requireCapability } from '../middleware/authorize.js';
import { boundedJsonBody, EVIDENCE_HTTP_MAX_BYTES } from '../middleware/evidence-body-limit.js';
import type { KillSwitchService } from '../services/kill-switch.js';
import type { MfaService } from '../services/mfa.js';
import { assertConfiguredHumanRetentionApproval } from '../services/saakshi-human-retention-approval.js';
import {
  prepareStagedEvidence,
  invokePreparedStagedEvidence,
  recoverStagedEvidence,
  readUnconfirmedStagedEvidence,
  acceptedStagedEvidenceResult,
  stagedEvidenceHumanRequest,
  type EvidenceControllerRpc,
} from '../services/saakshi-evidence-controller.js';

export interface StagedEvidenceRoutesDeps {
  rpc: EvidenceControllerRpc;
  killSwitch: Pick<KillSwitchService, 'isActive'>;
  mfa: Pick<MfaService, 'sessionAttestation'>;
  configuration?: Parameters<typeof prepareStagedEvidence>[4];
  invocation?: Parameters<typeof invokePreparedStagedEvidence>[2];
}
const recoveryQuery = z.object({ bodyHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export function stagedEvidenceRoutes(deps: StagedEvidenceRoutesDeps) {
  const app = new Hono<{ Variables: Variables }>();
  const available = () => {
    if (!deps.configuration || !deps.invocation) return false;
    try {
      const { key, retention } = deps.configuration;
      assertConfiguredHumanRetentionApproval(
        { ...retention, acknowledgesImmutableRetention: true },
        retention,
      );
      return (
        /^[a-zA-Z0-9_-]{1,80}$/.test(key.id) &&
        key.key.length === 32 &&
        !key.otherKeys.some((other) => key.key.equals(other)) &&
        deps.invocation.runtimeToken.length >= 32 &&
        !key.key.equals(Buffer.from(deps.invocation.runtimeToken)) &&
        ['http:', 'https:'].includes(new URL(deps.invocation.runtimeUrl).protocol)
      );
    } catch {
      return false;
    }
  };
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    for (const capability of [Capability.EVIDENCE_RECORD, Capability.AGENT_INVOKE]) {
      const denied = requireCapability(c, capability);
      if (denied) return denied;
    }
    return next();
  });
  app.get('/evidence/staged-ingestion-options', (c) => {
    if (Object.keys(c.req.query()).length)
      return c.json({ error: { code: 'validation_failed' } }, 400);
    const enabled = available();
    return c.json({ enabled, retention: enabled ? deps.configuration!.retention : null });
  });
  app.use('/evidence/staged-ingestions*', async (c, next) => {
    const actor = c.get('user').id.toLowerCase();
    const expected = z.uuid().safeParse(c.req.header('X-Expected-Actor-Id'));
    if (!expected.success || expected.data.toLowerCase() !== actor)
      return c.json({ error: { code: 'expected_actor_refused' } }, 409);
    try {
      if (!(await deps.mfa.sessionAttestation({ userId: actor, sessionId: c.get('sessionId') })))
        return c.json({ error: { code: 'mfa_verification_required' } }, 403);
      if (await deps.killSwitch.isActive(c.get('tenantId').toLowerCase()))
        return c.json({ error: { code: 'kill_switch_active' } }, 423);
    } catch {
      return c.json({ error: { code: 'evidence_authority_unavailable' } }, 503);
    }
    return next();
  });
  app.use('/evidence/staged-ingestions', boundedJsonBody(EVIDENCE_HTTP_MAX_BYTES));
  app.post('/evidence/staged-ingestions', async (c) => {
    if (!available() || !deps.configuration || !deps.invocation)
      return c.json({ error: { code: 'staged_evidence_unavailable' } }, 503);
    const body = await c.req.json().catch(() => null);
    const request = stagedEvidenceHumanRequest.safeParse(body);
    const key = z.uuid().safeParse(c.req.header('Idempotency-Key'));
    if (
      !request.success ||
      !key.success ||
      key.data !== request.data.operationKey ||
      Object.keys(c.req.query()).length ||
      c.req.header('Content-Encoding')
    )
      return c.json({ error: { code: 'validation_failed' } }, 400);
    try {
      const tenant = c.get('tenantId').toLowerCase(),
        actor = c.get('user').id.toLowerCase();
      const prepared = await prepareStagedEvidence(
        deps.rpc,
        tenant,
        actor,
        body,
        deps.configuration,
      );
      if (prepared.replayed) {
        // A retained intent is not authority to redispatch or repeat PUT. Read only a proven completion.
        const accepted = await recoverStagedEvidence(
          deps.rpc,
          tenant,
          actor,
          key.data,
          prepared.bodyHash,
        );
        return c.json(acceptedStagedEvidenceResult(accepted));
      }
      const result = await invokePreparedStagedEvidence(deps.rpc, prepared, deps.invocation);
      return c.json(result.body, result.status);
    } catch {
      return c.json({ error: { code: 'staged_evidence_unconfirmed' } }, 503);
    }
  });
  app.get('/evidence/staged-ingestions/:operationKey/result', async (c) => {
    const key = z.uuid().safeParse(c.req.param('operationKey'));
    const query = recoveryQuery.safeParse(c.req.query());
    if (!key.success || !query.success)
      return c.json({ error: { code: 'validation_failed' } }, 400);
    try {
      const accepted = await recoverStagedEvidence(
        deps.rpc,
        c.get('tenantId').toLowerCase(),
        c.get('user').id.toLowerCase(),
        key.data,
        query.data.bodyHash,
      );
      return c.json(acceptedStagedEvidenceResult(accepted));
    } catch {
      return c.json({ error: { code: 'staged_evidence_unconfirmed' } }, 503);
    }
  });
  app.get('/evidence/staged-ingestions/:operationKey/status', async (c) => {
    const key = z.uuid().safeParse(c.req.param('operationKey'));
    const query = recoveryQuery.safeParse(c.req.query());
    if (!key.success || !query.success)
      return c.json({ error: { code: 'validation_failed' } }, 400);
    try {
      return c.json(
        await readUnconfirmedStagedEvidence(
          deps.rpc,
          c.get('tenantId').toLowerCase(),
          c.get('user').id.toLowerCase(),
          key.data,
          query.data.bodyHash,
        ),
      );
    } catch {
      return c.json({ error: { code: 'staged_evidence_unconfirmed' } }, 503);
    }
  });
  app.use('/evidence/staged-ingestions/:operationKey/expire', boundedJsonBody(4096));
  app.post('/evidence/staged-ingestions/:operationKey/expire', async (c) => {
    const key = z.uuid().safeParse(c.req.param('operationKey'));
    const header = z.uuid().safeParse(c.req.header('Idempotency-Key'));
    const request = z
      .object({
        bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
        acknowledgeUnconfirmedPreservation: z.literal(true),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (
      !key.success ||
      !header.success ||
      header.data !== key.data ||
      !request.success ||
      Object.keys(c.req.query()).length ||
      c.req.header('Content-Encoding')
    )
      return c.json({ error: { code: 'validation_failed' } }, 400);
    try {
      return c.json(
        await readUnconfirmedStagedEvidence(
          deps.rpc,
          c.get('tenantId').toLowerCase(),
          c.get('user').id.toLowerCase(),
          key.data,
          request.data.bodyHash,
          true,
        ),
      );
    } catch {
      return c.json({ error: { code: 'staged_evidence_unconfirmed' } }, 503);
    }
  });
  return app;
}
