import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

export const retentionReceipt = z.discriminatedUnion('status', [
  z.object({ status: z.literal('idle') }).strict(),
  z.object({ status: z.literal('review'), tenantId: z.uuid(), jobId: z.uuid() }).strict(),
  z
    .object({
      status: z.literal('purged'),
      tenantId: z.uuid(),
      jobId: z.uuid(),
      receipt: z.string().regex(/^[1-9][0-9]*$/),
      purgedAt: z.iso.datetime({ offset: true }),
      retentionDays: z.number().int().min(1).max(36500),
    })
    .strict(),
]);
export type RetentionReceipt = z.infer<typeof retentionReceipt>;

/** Backend maintenance only. No caller-controlled clock, browser route or
 * scheduler credential. A lost reply is uncertain; SQL receipts are durable. */
export class AssessmentRetention {
  readonly #days: number;
  readonly #tenant: string | null;
  constructor(
    private readonly db: SupabaseClient,
    options: { retentionDays: number; tenantId?: string },
  ) {
    this.#days = z.number().int().min(1).max(36500).parse(options.retentionDays);
    this.#tenant = options.tenantId ? z.uuid().parse(options.tenantId).toLowerCase() : null;
  }
  async purgeNext(): Promise<RetentionReceipt> {
    try {
      const { data, error } = await this.db
        .rpc('purge_next_assessment_dispatch_payload', {
          p_retention_days: this.#days,
          p_tenant_id: this.#tenant,
        })
        .abortSignal(AbortSignal.timeout(10000));
      if (error) throw new Error();
      const result = retentionReceipt.parse(data);
      if (
        (result.status !== 'idle' && this.#tenant && result.tenantId !== this.#tenant) ||
        (result.status === 'purged' && result.retentionDays !== this.#days)
      )
        throw new Error();
      return result;
    } catch {
      throw new Error(
        'Assessment retention unavailable; inspect durable receipts before retrying.',
      );
    }
  }
}
