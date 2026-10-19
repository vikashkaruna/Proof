/** Private, default-off BFF lifecycle consumer. Never holds a human bearer or
 * invokes an executor. SQL and current human-signed delegation remain authority. */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ApprovalEngine, type ApprovalTokenSpec } from '@axiom/approval-engine';
import {
  standingMeasuredSource,
  standingPolicyDelegation,
  encodeStandingPolicyDelegation,
} from '@axiom/types';
import { canonicalJson } from '@axiom/ledger';
const uuid = z.uuid();
const receipt = z
  .string()
  .refine((v) => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n);
export const standingWorkReference = z
  .object({ tenantId: uuid, workId: uuid, kind: z.enum(['seal', 'approval']) })
  .strict();
export type StandingWorkReference = z.infer<typeof standingWorkReference>;
export const standingWorkOutcome = standingWorkReference
  .extend({
    state: z.enum(['sealed', 'issued', 'refused', 'escalated', 'unconfirmed']),
    receiptId: receipt.nullable(),
    tokenId: uuid.nullable(),
  })
  .strict()
  .superRefine((v, c) => {
    if ((v.state === 'sealed' || v.state === 'issued') && !v.receiptId)
      c.addIssue({ code: 'custom', message: 'Original receipt required' });
    if ((v.state === 'issued') !== Boolean(v.tokenId))
      c.addIssue({ code: 'custom', message: 'Exact issued token required' });
  });
export type StandingWorkOutcome = z.infer<typeof standingWorkOutcome>;
const sealClaim = standingWorkReference
  .extend({
    kind: z.literal('seal'),
    state: z.literal('claimed'),
    delegation: standingPolicyDelegation,
  })
  .strict();
const approvalClaim = standingWorkReference
  .extend({
    kind: z.literal('approval'),
    state: z.literal('claimed'),
    delegation: standingPolicyDelegation,
    delegationSignature: z.string().regex(/^[a-f0-9]{64}$/),
    currentSource: standingMeasuredSource,
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
    tokenExpiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
const claim = z.union([sealClaim, approvalClaim, standingWorkOutcome]);
export interface StandingReadiness {
  /** Actual existing BR2 reader, checked again by the atomic issuer. No writes. */
  requireReady(
    tenantId: string,
    planId: string,
    actionId: string,
    signal?: AbortSignal,
  ): Promise<void>;
}
export class StandingReadinessRefused extends Error {}
export class StandingCoordinator {
  private active = false;
  private phase: 'idle' | 'running' | 'unconfirmed' | 'stopped' | 'unavailable' = 'idle';
  private checkedAt: string | null = null;
  constructor(
    private readonly db: SupabaseClient,
    private readonly engine: ApprovalEngine,
    private readonly readiness: StandingReadiness,
  ) {}
  health() {
    return {
      configured: true,
      phase: this.phase,
      checkedAt: this.checkedAt,
      scope: 'one_owned_synthetic_measured_action',
      executionEnabled: false,
    } as const;
  }
  private signal(caller?: AbortSignal) {
    const deadline = AbortSignal.timeout(5000);
    return caller ? AbortSignal.any([caller, deadline]) : deadline;
  }
  private outcome(raw: unknown, ref: StandingWorkReference) {
    const v = standingWorkOutcome.parse(raw);
    if (v.tenantId !== ref.tenantId || v.workId !== ref.workId || v.kind !== ref.kind)
      throw Error('Standing outcome binding refused');
    return v;
  }
  async reconcile(raw: unknown, signal?: AbortSignal): Promise<StandingWorkOutcome> {
    const ref = standingWorkReference.parse(raw);
    const { data, error } = await this.db
      .rpc('read_standing_policy_work', { p_tenant_id: ref.tenantId, p_work_id: ref.workId })
      .abortSignal(this.signal(signal));
    if (error) throw Error('Standing outcome unavailable');
    return this.outcome(data, ref);
  }
  async perform(raw: unknown, signal?: AbortSignal): Promise<StandingWorkOutcome> {
    const ref = standingWorkReference.parse(raw);
    const unknown: StandingWorkOutcome = {
      ...ref,
      state: 'unconfirmed',
      receiptId: null,
      tokenId: null,
    };
    if (signal?.aborted) return unknown;
    try {
      const saved = await this.db
        .rpc('claim_standing_policy_work', { p_tenant_id: ref.tenantId, p_work_id: ref.workId })
        .abortSignal(this.signal(signal));
      if (saved.error) return await this.reconcile(ref, signal);
      const current = claim.parse(saved.data);
      if (
        current.tenantId !== ref.tenantId ||
        current.workId !== ref.workId ||
        current.kind !== ref.kind
      )
        throw Error('Standing assignment refused');
      if (current.state !== 'claimed') return this.outcome(current, ref);
      if (signal?.aborted) return unknown;
      let write: Awaited<ReturnType<SupabaseClient['rpc']>>;
      if (current.kind === 'seal') {
        const signature = this.engine.signStandingDelegation(ref.tenantId, current.delegation);
        write = await this.db
          .rpc('seal_standing_policy_delegation', {
            p_tenant_id: ref.tenantId,
            p_work_id: ref.workId,
            p_signature: signature,
          })
          .abortSignal(this.signal(signal));
      } else {
        const d = current.delegation,
          source = d.request.source;
        if (!this.engine.verifyStandingDelegation(ref.tenantId, d, current.delegationSignature))
          return await this.refuse(ref, 'delegation_signature_refused', signal);
        if (canonicalJson(current.currentSource) !== canonicalJson(source))
          return await this.refuse(ref, 'source_changed', signal);
        try {
          await this.readiness.requireReady(
            ref.tenantId,
            source.planId,
            source.actionId,
            this.signal(signal),
          );
        } catch (error) {
          if (error instanceof StandingReadinessRefused)
            return await this.refuse(ref, 'br2_refused', signal);
          throw error;
        }
        if (signal?.aborted) return unknown;
        const spec: ApprovalTokenSpec = {
          planId: source.planId,
          actionIds: [source.actionId],
          approverId: d.request.reviewerId,
          mode: 'individual',
          concurrency: 1,
          stopOnFailure: true,
          expiresAt: current.tokenExpiresAt,
          nonce: current.nonce,
          contentDigest: source.contentDigest,
          conditions: {
            purpose: 'remediation_execution_v1',
            standingPolicy: {
              id: source.policyId,
              version: source.policyVersion,
              revisionId: d.revisionId,
              delegationSha256: createHash('sha256')
                .update(encodeStandingPolicyDelegation(d), 'utf8')
                .digest('hex'),
              ownerReceiptId: d.ownerDecision.receiptId,
              reviewerReceiptId: d.reviewerDecision.receiptId,
              fireId: ref.workId,
            },
          },
        };
        const signature = await this.engine.sign(ref.tenantId, spec);
        write = await this.db
          .rpc('issue_standing_policy_approval', {
            p_tenant_id: ref.tenantId,
            p_work_id: ref.workId,
            p_signature: signature,
            p_signed_payload: spec,
          })
          .abortSignal(this.signal(signal));
      }
      if (write.error) return await this.reconcile(ref, signal);
      return this.outcome(write.data, ref);
    } catch {
      return unknown;
    }
  }
  private async refuse(
    ref: StandingWorkReference,
    code: 'delegation_signature_refused' | 'source_changed' | 'br2_refused',
    signal?: AbortSignal,
  ) {
    const { data, error } = await this.db
      .rpc('refuse_standing_policy_work', {
        p_tenant_id: ref.tenantId,
        p_work_id: ref.workId,
        p_reason: code,
      })
      .abortSignal(this.signal(signal));
    if (error) return this.reconcile(ref, signal);
    return this.outcome(data, ref);
  }
  async once(signal?: AbortSignal) {
    if (this.active) throw Error('Standing consumer busy');
    this.active = true;
    this.phase = 'running';
    try {
      if (signal?.aborted) return;
      const { data, error } = await this.db
        .rpc('reserve_standing_policy_work', {})
        .abortSignal(this.signal(signal));
      if (error) throw Error('Standing queue unavailable');
      const list = z
        .object({ work: z.array(standingWorkReference).max(1) })
        .strict()
        .parse(data);
      if (list.work[0]) {
        const outcome = await this.perform(list.work[0], signal);
        this.phase = outcome.state === 'unconfirmed' ? 'unconfirmed' : 'idle';
      } else this.phase = 'idle';
    } catch {
      this.phase = 'unavailable';
    } finally {
      this.checkedAt = new Date().toISOString();
      this.active = false;
    }
  }
  async run(signal: AbortSignal) {
    while (!signal.aborted) {
      await this.once(signal);
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
}
