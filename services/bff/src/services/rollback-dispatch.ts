import { z } from 'zod';

export interface RollbackDispatchOutcome {
  status: 'accepted' | 'failed' | 'unknown';
  error: string | null;
  /** Per-action recorded outcomes from the runtime's acknowledgement. */
  outcomes: Array<{ actionId: string; outcome: string; errorCode: string | null }> | null;
}

const RollbackAcknowledgement = z.object({
  accepted: z.boolean(),
  contract_version: z.literal(1),
  correlation_id: z.string(),
  batch: z
    .object({ id: z.string().min(1) })
    .passthrough()
    .optional(),
  // The executor answers with the per-action outcome the rollback machinery
  // recorded: the action rows moved (or were refused) before it replied.
  outcomes: z
    .array(
      z.object({
        action_id: z.string().uuid(),
        outcome: z.enum(['rolled_back', 'failed', 'skipped']),
        error_code: z.string().nullable(),
      }),
    )
    .max(100)
    .optional(),
});

/** A missing/malformed acknowledgement says nothing about whether the undo ran. */
export async function dispatchRollback(
  runtimeUrl: string | undefined,
  internalToken: string,
  payload: { correlation_id: string } & Record<string, unknown>,
): Promise<RollbackDispatchOutcome> {
  if (!runtimeUrl) {
    return {
      status: 'failed',
      error: 'AGENT_RUNTIME_URL is not configured',
      outcomes: null,
    };
  }
  try {
    const response = await fetch(`${runtimeUrl}/internal/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': internalToken },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    const parsed = RollbackAcknowledgement.safeParse(await response.json().catch(() => null));
    if (parsed.success && parsed.data.correlation_id === payload.correlation_id) {
      if (parsed.data.accepted === false) {
        return {
          status: 'failed',
          error: `runtime refused dispatch (${response.status})`,
          outcomes: null,
        };
      }
      if (response.ok && parsed.data.batch?.id) {
        return {
          status: 'accepted',
          error: null,
          outcomes:
            parsed.data.outcomes?.map((o) => ({
              actionId: o.action_id,
              outcome: o.outcome,
              errorCode: o.error_code,
            })) ?? null,
        };
      }
    }
    return {
      status: 'unknown',
      error: `unconfirmed runtime acknowledgement (${response.status})`,
      outcomes: null,
    };
  } catch {
    // Do not persist arbitrary upstream errors: they may include credentials
    // or personal data. Reconcile using the correlation id.
    return {
      status: 'unknown',
      error: 'runtime acknowledgement unavailable',
      outcomes: null,
    };
  }
}
