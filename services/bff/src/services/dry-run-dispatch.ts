import { z } from 'zod';

/**
 * W5 · M3.2 — dispatch one dry-run to the agent runtime.
 *
 * Same discipline as execution-dispatch: a missing or malformed
 * acknowledgement says nothing about whether the run was recorded, and the
 * runtime records through `record_dry_run` (migration 0060) before it
 * returns, so any answer here describes recorded state or recorded refusal —
 * never a diff only the runtime holds.
 */

export interface DryRunDispatchOutcome {
  status: 'recorded' | 'refused' | 'unavailable';
  /** The recorded dry-run id, when the runtime recorded one. */
  dryRunId: string | null;
  /** 'succeeded' | 'refused' | 'failed' — the recorded outcome. */
  outcome: string | null;
  refusalReason: string | null;
  error: string | null;
}

const Recorded = z.object({
  accepted: z.literal(true),
  contract_version: z.literal(1),
  correlation_id: z.string(),
  dry_run: z
    .object({
      id: z.string(),
      status: z.enum(['succeeded', 'refused', 'failed']),
      renderable: z.boolean(),
      refusalReason: z.string().nullable(),
      expiresAt: z.string(),
      createdAt: z.string(),
    })
    .passthrough(),
});

const Refused = z.object({
  accepted: z.literal(false),
  reason: z.string().min(1).max(80),
});

export async function dispatchDryRun(
  runtimeUrl: string | undefined,
  internalToken: string,
  payload: { correlation_id: string } & Record<string, unknown>,
): Promise<DryRunDispatchOutcome> {
  if (!runtimeUrl) {
    return {
      status: 'unavailable',
      dryRunId: null,
      outcome: null,
      refusalReason: null,
      error: 'AGENT_RUNTIME_URL is not configured',
    };
  }
  try {
    const response = await fetch(`${runtimeUrl}/internal/dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': internalToken },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await response.json().catch(() => null);
    if (response.ok) {
      const parsed = Recorded.safeParse(json);
      if (parsed.success && parsed.data.correlation_id === payload.correlation_id) {
        return {
          status: 'recorded',
          dryRunId: parsed.data.dry_run.id,
          outcome: parsed.data.dry_run.status,
          refusalReason: parsed.data.dry_run.refusalReason,
          error: null,
        };
      }
      return {
        status: 'unavailable',
        dryRunId: null,
        outcome: null,
        refusalReason: null,
        error: `unconfirmed runtime acknowledgement (${response.status})`,
      };
    }
    const refused = Refused.safeParse(json);
    if (refused.success) {
      return {
        status: 'refused',
        dryRunId: null,
        outcome: null,
        refusalReason: refused.data.reason,
        error: null,
      };
    }
    return {
      status: 'unavailable',
      dryRunId: null,
      outcome: null,
      refusalReason: null,
      error: `unrecognised runtime refusal (${response.status})`,
    };
  } catch {
    // Do not persist arbitrary upstream errors: they may include credentials
    // or personal data. The action's dry-run state simply stays unchanged.
    return {
      status: 'unavailable',
      dryRunId: null,
      outcome: null,
      refusalReason: null,
      error: 'runtime acknowledgement unavailable',
    };
  }
}
