import type { AssessmentDispatch } from './assessment-dispatch.js';
import type { AssessmentChannel } from './assessment-channel.js';
import type { AssessmentConfirmation } from './assessment-confirmation.js';
/** Takes opaque job references only. Caller authentication, dispatch creation,
 * private launcher configuration and queue scheduling are separate authorities.
 * Every exit path attempts independent persistence confirmation; no retry of a
 * claim, launch or agent operation occurs here. */
export class AssessmentController {
  constructor(
    private readonly dispatch: Pick<AssessmentDispatch, 'resolve' | 'claim'>,
    private readonly channel: Pick<AssessmentChannel, 'run'>,
    private readonly confirmation: Pick<AssessmentConfirmation, 'confirm'>,
  ) {}
  async run(tenantId: string, jobId: string) {
    let job: Awaited<ReturnType<AssessmentDispatch['resolve']>>;
    try {
      job = await this.dispatch.resolve(tenantId, jobId);
    } catch {
      return { status: 'unconfirmed' as const, cleanupConfirmed: null };
    }
    let cleanupConfirmed: boolean | null = null;
    if (!job.claimed) {
      try {
        const claim = await this.dispatch.claim(tenantId, jobId);
        if (
          claim.context.jobId !== jobId.toLowerCase() ||
          claim.runId !== job.expected.runId ||
          claim.context.tenantId !== job.expected.tenantId ||
          claim.context.engagementId !== job.expected.engagementId ||
          claim.context.correlationId !== job.expected.correlationId ||
          claim.context.inputHash !== job.expected.inputHash
        )
          throw new Error('dispatch binding');
        cleanupConfirmed = (await this.channel.run(claim)).cleanupConfirmed;
      } catch {
        cleanupConfirmed = false;
      }
    }
    try {
      const recorded = await this.confirmation.confirm(job.expected);
      return {
        status: 'confirmed' as const,
        runId: recorded.run_id,
        receipt: recorded.finalized_receipt,
        resultDigest: recorded.result_digest,
        cleanupConfirmed,
      };
    } catch {
      return { status: 'unconfirmed' as const, runId: job.expected.runId, cleanupConfirmed };
    }
  }
}
