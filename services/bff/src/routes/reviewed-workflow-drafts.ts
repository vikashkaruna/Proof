import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { canonicalJson, sha256 } from '@axiom/ledger';
import { createHumanActionWriter } from '@axiom/supabase';
import {
  Capability,
  reviewedWorkflowRequestSchema,
  reviewedWorkflowAdoptionRequestSchema,
  reviewedWorkflowSelectionSchema,
  reviewedWorkflowAcknowledgementProofSchema,
  validateReviewedWorkflowOutput,
} from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
import type { KillSwitchService } from '../services/kill-switch.js';
import {
  invokeGenericAgent,
  type GenericAgentInvocationDeps,
} from '../services/generic-agent-invocation.js';
import {
  readReviewedWorkflowSource,
  recoverReviewedWorkflowOutput,
  reviewedWorkflowTransport,
  ReviewedWorkflowRefused,
} from '../services/reviewed-workflow-output.js';

type Ctx = Context<{ Variables: Variables }>;
const uuid = z.uuid().transform((value) => value.toLowerCase());
const receipt = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
type Deps = Omit<
  GenericAgentInvocationDeps,
  | 'reviewedWorkflow'
  | 'validateOutput'
  | 'prepareDispatch'
  | 'settleSudhaarSuccess'
  | 'sudhaarDispatch'
  | 'runtimeUrl'
  | 'runtimeToken'
> & {
  runtimeUrl?: string;
  runtimeToken?: string;
  killSwitch: Pick<KillSwitchService, 'isActive'>;
};
export function reviewedWorkflowDraftRoutes(deps: Deps) {
  const app = new Hono<{ Variables: Variables }>();
  async function authority(c: Ctx) {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.AGENT_INVOKE);
    if (denied) return denied;
    const expected = uuid.safeParse(c.req.header('X-Expected-Actor-Id'));
    if (!expected.success || expected.data !== c.get('user').id.toLowerCase())
      return c.json({ error: { code: 'expected_actor_refused' } }, 409);
    try {
      if (await deps.killSwitch.isActive(c.get('tenantId').toLowerCase()))
        return c.json({ error: { code: 'kill_switch_active' } }, 423);
    } catch {
      return c.json({ error: { code: 'reviewed_authority_unavailable' } }, 503);
    }
    return null;
  }
  function refusal(c: Ctx, error: unknown) {
    return error instanceof ReviewedWorkflowRefused
      ? c.json({ error: { code: error.code } }, 409)
      : c.json({ error: { code: 'reviewed_workflow_unavailable' } }, 503);
  }
  async function body(c: Ctx) {
    const text = await c.req.text();
    if (Buffer.byteLength(text) > 16384) throw new Error('request_too_large');
    return JSON.parse(text) as unknown;
  }
  const querySchema = z
    .object({
      engagementId: uuid,
      recordIds: z.string().min(1).max(740),
      sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict();
  function selection(c: Ctx) {
    if (Object.values(c.req.queries()).some((values) => values.length !== 1)) return null;
    const raw = querySchema.safeParse(c.req.query());
    if (!raw.success) return null;
    const parsed = reviewedWorkflowSelectionSchema.safeParse({
      ...raw.data,
      recordIds: raw.data.recordIds.split(','),
    });
    return parsed.success ? parsed.data : null;
  }
  async function source(c: Ctx, selected: z.infer<typeof reviewedWorkflowSelectionSchema>) {
    const input = await readReviewedWorkflowSource(
      c.get('tenantId').toLowerCase(),
      c.get('user').id.toLowerCase(),
      selected.engagementId,
      selected.recordIds,
      deps.writerFactory,
    );
    if (input.source_records_sha256 !== selected.sourceDigest)
      throw new ReviewedWorkflowRefused('reviewed_output_conflict');
    return input;
  }
  app.get('/reviewed-workflows/source', async (c) => {
    const denied = await authority(c);
    if (denied) return denied;
    const query = z
      .object({ engagementId: uuid, recordIds: z.string().min(1).max(740) })
      .strict()
      .safeParse(c.req.query());
    if (!query.success || Object.values(c.req.queries()).some((values) => values.length !== 1))
      return c.json({ error: { code: 'invalid_request' } }, 400);
    const ids = z
      .array(uuid)
      .min(1)
      .max(20)
      .refine((values) => new Set(values).size === values.length)
      .safeParse(query.data.recordIds.split(','));
    if (!ids.success) return c.json({ error: { code: 'invalid_request' } }, 400);
    try {
      return c.json({
        input: await readReviewedWorkflowSource(
          c.get('tenantId').toLowerCase(),
          c.get('user').id.toLowerCase(),
          query.data.engagementId,
          ids.data,
          deps.writerFactory,
        ),
      });
    } catch (error) {
      return refusal(c, error);
    }
  });
  app.get('/reviewed-workflows/runs/:operationKey', async (c) => {
    const denied = await authority(c);
    if (denied) return denied;
    const selected = selection(c),
      key = uuid.safeParse(c.req.param('operationKey'));
    if (!selected || !key.success) return c.json({ error: { code: 'invalid_request' } }, 400);
    try {
      const input = await source(c, selected);
      const recovered = await recoverReviewedWorkflowOutput(
        c.get('tenantId').toLowerCase(),
        c.get('user').id.toLowerCase(),
        key.data,
        input,
        deps.writerFactory,
      );
      return recovered ? c.json(recovered) : c.json({ missing: true }, 404);
    } catch (error) {
      return refusal(c, error);
    }
  });
  app.post('/reviewed-workflows/runs', async (c) => {
    const denied = await authority(c);
    if (denied) return denied;
    const key = uuid.safeParse(c.req.header('Idempotency-Key'));
    let raw: unknown;
    try {
      raw = await body(c);
    } catch {
      return c.json({ error: { code: 'invalid_request' } }, 400);
    }
    const request = reviewedWorkflowRequestSchema.safeParse(raw);
    if (!request.success || !key.success || key.data !== request.data.operationKey)
      return c.json({ error: { code: 'invalid_request' } }, 400);
    const tenantId = c.get('tenantId').toLowerCase(),
      actorId = c.get('user').id.toLowerCase();
    try {
      const input = await source(c, request.data);
      const recovered = await recoverReviewedWorkflowOutput(
        tenantId,
        actorId,
        key.data,
        input,
        deps.writerFactory,
      );
      if (recovered) return c.json(recovered);
      if (!deps.runtimeUrl || !deps.runtimeToken)
        return c.json({ error: { code: 'reviewed_runtime_unavailable' } }, 503);
      const outcome = await invokeGenericAgent(
        {
          agent: 'vibhaag',
          tenantId,
          actorId,
          engagementId: input.engagement_id,
          correlationId: key.data,
          input,
        },
        {
          ...deps,
          runtimeUrl: deps.runtimeUrl,
          runtimeToken: deps.runtimeToken,
          reviewedWorkflow: reviewedWorkflowTransport(input, deps.writerFactory),
          validateOutput: (output) => {
            validateReviewedWorkflowOutput(input, output);
          },
        },
      );
      if (outcome.status !== 200) return c.json(outcome.body, outcome.status);
      const recorded = await recoverReviewedWorkflowOutput(
        tenantId,
        actorId,
        key.data,
        input,
        deps.writerFactory,
      );
      if (
        !recorded ||
        recorded.invocation.runId !== outcome.run.runId ||
        recorded.invocation.requestHash !== outcome.run.requestHash ||
        recorded.invocation.responseHash !== outcome.run.responseHash
      )
        throw new ReviewedWorkflowRefused('reviewed_output_uncertain');
      return c.json(recorded, 201);
    } catch (error) {
      return refusal(c, error);
    }
  });
  app.post('/reviewed-workflows/acknowledgements', async (c) => {
    const denied = await authority(c);
    if (denied) return denied;
    let raw: unknown;
    try {
      raw = await body(c);
    } catch {
      return c.json({ error: { code: 'invalid_request' } }, 400);
    }
    const request = reviewedWorkflowAdoptionRequestSchema.safeParse(raw),
      key = uuid.safeParse(c.req.header('Idempotency-Key'));
    if (!request.success || !key.success || key.data !== request.data.operationKey)
      return c.json({ error: { code: 'invalid_request' } }, 400);
    if (request.data.acknowledgement.policyIndex !== null) {
      const denied = requireCapability(c, Capability.ESTATE_MANAGE);
      if (denied) return denied;
    }
    try {
      const input = await source(c, request.data);
      const recovered = await recoverReviewedWorkflowOutput(
        c.get('tenantId').toLowerCase(),
        c.get('user').id.toLowerCase(),
        request.data.originalOperationKey,
        input,
        deps.writerFactory,
      );
      if (
        !recovered ||
        recovered.invocation.runId !== request.data.acknowledgement.runId ||
        recovered.invocation.responseHash !== request.data.acknowledgement.outputHash
      )
        throw new ReviewedWorkflowRefused('reviewed_output_conflict');
      const { data, error } = await (deps.writerFactory ?? createHumanActionWriter)()
        .rpc(
          request.data.readOnly
            ? 'recover_reviewed_workflow_acknowledgement'
            : 'acknowledge_reviewed_workflow_output',
          {
            p_tenant_id: c.get('tenantId').toLowerCase(),
            p_actor_id: c.get('user').id.toLowerCase(),
            p_engagement_id: input.engagement_id,
            p_original_operation_key: request.data.originalOperationKey,
            p_input_text: canonicalJson(input),
            p_operation_key: key.data,
            p_body_text: canonicalJson(request.data.acknowledgement),
          },
        )
        .abortSignal(AbortSignal.timeout(10000));
      if (error) throw new ReviewedWorkflowRefused('reviewed_output_uncertain');
      if (
        request.data.readOnly &&
        z
          .object({ missing: z.literal(true) })
          .strict()
          .safeParse(data).success
      )
        return c.json({ missing: true }, 404);
      const result = z
        .object({
          acknowledgement_id: uuid,
          receipt_id: receipt,
          policy_draft_id: uuid.nullable(),
          replayed: z.boolean(),
          manifest: reviewedWorkflowAcknowledgementProofSchema,
        })
        .strict()
        .safeParse(data);
      if (
        !result.success ||
        (result.data.policy_draft_id === null) !==
          (request.data.acknowledgement.policyIndex === null)
      )
        throw new ReviewedWorkflowRefused('reviewed_output_conflict');
      const proof = result.data.manifest;
      if (
        proof.tenantId !== c.get('tenantId').toLowerCase() ||
        proof.actorId !== c.get('user').id.toLowerCase() ||
        proof.operationKey !== key.data ||
        proof.originalOperationKey !== request.data.originalOperationKey ||
        proof.runId !== recovered.invocation.runId ||
        proof.inputHash !== recovered.invocation.requestHash ||
        proof.outputHash !== recovered.invocation.responseHash ||
        proof.sourceDigest !== input.source_records_sha256 ||
        proof.bodyHash !== (await sha256(canonicalJson(request.data.acknowledgement))) ||
        proof.policyIndex !== request.data.acknowledgement.policyIndex ||
        proof.acknowledgementId !== result.data.acknowledgement_id ||
        proof.receiptId !== result.data.receipt_id ||
        proof.policyDraftId !== result.data.policy_draft_id ||
        proof.requestedReceipt !== recovered.outputProof.requestedReceipt ||
        proof.startedReceipt !== recovered.outputProof.startedReceipt ||
        proof.completedReceipt !== recovered.outputProof.completedReceipt ||
        proof.settledReceipt !== recovered.outputProof.settledReceipt
      )
        throw new ReviewedWorkflowRefused('reviewed_output_conflict');
      return c.json({ data: result.data }, result.data.replayed ? 200 : 201);
    } catch (error) {
      return refusal(c, error);
    }
  });
  return app;
}
