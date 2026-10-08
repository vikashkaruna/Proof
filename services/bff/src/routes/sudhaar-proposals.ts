import { Hono } from 'hono';
import { listFinalizedAssessmentOptions } from '../services/board-reports.js';
import { z } from 'zod';
import { Capability, sudhaarProposalRequestSchema, validateSudhaarProposal } from '@axiom/types';
import { createSupabaseAdmin } from '@axiom/supabase';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
import type { KillSwitchService } from '../services/kill-switch.js';
import {
  invokeGenericAgent,
  type GenericAgentInvocationDeps,
} from '../services/generic-agent-invocation.js';
import {
  readSudhaarSource,
  signSudhaarDispatch,
  PlanningSourceRefused,
} from '../services/sudhaar-proposals.js';
import type { EvidenceDatabase } from '../services/evidence-ingestion.js';
export interface SudhaarProposalDeps extends Omit<
  GenericAgentInvocationDeps,
  'runtimeUrl' | 'runtimeToken' | 'sudhaarDispatch' | 'validateOutput' | 'prepareDispatch'
> {
  runtimeUrl?: string;
  runtimeToken?: string;
  sourceSigningKey?: string;
  db?: EvidenceDatabase;
  killSwitch: Pick<KillSwitchService, 'isActive'>;
}
export function sudhaarProposalRoutes(deps: SudhaarProposalDeps) {
  const app = new Hono<{ Variables: Variables }>();
  app.get('/plans/proposal-assessment-options', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    for (const capability of [Capability.PLAN_CREATE, Capability.AGENT_INVOKE]) {
      const denial = requireCapability(c, capability);
      if (denial) return denial;
    }
    try {
      const db = deps.db ?? createSupabaseAdmin();
      const page = await listFinalizedAssessmentOptions(
        db,
        c.get('tenantId').toLowerCase(),
        { limit: 25, offset: 0 },
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15000)]),
      );
      return c.json({
        assessments: page.assessments,
        total: page.total,
        runtimeAvailable: Boolean(
          deps.runtimeUrl &&
          deps.runtimeToken &&
          deps.sourceSigningKey &&
          Buffer.byteLength(deps.sourceSigningKey) >= 32 &&
          deps.sourceSigningKey !== deps.runtimeToken,
        ),
      });
    } catch {
      return c.json({ error: { code: 'planning_source_unavailable' } }, 503);
    }
  });
  app.get('/plans/proposal-assessment-source/:runId', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    for (const capability of [Capability.PLAN_CREATE, Capability.AGENT_INVOKE]) {
      const denial = requireCapability(c, capability);
      if (denial) return denial;
    }
    const ids = z
      .object({ runId: z.uuid(), engagementId: z.uuid() })
      .strict()
      .safeParse({ runId: c.req.param('runId'), engagementId: c.req.query('engagementId') });
    if (!ids.success || Object.keys(c.req.query()).some((key) => key !== 'engagementId'))
      return c.json({ error: { code: 'validation_failed' } }, 400);
    try {
      const input = await readSudhaarSource(
        deps.db ?? createSupabaseAdmin(),
        c.get('tenantId').toLowerCase(),
        ids.data.engagementId,
        ids.data.runId,
        'Assessment review proposal',
      );
      return c.json({ input });
    } catch {
      return c.json({ error: { code: 'planning_source_unavailable' } }, 503);
    }
  });
  app.post('/plans/proposals', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    for (const cap of [Capability.PLAN_CREATE, Capability.AGENT_INVOKE]) {
      const denial = requireCapability(c, cap);
      if (denial) return denial;
    }
    const actor = c.get('user').id.toLowerCase(),
      expected = z.uuid().safeParse(c.req.header('X-Expected-Actor-Id'));
    if (!expected.success || expected.data.toLowerCase() !== actor)
      return c.json({ error: { code: 'expected_actor_refused' } }, 409);
    try {
      if (await deps.killSwitch.isActive(c.get('tenantId').toLowerCase()))
        return c.json({ error: { code: 'kill_switch_active' } }, 423);
    } catch {
      return c.json({ error: { code: 'planning_authority_unavailable' } }, 503);
    }
    const text = await c.req.text();
    if (Buffer.byteLength(text) > 4096)
      return c.json({ error: { code: 'request_too_large' } }, 413);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return c.json({ error: { code: 'validation_failed' } }, 400);
    }
    const parsed = sudhaarProposalRequestSchema.safeParse(raw),
      key = z.uuid().safeParse(c.req.header('Idempotency-Key'));
    if (!parsed.success || !key.success || key.data.toLowerCase() !== parsed.data.operationKey)
      return c.json({ error: { code: 'validation_failed' } }, 400);
    if (
      !deps.runtimeUrl ||
      !deps.runtimeToken ||
      !deps.sourceSigningKey ||
      Buffer.byteLength(deps.sourceSigningKey) < 32 ||
      deps.sourceSigningKey === deps.runtimeToken
    )
      return c.json({ error: { code: 'planning_runtime_unavailable' } }, 503);
    const request = parsed.data,
      tenantId = c.get('tenantId').toLowerCase();
    try {
      const input = await readSudhaarSource(
        deps.db ?? createSupabaseAdmin(),
        tenantId,
        request.engagementId,
        request.assessmentRunId,
        request.title,
      );
      const outcome = await invokeGenericAgent(
        {
          agent: 'sudhaar',
          tenantId,
          actorId: actor,
          engagementId: request.engagementId,
          correlationId: request.operationKey,
          input,
        },
        {
          ...deps,
          runtimeUrl: deps.runtimeUrl,
          runtimeToken: deps.runtimeToken,
          sudhaarDispatch: (ctx) =>
            signSudhaarDispatch(ctx, deps.sourceSigningKey!, deps.runtimeToken!),
          validateOutput: (output) => {
            validateSudhaarProposal(output, input);
          },
        },
      );
      if (outcome.status !== 200) return c.json(outcome.body, outcome.status);
      return c.json(
        {
          data: validateSudhaarProposal(outcome.body.output, input),
          invocation: {
            runId: outcome.run.runId,
            correlationId: request.operationKey,
            requestHash: outcome.run.requestHash,
            responseHash: outcome.run.responseHash,
          },
        },
        200,
      );
    } catch (error) {
      const code =
        error instanceof PlanningSourceRefused ? error.code : 'planning_proposal_unavailable';
      return c.json({ error: { code } }, code === 'planning_source_conflict' ? 409 : 503);
    }
  });
  return app;
}
