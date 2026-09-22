import { z } from 'zod';
import { AgentName } from '@axiom/types';

export class AgentInvocationError extends Error {
  constructor(
    message = 'The agent outcome could not be confirmed. Check the run before retrying.',
  ) {
    super(message);
    this.name = 'AgentInvocationError';
  }
}

/** Presentation contract only. Authority, execution and scoring stay in BFF. */
export async function invokeAgent(agent: string, input: Record<string, unknown> = {}) {
  const name = z.nativeEnum(AgentName).parse(agent);
  const correlationId = crypto.randomUUID();
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(`/api/bff/v1/agents/${name}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, correlation_id: correlationId }),
      redirect: 'error',
    });
    body = await response.json();
  } catch {
    throw new AgentInvocationError();
  }
  if (!response.ok) {
    const error = z
      .object({ error: z.object({ message: z.string().min(1).max(500) }) })
      .safeParse(body);
    throw new AgentInvocationError(error.success ? error.data.error.message : undefined);
  }
  const parsed = z
    .object({
      agent: z.literal(name),
      correlation_id: z.literal(correlationId),
      status: z.literal('succeeded'),
      error: z.null(),
      output: z.record(z.string(), z.unknown()),
      latency_ms: z.number().int().nonnegative(),
      ledger_entry_ids: z
        .array(z.string().min(1).max(128))
        .min(2)
        .max(1000)
        .refine((ids) => new Set(ids).size === ids.length),
    })
    .safeParse(body);
  if (!parsed.success) throw new AgentInvocationError();
  return parsed.data;
}
