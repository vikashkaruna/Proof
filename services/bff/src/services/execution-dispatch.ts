import { z } from 'zod';

export interface DispatchOutcome {
  status: 'accepted' | 'failed' | 'unknown';
  reference: string | null;
  error: string | null;
  /** W5.7 — per-action recorded outcomes from the executor's acknowledgement. */
  outcomes: Array<{ actionId: string; outcome: string; errorCode: string | null }> | null;
}

const Acknowledgement = z.object({
  accepted: z.boolean(),
  contract_version: z.literal(2),
  correlation_id: z.string(),
  reference: z.string().min(1).optional(),
  // The executor answers with the recorded batch, whose id is the durable
  // reference the outbox records.
  batch: z
    .object({ id: z.string().min(1) })
    .passthrough()
    .optional(),
  // W5.7 — the recorded per-action outcomes, as reported by the executor
  // after the batch reached its terminal status.
  outcomes: z
    .array(
      z.object({
        action_id: z.string().uuid(),
        outcome: z.enum(['succeeded', 'failed', 'skipped', 'rolled_back']),
        error_code: z.string().nullable(),
      }),
    )
    .max(100)
    .optional(),
});

/** A missing/malformed acknowledgement says nothing about whether work started. */
export async function dispatchExecution(
  runtimeUrl: string | undefined,
  internalToken: string,
  payload: { correlation_id: string } & Record<string, unknown>,
): Promise<DispatchOutcome> {
  if (!runtimeUrl) {
    return {
      status: 'failed',
      reference: null,
      error: 'AGENT_RUNTIME_URL is not configured',
      outcomes: null,
    };
  }
  try {
    const response = await fetch(`${runtimeUrl}/internal/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': internalToken },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    const parsed = Acknowledgement.safeParse(await response.json().catch(() => null));
    if (parsed.success && parsed.data.correlation_id === payload.correlation_id) {
      if (parsed.data.accepted === false) {
        return {
          status: 'failed',
          reference: null,
          error: `runtime refused dispatch (${response.status})`,
          outcomes: null,
        };
      }
      if (response.ok && (parsed.data.reference || parsed.data.batch?.id)) {
        return {
          status: 'accepted',
          reference: parsed.data.reference ?? parsed.data.batch!.id,
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
      reference: null,
      error: `unconfirmed runtime acknowledgement (${response.status})`,
      outcomes: null,
    };
  } catch {
    // Do not persist arbitrary upstream errors: they may include credentials
    // or personal data. Reconcile using the correlation id and request key.
    return {
      status: 'unknown',
      reference: null,
      error: 'runtime acknowledgement unavailable',
      outcomes: null,
    };
  }
}
