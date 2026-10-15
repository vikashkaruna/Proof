import { z } from 'zod';
import { AgentName } from '@axiom/types';
import { generateUUID } from '@axiom/ui';

export class AgentInvocationError extends Error {
  constructor(
    message = 'The agent outcome could not be confirmed. Check the run before retrying.',
  ) {
    super(message);
    this.name = 'AgentInvocationError';
  }
}

/** Presentation contract only. Authority, execution and scoring stay in BFF. */
export async function invokeAgent(
  agent: string,
  tenantId: string,
  input: Record<string, unknown> = {},
) {
  const name = z.nativeEnum(AgentName).parse(agent);
  let correlationId: string;
  let requestText: string;
  let boundTenantId: string;
  try {
    boundTenantId = z.uuid().parse(tenantId).toLowerCase();
    for (const key of ['tenant_id', 'tenantId'] as const) {
      if (input[key] !== undefined && z.uuid().parse(input[key]).toLowerCase() !== boundTenantId)
        throw new Error('Tenant binding mismatch');
    }
    correlationId = generateUUID();
    requestText = JSON.stringify({
      ...input,
      tenant_id: boundTenantId,
      correlation_id: correlationId,
    });
  } catch {
    throw new AgentInvocationError('The agent request could not be prepared. Nothing was sent.');
  }
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(`/api/bff/v1/agents/${name}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': boundTenantId },
      body: requestText,
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
