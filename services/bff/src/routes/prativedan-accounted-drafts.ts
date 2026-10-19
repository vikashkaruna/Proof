import { Hono } from 'hono';
import { z } from 'zod';
import type { Variables } from '../types.js';
import type { MfaService } from '../services/mfa.js';
import { boundedJsonBody } from '../middleware/evidence-body-limit.js';
import {
  PrativedanAssessmentDraftStore,
  type PrativedanAssessmentRpcClient,
} from '../services/prativedan-assessment-draft-store.js';
import {
  PrativedanAssessmentDraftController,
  type PrativedanAssessmentRuntimeBinding,
} from '../services/prativedan-assessment-draft-controller.js';
import { preparePrativedanAssessmentDraftSource } from '../services/prativedan-assessment-draft-source.js';
import { prativedanTextHash } from '../services/prativedan-draft-source.js';
import { parsePrativedanAssessmentJson } from '../services/prativedan-assessment-json.js';
import { prativedanAssessmentDraftRequestSchema } from '@axiom/types';

export interface PrativedanPrivateClient {
  handle(input: unknown): Promise<unknown>;
}
const selectionSchema = z.strictObject({ engagementId: z.uuid(), assessmentRunId: z.uuid() });
const requestSchema = z.strictObject({ reviewedRequestText: z.string().min(1).max(4096) });
const reviewSchema = requestSchema.extend({
  reviewKey: z.uuid(),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['accepted', 'rejected']),
  reason: z
    .string()
    .min(20)
    .max(2000)
    .refine((v) => v === v.trim()),
});

/** Actual BFF mount, default unavailable without an explicitly configured
 * UID-bound private controller. Does not modify the Board report workflow. */
export function prativedanAccountedDraftRoutes(deps: {
  mfa: MfaService;
  client?: PrativedanPrivateClient;
  humanWriterFactory?: () => PrativedanAssessmentRpcClient;
}) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('/reports/accounted-drafts/*', boundedJsonBody(16384));
  app.get('/reports/accounted-drafts/configuration', (c) =>
    c.json({
      data: {
        enabled: Boolean(deps.client),
        modelInference: false,
        publicationAllowed: false,
        accountingScope: 'dedicated_prativedan_draft_only',
      },
    }),
  );
  app.post('/reports/accounted-drafts/:step', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    if (c.req.header('X-Expected-Actor-Id') !== c.get('user').id)
      return c.json({ error: { code: 'actor_changed' } }, 409);
    if (c.get('role') !== 'founder') return c.json({ error: { code: 'founder_required' } }, 403);
    if (!deps.client)
      return c.json({ error: { code: 'prativedan_controller_not_configured' } }, 503);
    const context = {
      tenantId: c.get('tenantId'),
      actorId: c.get('user').id,
      sessionId: c.get('sessionId'),
    };
    const authorize = async () => {
      if (!z.uuid().safeParse(context.sessionId).success) throw new Error();
      const attestation = await deps.mfa.sessionAttestation({
        userId: context.actorId,
        sessionId: context.sessionId,
      });
      if (!attestation || Date.parse(attestation.expiresAt) <= Date.now())
        throw new Error('current_mfa_required');
    };
    let binding: PrativedanAssessmentRuntimeBinding | undefined;
    const exchange = async (command: unknown) => {
      if (!binding) throw new Error();
      return deps.client!.handle({ humanBearer: c.get('token'), binding, command });
    };
    const atomic = (command: unknown) => exchange({ kind: 'atomic', command });
    const store = new PrativedanAssessmentDraftStore({
      humanWriterFactory: deps.humanWriterFactory,
      controllerCall: async (name, args) => {
        if (
          !binding ||
          args.t !== binding.tenant_id ||
          args.k !== binding.operation_key ||
          args.r !== binding.run_id ||
          args.rh !==
            preparePrativedanAssessmentDraftSource(
              await store.read(context, binding.request_text),
              binding.request_text,
            ).journal.request_sha256
        )
          throw new Error();
        if (name === 'read_prativedan_assessment_runtime_receipts')
          return atomic({ kind: 'receipts', started: args.started, completed: args.completed });
        if (name !== 'settle_prativedan_assessment_draft') throw new Error();
        const prepared = preparePrativedanAssessmentDraftSource(
          await store.read(context, binding.request_text),
          binding.request_text,
        );
        if (prepared.journal.state === 'requested') throw new Error();
        const witness = await atomic({
          kind: 'receipts',
          started: args.started,
          completed: args.completed,
        });
        if (!witness || typeof witness !== 'object') throw new Error();
        return atomic({
          kind: 'settle',
          envelope: {
            ...witness,
            renderer_config_text: args.config_text,
            normalized_input_text: prepared.journal.normalized_input_text,
            runtime_output_text: args.output_text,
            output: parsePrativedanAssessmentJson(z.string().parse(args.output_text)),
            review_required: true,
            citation_verification: 'unverified_references',
          },
        });
      },
    });
    const controller = new PrativedanAssessmentDraftController({
      store,
      authorizeCurrentHuman: authorize,
      // SQL source/request/current controller authorization each independently
      // enforces live global+tenant kill state; no mutation is admitted by this.
      isKilled: async () => false,
      runtime: {
        invoke: async (b) => {
          binding = b;
          return exchange({ kind: 'invoke' });
        },
        recover: async (b) => {
          binding = b;
          return exchange({ kind: 'recover' });
        },
      },
      accountingReader: {
        call: async (name, args) => {
          if (
            !binding ||
            name !== 'read_model_accounting_result' ||
            args.t !== binding.tenant_id ||
            args.r !== binding.run_id ||
            args.rh !== prativedanTextHash(binding.request_text)
          )
            throw new Error();
          return atomic({ kind: 'accounting-witness' });
        },
      },
    });
    try {
      await authorize();
      const step = c.req.param('step'),
        raw: unknown = await c.req.json();
      if (step === 'preview') {
        const s = selectionSchema.parse(raw);
        return c.json({
          data: await controller.preview(context, s.engagementId, s.assessmentRunId),
        });
      }
      const input = step === 'review' ? reviewSchema.parse(raw) : requestSchema.parse(raw);
      const human = prativedanAssessmentDraftRequestSchema.parse(
        parsePrativedanAssessmentJson(input.reviewedRequestText),
      );
      const loadBinding = async () => {
        const p = preparePrativedanAssessmentDraftSource(
          await store.read(context, input.reviewedRequestText),
          input.reviewedRequestText,
        );
        const j = p.journal;
        binding = {
          tenant_id: j.tenant_id,
          actor_id: j.actor_id,
          operation_key: j.operation_key,
          engagement_id: j.engagement_id,
          assessment_run_id: j.assessment_run_id,
          source_id: j.source_id,
          run_id: j.run_id,
          request_text: input.reviewedRequestText,
          source_sha256: j.source_sha256,
        };
        if (human.operationKey !== j.operation_key) throw new Error();
      };
      if (step === 'request')
        return c.json({ data: await controller.request(context, input.reviewedRequestText) }, 201);
      await loadBinding();
      if (step === 'generate')
        return c.json({ data: await controller.generate(context, input.reviewedRequestText) });
      if (step === 'reconcile')
        return c.json({ data: await controller.reconcile(context, input.reviewedRequestText) });
      if (step === 'review') {
        const { reviewedRequestText: _reviewedRequestText, ...review } = reviewSchema.parse(input);
        return c.json({
          data: await controller.review(context, input.reviewedRequestText, review),
        });
      }
      return c.json({ error: { code: 'invalid_request' } }, 400);
    } catch {
      return c.json(
        {
          error: {
            code: 'prativedan_draft_unconfirmed',
            message:
              'Keep the original request. Reconcile its recorded result before trying again.',
          },
        },
        409,
      );
    }
  });
  return app;
}
