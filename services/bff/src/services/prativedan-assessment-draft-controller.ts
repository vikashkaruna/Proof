/** Unmounted assessment orchestration. Python exclusively owns the one-shot
 * claim and invocation. Uncertain network outcomes never grant retry authority. */
import { canonicalJson } from '@axiom/ledger';
import { prativedanAssessmentDraftRequestSchema } from '@axiom/types';
import {
  PrativedanAssessmentDraftStore,
  PrativedanAssessmentStoreUnavailable,
  prativedanAssessmentHumanContextSchema,
  type PrativedanAssessmentHumanContext,
} from './prativedan-assessment-draft-store.js';
import { preparePrativedanAssessmentDraftSource } from './prativedan-assessment-draft-source.js';
import { prativedanAssessmentRuntimeEnvelopeSchema } from './prativedan-assessment-draft-output.js';
import { PrativedanDraftRefused } from './prativedan-draft-source.js';
import { parsePrativedanAssessmentJson } from './prativedan-assessment-json.js';

export interface PrativedanAssessmentRuntimeBinding {
  tenant_id: string;
  actor_id: string;
  operation_key: string;
  engagement_id: string;
  assessment_run_id: string;
  source_id: string;
  run_id: string;
  request_text: string;
  source_sha256: string;
}
export interface PrativedanAssessmentControllerConfig {
  store: PrativedanAssessmentDraftStore;
  /** Required trusted server verifier: current founder/internal membership,
   * current session, authenticator attestation and expiry. No caller assertions. */
  authorizeCurrentHuman(context: PrativedanAssessmentHumanContext): Promise<void>;
  isKilled(tenantId: string): Promise<boolean>;
  runtime: { invoke(binding: PrativedanAssessmentRuntimeBinding): Promise<unknown> };
}
export class PrativedanAssessmentDraftController {
  constructor(private readonly config: PrativedanAssessmentControllerConfig) {}
  private async authorize(rawContext: PrativedanAssessmentHumanContext) {
    let context;
    try {
      context = prativedanAssessmentHumanContextSchema.parse(rawContext);
      await this.config.authorizeCurrentHuman(context);
      if (await this.config.isKilled(context.tenantId)) throw new PrativedanDraftRefused();
    } catch {
      throw new PrativedanDraftRefused();
    }
    return context;
  }
  private sameFrozen(
    before: ReturnType<typeof preparePrativedanAssessmentDraftSource>,
    after: ReturnType<typeof preparePrativedanAssessmentDraftSource>,
  ) {
    for (const field of [
      'tenant_id',
      'actor_id',
      'operation_key',
      'engagement_id',
      'assessment_run_id',
      'source_id',
      'run_id',
      'request_text',
      'request_sha256',
      'source_text',
      'source_sha256',
      'renderer_config_text',
      'renderer_config_sha256',
      'requested_receipt',
    ] as const) {
      if (canonicalJson(before.journal[field]) !== canonicalJson(after.journal[field]))
        throw new PrativedanDraftRefused();
    }
  }
  private async read(context: PrativedanAssessmentHumanContext, reviewedRequestText: string) {
    await this.authorize(context);
    const journal = await this.config.store.read(context, reviewedRequestText);
    if ('missing' in journal) throw new PrativedanDraftRefused();
    const prepared = preparePrativedanAssessmentDraftSource(journal, reviewedRequestText);
    if (journal.state === 'unpublished') {
      await this.authorize(context);
      await this.config.store.verifyRetained(prepared);
      await this.authorize(context);
    }
    return prepared;
  }
  async preview(
    context: PrativedanAssessmentHumanContext,
    engagementId: string,
    assessmentRunId: string,
  ) {
    context = await this.authorize(context);
    return this.config.store.preview(context, engagementId, assessmentRunId);
  }
  async request(context: PrativedanAssessmentHumanContext, reviewedRequestText: string) {
    context = await this.authorize(context);
    let acknowledgement;
    try {
      acknowledgement = await this.config.store.request(context, reviewedRequestText);
    } catch (error) {
      if (!(error instanceof PrativedanAssessmentStoreUnavailable)) throw error;
      // A lost response may have committed. Read exact original bytes; never rewrite.
      return { journal: (await this.read(context, reviewedRequestText)).journal, recovered: true };
    }
    const prepared = await this.read(context, reviewedRequestText);
    if (
      prepared.journal.run_id !== acknowledgement.run_id ||
      prepared.journal.requested_receipt.id !== acknowledgement.requested_receipt
    )
      throw new PrativedanDraftRefused();
    return { journal: prepared.journal, recovered: acknowledgement.replayed };
  }
  async reconcile(context: PrativedanAssessmentHumanContext, reviewedRequestText: string) {
    context = await this.authorize(context);
    return (await this.read(context, reviewedRequestText)).journal;
  }
  async generate(context: PrativedanAssessmentHumanContext, reviewedRequestText: string) {
    context = await this.authorize(context);
    let prepared = await this.read(context, reviewedRequestText);
    const journal = prepared.journal;
    if (journal.state !== 'requested') return { journal, outcome: journal.state };
    await this.authorize(context);
    let rawEnvelope: unknown;
    try {
      rawEnvelope = await this.config.runtime.invoke({
        tenant_id: journal.tenant_id,
        actor_id: journal.actor_id,
        operation_key: journal.operation_key,
        engagement_id: journal.engagement_id,
        assessment_run_id: journal.assessment_run_id,
        source_id: journal.source_id,
        run_id: journal.run_id,
        request_text: reviewedRequestText,
        source_sha256: journal.source_sha256,
      });
    } catch {
      // Even a still-requested read cannot prove a remote call has not claimed.
      const retained = await this.read(context, reviewedRequestText);
      this.sameFrozen(prepared, retained);
      return { journal: retained.journal, outcome: 'invocation_uncertain' };
    }
    let envelope;
    try {
      envelope = prativedanAssessmentRuntimeEnvelopeSchema.parse(rawEnvelope);
    } catch {
      throw new PrativedanDraftRefused();
    }
    const claimed = await this.read(context, reviewedRequestText);
    this.sameFrozen(prepared, claimed);
    prepared = claimed;
    await this.authorize(context);
    try {
      const settled = await this.config.store.settle(prepared, envelope, async () => {
        await this.authorize(context);
      });
      await this.authorize(context);
      return { journal: settled.journal, outcome: 'unpublished' };
    } catch (error) {
      if (!(error instanceof PrativedanAssessmentStoreUnavailable)) throw error;
      // Exact recovery only: no second invocation or settlement call.
      const retained = await this.read(context, reviewedRequestText);
      this.sameFrozen(prepared, retained);
      if (retained.journal.state === 'unpublished') {
        if (
          retained.journal.runtime_output_text !== envelope.runtime_output_text ||
          canonicalJson(retained.journal.output) !== canonicalJson(envelope.output) ||
          canonicalJson(retained.journal.started_receipt) !==
            canonicalJson(envelope.started_receipt) ||
          canonicalJson(retained.journal.completed_receipt) !==
            canonicalJson(envelope.completed_receipt)
        )
          throw new PrativedanDraftRefused();
        return { journal: retained.journal, outcome: 'unpublished' };
      }
      return { journal: retained.journal, outcome: 'invocation_uncertain' };
    }
  }
  async review(
    context: PrativedanAssessmentHumanContext,
    reviewedRequestText: string,
    input: {
      reviewKey: string;
      expectedHash: string;
      decision: 'accepted' | 'rejected';
      reason: string;
    },
  ) {
    context = await this.authorize(context);
    const prepared = await this.read(context, reviewedRequestText);
    if (
      prepared.journal.state !== 'unpublished' ||
      prepared.journal.response_output_sha256 !== input.expectedHash
    )
      throw new PrativedanDraftRefused();
    await this.authorize(context);
    const request = prativedanAssessmentDraftRequestSchema.parse(
      parsePrativedanAssessmentJson(reviewedRequestText),
    );
    let ack;
    try {
      ack = await this.config.store.review(context, request.operationKey, input);
    } catch (error) {
      if (!(error instanceof PrativedanAssessmentStoreUnavailable)) throw error;
      // Review may have committed; only exact retained readback can confirm it.
    }
    const retained = await this.read(context, reviewedRequestText);
    if (
      retained.journal.state !== 'unpublished' ||
      !retained.journal.review ||
      (ack !== undefined && retained.journal.review.receipt.id !== ack.reviewed_receipt) ||
      retained.journal.review.response_output_sha256 !== input.expectedHash ||
      retained.journal.review.actor_id !== context.actorId ||
      retained.journal.review.review_key !== input.reviewKey ||
      retained.journal.review.reason !== input.reason ||
      retained.journal.review.decision !== input.decision
    )
      throw new PrativedanDraftRefused();
    return retained.journal;
  }
}
