import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import { modelAccountingBindingSchema } from '@axiom/types';
import { PrativedanAssessmentAtomicController } from './prativedan-assessment-atomic-controller.js';
import {
  computePrativedanAccounted,
  PrativedanPrivateComputationUnconfirmed,
} from './prativedan-accounted-channel.js';
import type { AssessmentProcessFactory } from './assessment-channel.js';
import type { PrativedanAssessmentRpcClient } from '../services/prativedan-assessment-draft-store.js';
import type { PrativedanAssessmentRuntimeBinding } from '../services/prativedan-assessment-draft-controller.js';
import { preparePrativedanAssessmentDraftSource } from '../services/prativedan-assessment-draft-source.js';
import { verifyPrativedanAssessmentRendering } from '../services/prativedan-assessment-draft-output.js';
import { parsePrativedanAssessmentJson } from '../services/prativedan-assessment-json.js';
import { prativedanTextHash } from '../services/prativedan-draft-source.js';
import { accountedAgentResultSchema } from '../services/accounted-agent-result.js';

const authoritySchema = z.strictObject({
  actor_id: z.uuid(),
  session_id: z.uuid(),
  workload_id: z.uuid(),
  registration_version: z.number().int().positive(),
  subject: z.string().min(1).max(2048),
  svid_expires_at: z.iso.datetime({ offset: true }),
});
const admittedSchema = z.strictObject({
  admitted: z.union([
    z.strictObject({ claimed: z.literal(false), invocation_uncertain: z.literal(true) }),
    z.strictObject({
      claimed: z.literal(true),
      claim: z.unknown(),
      started_receipt: z.unknown(),
      accounting_dispatch: z.unknown(),
    }),
  ]),
  originalAuthority: authoritySchema,
});

/** Per-private-request composition. token() obtains the controller's fresh exact
 * workload SVID; the AtomicController independently resolves the current human.
 * No peer bearer, task proof or writer reaches either child process. */
export class PrativedanAccountedRuntime {
  constructor(
    private readonly config: {
      atomic: PrativedanAssessmentAtomicController;
      token(): Promise<string>;
      controllerWriterFactory(): PrativedanAssessmentRpcClient;
      /** Fresh independently verified own workload, matching original principal,
       * audience and registration. Does not grant new work after human stop. */
      requireOriginalWorkload(authority: z.infer<typeof authoritySchema>): Promise<void>;
      computation: AssessmentProcessFactory;
      renderer: AssessmentProcessFactory;
    },
  ) {}
  private selection(b: PrativedanAssessmentRuntimeBinding) {
    return {
      tenantId: b.tenant_id,
      operationKey: b.operation_key,
      runId: b.run_id,
      requestSha256: prativedanTextHash(b.request_text),
      sourceSha256: b.source_sha256,
    };
  }
  private perform(b: PrativedanAssessmentRuntimeBinding, command: unknown) {
    return this.config
      .token()
      .then((token) => this.config.atomic.perform(token, this.selection(b), command));
  }
  async recover(b: PrativedanAssessmentRuntimeBinding) {
    const result = await this.perform(b, { kind: 'accounted-read' });
    if (z.strictObject({ missing: z.literal(true) }).safeParse(result).success) return null;
    return accountedAgentResultSchema.parse(result);
  }
  async invoke(b: PrativedanAssessmentRuntimeBinding) {
    const prepared = preparePrativedanAssessmentDraftSource(
      await this.perform(b, { kind: 'load' }),
      b.request_text,
    );
    const j = prepared.journal;
    if (
      j.actor_id !== b.actor_id ||
      j.engagement_id !== b.engagement_id ||
      j.assessment_run_id !== b.assessment_run_id ||
      j.source_id !== b.source_id
    )
      throw new Error('prativedan_dispatch_refused');
    if (j.state !== 'requested') {
      const retained = await this.recover(b);
      if (!retained) throw new Error('prativedan_invocation_uncertain');
      return retained;
    }
    const proof = randomBytes(32);
    try {
      const inputText = canonicalJson(prepared.rendererInput);
      const start = admittedSchema.parse(
        await this.perform(b, {
          kind: 'accounted-start',
          inputText,
          taskSha256: prativedanTextHash(proof.toString('hex')),
        }),
      );
      if (!start.admitted.claimed) {
        const retained = await this.recover(b);
        if (!retained) throw new Error('prativedan_invocation_uncertain');
        return retained;
      }
      const admitted = start.admitted;
      const binding = modelAccountingBindingSchema.parse({
        schema_version: 2,
        tenant_id: j.tenant_id,
        run_id: j.run_id,
        correlation_id: j.operation_key,
        request_sha256: j.request_sha256,
        agent: 'prativedan',
        agent_version: '0.1.0',
      });
      const started = performance.now();
      let outputText: string | null = null;
      let failureCode: string | null = null;
      let authorityRefused = false;
      try {
        const result = await computePrativedanAccounted({
          binding,
          inputText,
          accountingDispatch: admitted.accounting_dispatch,
          requireCurrent: async () => {
            try {
              await this.perform(b, { kind: 'load' });
            } catch {
              authorityRefused = true;
              throw new Error('current_authority_refused');
            }
          },
          computation: this.config.computation,
          renderer: this.config.renderer,
        });
        outputText = result.output_text;
        failureCode = result.failure_code;
        if (outputText !== null)
          verifyPrativedanAssessmentRendering(prepared, parsePrativedanAssessmentJson(outputText));
      } catch (error) {
        outputText = null;
        failureCode = authorityRefused
          ? 'current_authority_refused'
          : error instanceof PrativedanPrivateComputationUnconfirmed
            ? 'accounting_uncertain'
            : 'target_failed';
      }
      // Terminal facts only. A stopped human cannot start a second computation;
      // the original proof can only finish this one immutable admitted attempt.
      await this.config.requireOriginalWorkload(start.originalAuthority);
      const response = await this.config
        .controllerWriterFactory()
        .rpc('finish_prativedan_accounted_draft', {
          t: j.tenant_id,
          k: j.operation_key,
          r: j.run_id,
          rh: j.request_sha256,
          task_proof: proof.toString('hex'),
          output_text: outputText,
          failure_code: failureCode,
          latency_ms: Math.min(Math.floor(performance.now() - started), 2147483647),
          authority: start.originalAuthority,
        })
        .abortSignal(AbortSignal.timeout(15000));
      if (response.error) throw new Error('prativedan_terminal_unconfirmed');
      return accountedAgentResultSchema.parse(response.data);
    } finally {
      proof.fill(0);
    }
  }
}
