import { z } from 'zod';
export async function readDataFlowJson(
  response: Response,
  maxBytes = 4 * 1024 * 1024,
): Promise<unknown> {
  if (
    !response.body ||
    !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')
  )
    throw new Error('A bounded JSON response is required.');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > maxBytes)) {
    await response.body.cancel();
    throw new Error('Data flow declaration response exceeds supported bounds.');
  }
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error('Data flow declaration response timed out. Keep the original request.')),
      30000,
    );
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes)
        throw new Error('Data flow declaration response exceeds supported bounds.');
      chunks.push(next.value);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined));
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}
export async function requestDataFlow(
  tenantId: string,
  actorId: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const writing = body !== undefined;
  const serialized = writing ? JSON.stringify(body) : undefined;
  if (serialized && new TextEncoder().encode(serialized).byteLength > 20000)
    throw new Error('Data flow declaration request exceeds supported bounds. Nothing was sent.');
  let response: Response;
  try {
    response = await fetch(`/api/bff/v1${path}`, {
      method: writing ? 'POST' : 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(120000),
      headers: {
        'x-tenant-id': z.uuid().parse(tenantId),
        'x-expected-actor-id': z.uuid().parse(actorId),
        ...(writing
          ? { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }
          : {}),
      },
      ...(serialized ? { body: serialized } : {}),
    });
  } catch {
    throw new Error(
      'Outcome uncertain. Keep the original request and reconcile its recorded state.',
    );
  }
  const value = await readDataFlowJson(response, response.ok ? 4 * 1024 * 1024 : 65536);
  if (!response.ok) {
    const code = z.object({ error: z.object({ code: z.string().max(100) }) }).safeParse(value);
    throw new Error(
      code.success
        ? ((
            {
              data_flow_unavailable:
                'Data flow declarations are disabled or unavailable in this deployment. No declaration or transfer authority is established.',
              data_flow_source_changed:
                'The current source or head version changed. Keep the exact original request and recover its receipt. Fence and archive it before preparing revised metadata.',
              data_flow_source_refused:
                'Current source or independent review authority was refused. Keep the original request and recover its receipt; no replacement authority is assumed.',
              data_flow_context_unavailable:
                'Current registered sources and authority could not be read. Preserve any original request and refresh before acting.',
              data_flow_operation_unconfirmed:
                'The declaration decision is unconfirmed. Preserve the exact original request and recover its receipt before another decision.',
              data_flow_mfa_refused:
                'Authenticator verification was refused. Keep the original request; verify its recorded state before retrying the same decision.',
            } as Record<string, string>
          )[code.data.error.code] ?? code.data.error.code)
        : 'Data flow declaration outcome unconfirmed. Keep the original request.',
    );
  }
  return value;
}
