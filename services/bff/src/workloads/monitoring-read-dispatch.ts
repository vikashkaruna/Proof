import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { discoveryOutcome, type DiscoveryOutcome } from './discovery-channel.js';

export const scheduledReadReference = z.object({ tenantId: z.uuid(), fireId: z.uuid() }).strict();
export const scheduledReadOutcome = scheduledReadReference
  .extend({
    state: z.enum(['confirmed', 'unconfirmed', 'refused']),
    cleanupConfirmed: z.boolean().nullable(),
    receiptId: z
      .string()
      .refine((s) => /^[1-9][0-9]{0,18}$/.test(s) && BigInt(s) <= 9223372036854775807n)
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state === 'confirmed' && (!value.cleanupConfirmed || !value.receiptId))
      context.addIssue({ code: 'custom', message: 'Confirmed supervised receipt required' });
  });
const assignment = scheduledReadReference
  .extend({
    state: z.literal('runnable'),
    requestId: z.uuid(),
  })
  .strict();
const claimResult = z.union([assignment, scheduledReadOutcome]);
export type ScheduledReadReference = z.infer<typeof scheduledReadReference>;
export type ScheduledReadOutcome = z.infer<typeof scheduledReadOutcome>;
/** Only the configured tenant's scoped backend credential is accepted in SQL.
 * The scheduler receives references, never a human identity or connector secret.
 * A lost handoff is reconciled, never relaunched from an optimistic timeout. */
export class MonitoringReadDispatch {
  readonly tenantId: string;
  constructor(
    private readonly db: SupabaseClient,
    tenantId: string,
    private readonly discovery: {
      run(tenantId: string, requestId: string): Promise<DiscoveryOutcome>;
    },
    private readonly requireCurrentIdentity: () => Promise<void>,
  ) {
    this.tenantId = z.uuid().parse(tenantId).toLowerCase();
  }
  private reference(raw: unknown) {
    const value = scheduledReadReference.parse(raw);
    if (value.tenantId.toLowerCase() !== this.tenantId) throw new Error('Scheduled read refused');
    return { ...value, tenantId: this.tenantId, fireId: value.fireId.toLowerCase() };
  }
  private outcome(raw: unknown, reference: ScheduledReadReference) {
    const value = scheduledReadOutcome.parse(raw);
    if (value.tenantId !== reference.tenantId || value.fireId !== reference.fireId)
      throw new Error('Scheduled read receipt refused');
    return value;
  }
  private rpcSignal(signal?: AbortSignal) {
    const deadline = AbortSignal.timeout(5000);
    return signal ? AbortSignal.any([deadline, signal]) : deadline;
  }
  async reserve(signal?: AbortSignal) {
    await this.requireCurrentIdentity();
    const { data, error } = await this.db
      .rpc('reserve_monitoring_read_dispatch', {
        p_tenant_id: this.tenantId,
      })
      .abortSignal(this.rpcSignal(signal));
    if (error) throw new Error('Scheduled read queue unavailable');
    const result = z
      .object({ fires: z.array(scheduledReadReference).max(1) })
      .strict()
      .parse(data);
    for (const reference of result.fires) this.reference(reference);
    return result;
  }
  async reconcile(raw: unknown, signal?: AbortSignal): Promise<ScheduledReadOutcome> {
    const reference = this.reference(raw);
    await this.requireCurrentIdentity();
    const { data, error } = await this.db
      .rpc('read_monitoring_read_dispatch', {
        p_tenant_id: reference.tenantId,
        p_fire_id: reference.fireId,
      })
      .abortSignal(this.rpcSignal(signal));
    if (error) throw new Error('Scheduled read outcome unavailable');
    return this.outcome(data, reference);
  }
  async run(raw: unknown, signal?: AbortSignal): Promise<ScheduledReadOutcome> {
    const reference = this.reference(raw);
    const unknown: ScheduledReadOutcome = {
      ...reference,
      state: 'unconfirmed',
      cleanupConfirmed: null,
      receiptId: null,
    };
    if (signal?.aborted) return unknown;
    try {
      await this.requireCurrentIdentity();
      const { data, error } = await this.db
        .rpc('claim_monitoring_read_dispatch', {
          p_tenant_id: reference.tenantId,
          p_fire_id: reference.fireId,
        })
        .abortSignal(this.rpcSignal(signal));
      if (error) return await this.reconcile(reference, signal);
      const claimed = claimResult.parse(data);
      if (claimed.tenantId !== reference.tenantId || claimed.fireId !== reference.fireId)
        throw new Error('Scheduled read assignment refused');
      if (claimed.state !== 'runnable') return this.outcome(claimed, reference);
      await this.requireCurrentIdentity();
      let result: DiscoveryOutcome = { workerStatus: 'unconfirmed', cleanupConfirmed: false };
      if (!signal?.aborted) {
        try {
          result = discoveryOutcome.parse(
            await this.discovery.run(reference.tenantId, claimed.requestId),
          );
        } catch {
          /* Preserve the one-shot claim and record uncertainty. */
        }
      }
      await this.requireCurrentIdentity();
      const settled = await this.db
        .rpc('settle_monitoring_read_dispatch', {
          p_tenant_id: reference.tenantId,
          p_fire_id: reference.fireId,
          p_request_id: claimed.requestId,
          p_worker_status: result.workerStatus,
          p_cleanup_confirmed: result.cleanupConfirmed,
        })
        .abortSignal(this.rpcSignal(signal));
      if (settled.error) return await this.reconcile(reference, signal);
      return this.outcome(settled.data, reference);
    } catch {
      return unknown;
    }
  }
}
