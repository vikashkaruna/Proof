import { createHash, randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createHumanActionWriter } from '@axiom/supabase';
import { z } from 'zod';
import type { AssessmentRequest } from '@axiom/types';
import { TaskProof } from './tasks.js';
import {
  dispatchContextSchema,
  DispatchRefused,
  sealDispatch,
  openDispatch,
  sealedDispatchSchema,
  type DispatchContext,
  type DispatchKeyWrapper,
} from './dispatch-payload.js';
const receipt = z
  .object({ job_id: z.uuid(), run_id: z.uuid(), expires_at: z.iso.datetime({ offset: true }) })
  .strict();
const claimed = sealedDispatchSchema
  .extend({
    job_id: z.uuid(),
    tenant_id: z.uuid(),
    run_id: z.uuid(),
    actor_id: z.uuid(),
    workload_id: z.uuid(),
    estate_id: z.uuid().nullable(),
    engagement_id: z.uuid(),
    correlation_id: z.uuid(),
    input_hash: z.string().regex(/^[a-f0-9]{64}$/),
    proof_hash: z.string().regex(/^[a-f0-9]{64}$/),
    expires_at: z.iso.datetime({ offset: true }),
  })
  .strict();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** The exact activated local custody policy a deployment is bound to (0143–0150).
 * Present only in local custody mode; SQL re-verifies every pin on enqueue and
 * claim, so these select the policy rather than grant anything. */
export const localCustodyPinsSchema = z
  .object({
    custodyPolicyId: z.uuid(),
    custodyPolicySha256: digest,
    keyPolicySha256: digest,
    activationEventId: z.uuid(),
    activationEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    deploymentBindingSha256: digest,
  })
  .strict();
export type LocalCustodyPins = z.infer<typeof localCustodyPinsSchema>;
const localClaimed = claimed.extend({
  local_custody: z
    .object({
      policy_id: z.uuid(),
      policy_sha256: digest,
      key_policy_sha256: digest,
      grant_sha256: digest,
      context_sha256: digest,
      activation_event_id: z.uuid(),
      activation_epoch: z.number().int().positive(),
      original_expires_at: z.iso.datetime({ offset: true }),
    })
    .strict(),
});
/** Trusted producer/controller adapter. Enqueue uses only the authenticated BFF
 * human writer; read/claim retain their separate controller identity. No
 * browser/worker route. The caller supplies a stable
 * job ID and authenticated context; returning a receipt never grants authority. */
export class AssessmentDispatch {
  readonly #revisions = new Map<string, number>();
  readonly #local: LocalCustodyPins | undefined;
  constructor(
    private readonly db: SupabaseClient,
    private readonly wrapper: DispatchKeyWrapper,
    revisions: ReadonlyMap<string, number> = new Map(),
    private readonly enqueueWriter: () => SupabaseClient = createHumanActionWriter,
    local?: LocalCustodyPins,
  ) {
    try {
      // Local custody and cloud KMS policy are exclusive per deployment.
      if (local !== undefined && (revisions.size > 0 || wrapper.policyFingerprint))
        throw new DispatchRefused();
      this.#local =
        local === undefined ? undefined : Object.freeze(localCustodyPinsSchema.parse(local));
      for (const [tenant, revision] of revisions) {
        const canonical = z.uuid().parse(tenant).toLowerCase();
        if (this.#revisions.has(canonical)) throw new DispatchRefused();
        this.#revisions.set(canonical, z.number().int().positive().max(2147483647).parse(revision));
      }
    } catch {
      throw new DispatchRefused();
    }
  }
  private policyBinding(tenant: string) {
    const revision = this.#revisions.get(tenant);
    if (!this.wrapper.policyFingerprint) {
      if (revision !== undefined) throw new DispatchRefused();
      return {};
    }
    if (revision === undefined) throw new DispatchRefused();
    return {
      p_policy_revision: revision,
      p_policy_fingerprint: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(this.wrapper.policyFingerprint(tenant)),
    };
  }
  /** Current authenticated human receipt recovery; no policy/KMS access or renewal. */
  async recover(
    context: DispatchContext,
    expectedQuestionnaire?: AssessmentRequest['expectedQuestionnaire'],
    reviewRef?: AssessmentRequest['reviewRef'],
  ) {
    try {
      const c = dispatchContextSchema.parse(context);
      const { data, error } = await this.enqueueWriter()
        .rpc(
          reviewRef
            ? 'recover_public_control_assessment_dispatch'
            : expectedQuestionnaire
              ? 'recover_reviewed_assessment_dispatch'
              : 'recover_assessment_dispatch',
          {
            ...(reviewRef
              ? {
                  p_review_id: reviewRef.reviewId,
                  p_review_request_sha256: reviewRef.requestSha256,
                  p_review_snapshot_sha256: reviewRef.snapshotSha256,
                }
              : {}),
            ...(!reviewRef && expectedQuestionnaire
              ? {
                  p_expected_library_version: expectedQuestionnaire.libraryVersion,
                  p_expected_questionnaire_digest: expectedQuestionnaire.questionnaireDigest,
                }
              : {}),
            p_job_id: c.jobId,
            p_tenant_id: c.tenantId,
            p_actor_id: c.actorId,
            p_workload_id: c.workloadId,
            p_estate_id: c.estateId,
            p_engagement_id: c.engagementId,
            p_correlation_id: c.correlationId,
            p_input_hash: c.inputHash,
          },
        )
        .abortSignal(AbortSignal.timeout(10000));
      if (error) throw new DispatchRefused();
      if (data === null) return null;
      const row = receipt.parse(data);
      if (row.job_id !== c.jobId) throw new DispatchRefused();
      return row;
    } catch {
      throw new DispatchRefused();
    }
  }
  async enqueue(
    context: DispatchContext,
    inputJson: string,
    expectedQuestionnaire?: AssessmentRequest['expectedQuestionnaire'],
    reviewRef?: AssessmentRequest['reviewRef'],
  ) {
    try {
      const c = dispatchContextSchema.parse(context);
      if (createHash('sha256').update(inputJson, 'utf8').digest('hex') !== c.inputHash)
        throw new DispatchRefused();
      const recovered = await this.recover(c, expectedQuestionnaire, reviewRef);
      if (recovered) return recovered;
      if (this.#local) return await this.enqueueLocal(c, inputJson, reviewRef);
      const binding = this.policyBinding(c.tenantId);
      if (!binding.p_policy_revision || !binding.p_policy_fingerprint) throw new DispatchRefused();
      const writer = this.enqueueWriter();
      const proof = new TaskProof(randomBytes(32).toString('base64url'));
      const sealed = await sealDispatch(c, inputJson, proof, this.wrapper);
      const { data, error } = await writer
        .rpc(
          reviewRef
            ? 'enqueue_public_control_assessment_dispatch'
            : expectedQuestionnaire
              ? 'enqueue_reviewed_assessment_dispatch'
              : 'enqueue_assessment_dispatch',
          {
            ...(reviewRef
              ? {
                  p_review_id: reviewRef.reviewId,
                  p_review_request_sha256: reviewRef.requestSha256,
                  p_review_snapshot_sha256: reviewRef.snapshotSha256,
                }
              : {}),
            ...(!reviewRef && expectedQuestionnaire
              ? {
                  p_expected_library_version: expectedQuestionnaire.libraryVersion,
                  p_expected_questionnaire_digest: expectedQuestionnaire.questionnaireDigest,
                }
              : {}),
            ...binding,
            p_job_id: c.jobId,
            p_tenant_id: c.tenantId,
            p_actor_id: c.actorId,
            p_workload_id: c.workloadId,
            p_estate_id: c.estateId,
            p_engagement_id: c.engagementId,
            p_correlation_id: c.correlationId,
            p_input_hash: c.inputHash,
            p_proof_hash: createHash('sha256').update(proof.reveal(), 'ascii').digest('hex'),
            p_expires_at: new Date(Date.now() + 300000).toISOString(),
            p_key_ref: sealed.key_ref,
            p_nonce: '\\x' + sealed.nonce,
            p_ciphertext: '\\x' + sealed.ciphertext,
            p_wrapped_key: '\\x' + sealed.wrapped_key,
          },
        )
        .abortSignal(AbortSignal.timeout(10000));
      if (error) throw new DispatchRefused();
      const row = receipt.parse(data);
      if (row.job_id !== c.jobId) throw new DispatchRefused();
      return row;
    } catch {
      throw new DispatchRefused();
    }
  }
  /** Local custody admission (0147): only reviewed public-control work, with the
   * dispatch key wrapped by the admitted local key service. */
  private async enqueueLocal(
    c: DispatchContext,
    inputJson: string,
    reviewRef: AssessmentRequest['reviewRef'],
  ) {
    const local = this.#local!;
    if (!reviewRef || this.wrapper.policyFingerprint) throw new DispatchRefused();
    const writer = this.enqueueWriter();
    const proof = new TaskProof(randomBytes(32).toString('base64url'));
    const sealed = await sealDispatch(c, inputJson, proof, this.wrapper);
    const { data, error } = await writer
      .rpc('enqueue_local_public_control_assessment_dispatch', {
        p_job_id: c.jobId,
        p_tenant_id: c.tenantId,
        p_actor_id: c.actorId,
        p_workload_id: c.workloadId,
        p_estate_id: c.estateId,
        p_engagement_id: c.engagementId,
        p_correlation_id: c.correlationId,
        p_input_hash: c.inputHash,
        p_proof_hash: createHash('sha256').update(proof.reveal(), 'ascii').digest('hex'),
        p_expires_at: new Date(Date.now() + 300000).toISOString(),
        p_key_ref: sealed.key_ref,
        p_nonce: '\\x' + sealed.nonce,
        p_ciphertext: '\\x' + sealed.ciphertext,
        p_wrapped_key: '\\x' + sealed.wrapped_key,
        p_custody_policy_id: local.custodyPolicyId,
        p_custody_policy_sha256: local.custodyPolicySha256,
        p_key_policy_sha256: local.keyPolicySha256,
        p_activation_event_id: local.activationEventId,
        p_activation_epoch: local.activationEpoch,
        p_deployment_binding_sha256: local.deploymentBindingSha256,
        p_review_id: reviewRef.reviewId,
        p_review_request_sha256: reviewRef.requestSha256,
        p_review_snapshot_sha256: reviewRef.snapshotSha256,
      })
      .abortSignal(AbortSignal.timeout(10000));
    if (error) throw new DispatchRefused();
    const row = receipt.parse(data);
    if (row.job_id !== c.jobId) throw new DispatchRefused();
    return row;
  }
  /** Opaque trusted-controller lookup for reconciliation, with no ciphertext or
   * private proof/input. Historical confirmation does not renew task authority. */
  async resolve(tenantId: string, jobId: string) {
    try {
      tenantId = z.uuid().parse(tenantId).toLowerCase();
      jobId = z.uuid().parse(jobId).toLowerCase();
      const { data, error } = await this.db
        .from('assessment_dispatch_jobs')
        .select('id,tenant_id,run_id,engagement_id,correlation_id,input_hash,claimed_at')
        .eq('tenant_id', tenantId)
        .eq('id', jobId)
        .maybeSingle();
      if (error) throw new DispatchRefused();
      const row = z
        .object({
          id: z.literal(jobId),
          tenant_id: z.literal(tenantId),
          run_id: z.uuid(),
          engagement_id: z.uuid(),
          correlation_id: z.uuid(),
          input_hash: z.string().regex(/^[a-f0-9]{64}$/),
          claimed_at: z.iso.datetime({ offset: true }).nullable(),
        })
        .strict()
        .parse(data);
      return {
        expected: {
          tenantId,
          runId: row.run_id,
          engagementId: row.engagement_id,
          correlationId: row.correlation_id,
          inputHash: row.input_hash,
        },
        claimed: row.claimed_at !== null,
      };
    } catch {
      throw new DispatchRefused();
    }
  }
  /** One delivery only. A lost claim response or failed decryption is uncertain:
   * reconcile the durable run; do not retry a launch with a new authority. */
  async claim(tenantId: string, jobId: string) {
    try {
      tenantId = z.uuid().parse(tenantId).toLowerCase();
      jobId = z.uuid().parse(jobId).toLowerCase();
      const local = this.#local;
      const { data, error } = local
        ? await this.db.rpc('claim_local_assessment_dispatch', {
            p_tenant_id: tenantId,
            p_job_id: jobId,
            p_custody_policy_id: local.custodyPolicyId,
            p_custody_policy_sha256: local.custodyPolicySha256,
            p_key_policy_sha256: local.keyPolicySha256,
          })
        : await this.db.rpc('claim_assessment_dispatch', {
            ...this.policyBinding(tenantId),
            p_tenant_id: tenantId,
            p_job_id: jobId,
          });
      if (error) throw new DispatchRefused();
      let row: z.infer<typeof claimed>;
      if (local) {
        const { local_custody: custody, ...rest } = localClaimed.parse(data);
        if (
          custody.policy_id !== local.custodyPolicyId ||
          custody.policy_sha256 !== local.custodyPolicySha256 ||
          custody.key_policy_sha256 !== local.keyPolicySha256
        )
          throw new DispatchRefused();
        row = rest;
      } else row = claimed.parse(data);
      if (
        row.tenant_id !== tenantId ||
        row.job_id !== jobId ||
        Date.parse(row.expires_at) <= Date.now()
      )
        throw new DispatchRefused();
      const context: DispatchContext = {
        jobId: row.job_id,
        tenantId: row.tenant_id,
        actorId: row.actor_id,
        workloadId: row.workload_id,
        estateId: row.estate_id,
        engagementId: row.engagement_id,
        correlationId: row.correlation_id,
        inputHash: row.input_hash,
      };
      const payload = await openDispatch(
        context,
        {
          key_ref: row.key_ref,
          nonce: row.nonce,
          ciphertext: row.ciphertext,
          wrapped_key: row.wrapped_key,
        },
        row.proof_hash,
        this.wrapper,
      );
      if (Date.parse(row.expires_at) <= Date.now()) throw new DispatchRefused();
      return Object.freeze({
        context,
        runId: row.run_id,
        expiresAt: Date.parse(row.expires_at),
        payload,
      });
    } catch {
      throw new DispatchRefused();
    }
  }
}
