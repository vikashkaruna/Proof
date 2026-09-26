import { z } from 'zod';

export interface DispatchOutcome {
  status: 'accepted' | 'failed' | 'unknown';
  reference: string | null;
  error: string | null;
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
});

/** A missing/malformed acknowledgement says nothing about whether work started. */
export async function dispatchExecution(
  runtimeUrl: string | undefined,
  internalToken: string,
  payload: { correlation_id: string } & Record<string, unknown>,
): Promise<DispatchOutcome> {
  if (!runtimeUrl) {
    return { status: 'failed', reference: null, error: 'AGENT_RUNTIME_URL is not configured' };
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
        };
      }
      if (response.ok && (parsed.data.reference || parsed.data.batch?.id)) {
        return {
          status: 'accepted',
          reference: parsed.data.reference ?? parsed.data.batch!.id,
          error: null,
        };
      }
    }
    return {
      status: 'unknown',
      reference: null,
      error: `unconfirmed runtime acknowledgement (${response.status})`,
    };
  } catch {
    // Do not persist arbitrary upstream errors: they may include credentials
    // or personal data. Reconcile using the correlation id and request key.
    return { status: 'unknown', reference: null, error: 'runtime acknowledgement unavailable' };
  }
}
