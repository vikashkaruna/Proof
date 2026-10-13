/** Unmounted scoped assessment store. No table/ledger SELECT or service-role fallback. */
import { z } from 'zod';
import { createHumanActionWriter, createAgentLedgerWriter } from '@axiom/supabase';
import {
  prativedanAssessmentDraftRequestSchema,
  prativedanAssessmentPreviewSchema,
  prativedanAssessmentSourceSchema,
  prativedanAssessmentRequestAcknowledgementSchema,
  prativedanAssessmentReadbackSchema,
  prativedanAssessmentSettlementSchema,
  prativedanAssessmentReviewAcknowledgementSchema,
} from '@axiom/types';
import { parsePrativedanAssessmentJson } from './prativedan-assessment-json.js';
import {
  preparePrativedanAssessmentDraftSource,
  type PreparedPrativedanAssessmentDraftSource,
} from './prativedan-assessment-draft-source.js';
import {
  prativedanAssessmentRuntimeEnvelopeSchema,
  prativedanAssessmentRuntimeReceiptWitnessSchema,
  verifyPrativedanAssessmentDraftOutput,
} from './prativedan-assessment-draft-output.js';
import { PrativedanDraftRefused, prativedanTextHash } from './prativedan-draft-source.js';

function parseGuard<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  try {
    return schema.parse(value);
  } catch {
    throw new PrativedanDraftRefused();
  }
}
const identity = prativedanAssessmentDraftRequestSchema.shape.operationKey;
export const prativedanAssessmentHumanContextSchema = z
  .object({ tenantId: identity, actorId: identity, sessionId: identity })
  .strict();
export type PrativedanAssessmentHumanContext = z.infer<
  typeof prativedanAssessmentHumanContextSchema
>;
export interface PrativedanAssessmentRpcClient {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): {
    abortSignal(signal: AbortSignal): PromiseLike<{ data: unknown; error: unknown }>;
  };
}
export class PrativedanAssessmentStoreUnavailable extends Error {
  constructor() {
    super('prativedan_assessment_store_unavailable');
  }
}
export type PrativedanAssessmentRuntimeEnvelope = z.infer<
  typeof prativedanAssessmentRuntimeEnvelopeSchema
>;
export interface PrativedanAssessmentStoreConfig {
  humanWriterFactory?: () => PrativedanAssessmentRpcClient;
  agentWriterFactory?: () => PrativedanAssessmentRpcClient;
}
export class PrativedanAssessmentDraftStore {
  constructor(private readonly config: PrativedanAssessmentStoreConfig = {}) {}
  private async rpc(kind: 'human' | 'agent', name: string, args: Record<string, unknown>) {
    try {
      const client: PrativedanAssessmentRpcClient =
        kind === 'human'
          ? (this.config.humanWriterFactory ?? createHumanActionWriter)()
          : (this.config.agentWriterFactory ?? createAgentLedgerWriter)();
      const result = await client.rpc(name, args).abortSignal(AbortSignal.timeout(15000));
      if (result.error) throw new PrativedanAssessmentStoreUnavailable();
      return result.data;
    } catch {
      throw new PrativedanAssessmentStoreUnavailable();
    }
  }
  private humanArgs(rawContext: PrativedanAssessmentHumanContext, humanText: string) {
    const context = parseGuard(prativedanAssessmentHumanContextSchema, rawContext);
    parseGuard(prativedanAssessmentDraftRequestSchema, parsePrativedanAssessmentJson(humanText));
    if (Buffer.byteLength(humanText, 'utf8') > 4096) throw new PrativedanDraftRefused();
    return { t: context.tenantId, a: context.actorId, human_text: humanText };
  }
  async preview(
    context: PrativedanAssessmentHumanContext,
    engagementId: string,
    assessmentRunId: string,
  ) {
    context = parseGuard(prativedanAssessmentHumanContextSchema, context);
    const value = parseGuard(
      prativedanAssessmentPreviewSchema,
      await this.rpc('human', 'preview_prativedan_assessment_source', {
        t: context.tenantId,
        a: context.actorId,
        e: parseGuard(identity, engagementId),
        r: parseGuard(identity, assessmentRunId),
      }),
    );
    const source = parseGuard(
      prativedanAssessmentSourceSchema,
      parsePrativedanAssessmentJson(value.source_text),
    );
    if (
      prativedanTextHash(source.controls_text) !== source.controls_sha256 ||
      prativedanTextHash(source.result_text) !== source.result_sha256 ||
      prativedanTextHash(value.source_text) !== value.source_sha256 ||
      source.tenant_id !== context.tenantId ||
      source.engagement_id !== engagementId ||
      source.assessment_run_id !== assessmentRunId
    )
      throw new PrativedanDraftRefused();
    return value;
  }
  async request(context: PrativedanAssessmentHumanContext, reviewedRequestText: string) {
    const args = this.humanArgs(context, reviewedRequestText);
    const value = parseGuard(
      prativedanAssessmentRequestAcknowledgementSchema,
      await this.rpc('human', 'request_prativedan_assessment_draft', args),
    );
    const request = parseGuard(
      prativedanAssessmentDraftRequestSchema,
      parsePrativedanAssessmentJson(reviewedRequestText),
    );
    if (value.operation_key !== request.operationKey || value.run_id === request.assessmentRunId)
      throw new PrativedanDraftRefused();
    return value;
  }
  async read(context: PrativedanAssessmentHumanContext, reviewedRequestText: string) {
    const value = parseGuard(
      prativedanAssessmentReadbackSchema,
      await this.rpc(
        'human',
        'read_prativedan_assessment_draft',
        this.humanArgs(context, reviewedRequestText),
      ),
    );
    if ('missing' in value) return value;
    if (value.tenant_id !== context.tenantId || value.actor_id !== context.actorId)
      throw new PrativedanDraftRefused();
    preparePrativedanAssessmentDraftSource(value, reviewedRequestText);
    return value;
  }
  async receipts(
    prepared: PreparedPrativedanAssessmentDraftSource,
    envelope: PrativedanAssessmentRuntimeEnvelope,
  ) {
    prepared = preparePrativedanAssessmentDraftSource(
      prepared.journal,
      prepared.reviewedRequestText,
    );
    envelope = parseGuard(prativedanAssessmentRuntimeEnvelopeSchema, envelope);
    const journal = prepared.journal;
    return parseGuard(
      prativedanAssessmentRuntimeReceiptWitnessSchema,
      await this.rpc('agent', 'read_prativedan_assessment_runtime_receipts', {
        t: journal.tenant_id,
        k: journal.operation_key,
        r: journal.run_id,
        rh: journal.request_sha256,
        started: envelope.started_receipt.id,
        completed: envelope.completed_receipt.id,
      }),
    );
  }
  async settle(
    prepared: PreparedPrativedanAssessmentDraftSource,
    envelope: PrativedanAssessmentRuntimeEnvelope,
    authorizeBeforeCommit: () => Promise<void>,
  ) {
    prepared = preparePrativedanAssessmentDraftSource(
      prepared.journal,
      prepared.reviewedRequestText,
    );
    // Always load the witness independently here; a controller cannot supply its envelope as proof.
    const witness = await this.receipts(prepared, envelope);
    const verified = verifyPrativedanAssessmentDraftOutput(prepared, envelope, witness);
    const journal = prepared.journal;
    await authorizeBeforeCommit();
    const value = parseGuard(
      prativedanAssessmentSettlementSchema,
      await this.rpc('agent', 'settle_prativedan_assessment_draft', {
        t: journal.tenant_id,
        k: journal.operation_key,
        r: journal.run_id,
        rh: journal.request_sha256,
        input_hash: verified.runtimeNormalizedInputSha256,
        config_text: envelope.renderer_config_text,
        output_text: envelope.runtime_output_text,
        response_text: verified.responseOutputText,
        started: witness.started_receipt.id,
        completed: witness.completed_receipt.id,
      }),
    );
    const { replayed, ...readback } = value;
    const retained = preparePrativedanAssessmentDraftSource(readback, prepared.reviewedRequestText);
    if (
      retained.journal.tenant_id !== journal.tenant_id ||
      retained.journal.actor_id !== journal.actor_id ||
      retained.journal.run_id !== journal.run_id
    )
      throw new PrativedanDraftRefused();
    verifyPrativedanAssessmentDraftOutput(retained, envelope, witness);
    return { journal: readback, replayed };
  }
  async verifyRetained(prepared: PreparedPrativedanAssessmentDraftSource) {
    prepared = preparePrativedanAssessmentDraftSource(
      prepared.journal,
      prepared.reviewedRequestText,
    );
    const journal = prepared.journal;
    if (journal.state !== 'unpublished') throw new PrativedanDraftRefused();
    const witness = parseGuard(
      prativedanAssessmentRuntimeReceiptWitnessSchema,
      await this.rpc('agent', 'read_prativedan_assessment_runtime_receipts', {
        t: journal.tenant_id,
        k: journal.operation_key,
        r: journal.run_id,
        rh: journal.request_sha256,
        started: journal.started_receipt.id,
        completed: journal.completed_receipt.id,
      }),
    );
    const envelope = parseGuard(prativedanAssessmentRuntimeEnvelopeSchema, {
      ...witness,
      renderer_config_text: journal.renderer_config_text,
      normalized_input_text: journal.normalized_input_text,
      runtime_output_text: journal.runtime_output_text,
      output: journal.output,
      review_required: true,
      citation_verification: 'unverified_references',
    });
    verifyPrativedanAssessmentDraftOutput(prepared, envelope, witness);
    return journal;
  }
  async review(
    context: PrativedanAssessmentHumanContext,
    operationKey: string,
    input: {
      reviewKey: string;
      expectedHash: string;
      decision: 'accepted' | 'rejected';
      reason: string;
    },
  ) {
    context = parseGuard(prativedanAssessmentHumanContextSchema, context);
    const reviewSchema = z
      .object({
        reviewKey: identity,
        expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
        decision: z.enum(['accepted', 'rejected']),
        reason: z
          .string()
          .refine(
            (s) => [...s].length >= 20 && [...s].length <= 2000 && s === s.replace(/^ +| +$/g, ''),
          ),
      })
      .strict();
    const review = parseGuard(reviewSchema, input);
    return parseGuard(
      prativedanAssessmentReviewAcknowledgementSchema,
      await this.rpc('human', 'review_prativedan_assessment_draft', {
        t: context.tenantId,
        a: context.actorId,
        k: parseGuard(identity, operationKey),
        review_key: review.reviewKey,
        expected_hash: review.expectedHash,
        decision: review.decision,
        reason: review.reason,
      }),
    );
  }
}
