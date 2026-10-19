/** Fixed reference-only producer path for newly authorized scheduled coverage.
 * No human writer, browser-selected actor/input, model call or connector secret. */
import { createHash, randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import {
  coverageFireReference,
  coverageFireOutcome,
  coverageProducerAssignment,
  type CoverageFireReference,
  type CoverageFireOutcome,
} from '@axiom/types';
import { sealDispatch, type DispatchKeyWrapper } from './dispatch-payload.js';
import { TaskProof } from './tasks.js';
import { localCustodyPinsSchema, type LocalCustodyPins } from './assessment-dispatch.js';
const assignment = z.union([coverageProducerAssignment, coverageFireOutcome]);
export interface CoverageProducerBinding {
  tenantId: string;
  workloadId: string;
  custody: LocalCustodyPins;
  wrapper: Pick<DispatchKeyWrapper, 'wrap'>;
}
export class ScheduledCoverageProducer {
  readonly #bindings = new Map<string, CoverageProducerBinding>();
  constructor(
    private readonly db: SupabaseClient,
    bindings: readonly CoverageProducerBinding[],
  ) {
    if (!bindings.length || bindings.length > 100)
      throw Error('Scheduled coverage configuration refused');
    for (const b of bindings) {
      const t = z.uuid().parse(b.tenantId).toLowerCase();
      if (this.#bindings.has(t)) throw Error('Scheduled coverage configuration refused');
      this.#bindings.set(t, {
        ...b,
        tenantId: t,
        workloadId: z.uuid().parse(b.workloadId).toLowerCase(),
        custody: localCustodyPinsSchema.parse(b.custody),
      });
    }
  }
  private tenant(raw: string) {
    const t = z.uuid().parse(raw).toLowerCase();
    if (!this.#bindings.has(t)) throw Error('Scheduled coverage tenant unavailable');
    return t;
  }
  private reference(raw: unknown) {
    const ref = coverageFireReference.parse(raw);
    this.tenant(ref.tenantId);
    return ref;
  }
  private signal(signal?: AbortSignal) {
    const deadline = AbortSignal.timeout(5000);
    return signal ? AbortSignal.any([signal, deadline]) : deadline;
  }
  private outcome(raw: unknown, ref: CoverageFireReference) {
    const value = coverageFireOutcome.parse(raw);
    if (value.tenantId !== ref.tenantId || value.fireId !== ref.fireId)
      throw Error('Scheduled coverage receipt binding refused');
    return value;
  }
  private phase: 'idle' | 'running' | 'unconfirmed' | 'unavailable' | 'stopped' = 'idle';
  private checkedAt: string | null = null;
  health() {
    return {
      configured: true,
      phase: this.phase,
      checkedAt: this.checkedAt,
      declarationPolicy: 'all_business_facts_unknown',
      executionEnabled: false,
    } as const;
  }
  async run(signal: AbortSignal) {
    while (!signal.aborted) {
      this.phase = 'running';
      for (const tenantId of this.#bindings.keys()) {
        if (signal.aborted) break;
        try {
          const next = await this.reserve(tenantId, signal);
          const ref = next.fires[0];
          if (ref) {
            const outcome = await this.request(ref, signal);
            this.phase = ['unconfirmed', 'handed_off'].includes(outcome.state)
              ? 'unconfirmed'
              : 'idle';
          } else this.phase = 'idle';
        } catch {
          this.phase = 'unavailable';
        }
        this.checkedAt = new Date().toISOString();
      }
      if (signal.aborted) break;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, 10000);
        signal.addEventListener('abort', done, { once: true });
      });
    }
    this.phase = 'stopped';
  }
  async reserve(tenantId: string, signal?: AbortSignal) {
    const t = this.tenant(tenantId);
    if (signal?.aborted) throw Error('Scheduled coverage interrupted');
    const result = await this.db
      .rpc('reserve_scheduled_coverage_fire', { p_tenant_id: t })
      .abortSignal(this.signal(signal));
    if (result.error) throw Error('Scheduled coverage queue unavailable');
    const parsed = z
      .object({ fires: z.array(coverageFireReference).max(1) })
      .strict()
      .parse(result.data);
    for (const ref of parsed.fires)
      if (ref.tenantId !== t) throw Error('Scheduled coverage queue binding refused');
    return parsed;
  }
  async reconcile(raw: unknown, signal?: AbortSignal): Promise<CoverageFireOutcome> {
    const ref = this.reference(raw);
    const result = await this.db
      .rpc('read_scheduled_coverage_fire', { p_tenant_id: ref.tenantId, p_fire_id: ref.fireId })
      .abortSignal(this.signal(signal));
    if (result.error) throw Error('Scheduled coverage outcome unavailable');
    return this.outcome(result.data, ref);
  }
  async request(raw: unknown, signal?: AbortSignal): Promise<CoverageFireOutcome> {
    const ref = this.reference(raw);
    if (signal?.aborted) throw Error('Scheduled coverage interrupted');
    try {
      const claim = await this.db
        .rpc('claim_scheduled_coverage_fire', { p_tenant_id: ref.tenantId, p_fire_id: ref.fireId })
        .abortSignal(this.signal(signal));
      if (claim.error) return await this.reconcile(ref, signal);
      const current = assignment.parse(claim.data);
      if (current.tenantId !== ref.tenantId || current.fireId !== ref.fireId)
        throw Error('Scheduled coverage assignment refused');
      if (current.state !== 'runnable') return this.outcome(current, ref);
      const binding = this.#bindings.get(ref.tenantId)!;
      if (
        current.source.workloadId !== binding.workloadId ||
        current.source.custodyPolicyId !== binding.custody.custodyPolicyId ||
        current.source.custodyPolicySha256 !== binding.custody.custodyPolicySha256 ||
        current.source.keyPolicySha256 !== binding.custody.keyPolicySha256 ||
        current.source.custodyActivationEventId !== binding.custody.activationEventId ||
        current.source.custodyEpoch !== binding.custody.activationEpoch ||
        current.source.deploymentBindingSha256 !== binding.custody.deploymentBindingSha256
      )
        throw Error('Scheduled coverage deployment changed');
      const input = canonicalJson({
        tenant_id: ref.tenantId,
        engagement_id: current.engagementId,
        library_version: current.source.catalogue.libraryVersion,
        answers: {},
        sdf_self_attested: null,
        processes_children: null,
        processes_health: null,
      });
      if (
        input !== current.inputText ||
        createHash('sha256').update(input, 'utf8').digest('hex') !== current.inputSha256 ||
        Date.parse(current.expiresAt) <= Date.now()
      )
        throw Error('Unknown-only scheduled input refused');
      if (signal?.aborted) return await this.reconcile(ref, signal);
      const proof = new TaskProof(randomBytes(32).toString('base64url'));
      const context = {
        jobId: current.jobId,
        tenantId: ref.tenantId,
        actorId: current.ownerId,
        workloadId: binding.workloadId,
        estateId: current.source.estateId,
        engagementId: current.engagementId,
        correlationId: current.jobId,
        inputHash: current.inputSha256,
      };
      const wrapOnly: DispatchKeyWrapper = {
        wrap: (...args) => binding.wrapper.wrap(...args),
        unwrap: async () => {
          throw Error('Producer cannot unwrap');
        },
      };
      const sealed = await sealDispatch(context, input, proof, wrapOnly);
      if (signal?.aborted) return await this.reconcile(ref, signal);
      const result = await this.db
        .rpc('enqueue_scheduled_coverage_dispatch', {
          p_tenant_id: ref.tenantId,
          p_fire_id: ref.fireId,
          p_proof_hash: createHash('sha256').update(proof.reveal(), 'ascii').digest('hex'),
          p_key_ref: sealed.key_ref,
          p_nonce: '\\x' + sealed.nonce,
          p_ciphertext: '\\x' + sealed.ciphertext,
          p_wrapped_key: '\\x' + sealed.wrapped_key,
        })
        .abortSignal(this.signal(signal));
      if (result.error) return await this.reconcile(ref, signal);
      const outcome = this.outcome(result.data, ref);
      if (outcome.engagementId !== current.engagementId || outcome.jobId !== current.jobId)
        throw Error('Scheduled coverage original job changed');
      return outcome;
    } catch {
      // A claim, key wrapping or atomic write may have completed. Read only;
      // never re-claim, re-wrap, issue a new key/job or retry a mutation here.
      return this.reconcile(ref, signal);
    }
  }
}
