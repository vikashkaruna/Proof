import { z } from 'zod';
export async function readStandingJson(
  response: Response,
  maxBytes = 1024 * 1024,
): Promise<unknown> {
  if (
    !response.body ||
    !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')
  )
    throw new Error('A bounded JSON response is required.');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > maxBytes)) {
    await response.body.cancel();
    throw new Error('Standing approval response exceeds supported bounds.');
  }
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Standing approval response timed out. Keep the original request.')),
      30000,
    );
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error('Standing approval response exceeds supported bounds.');
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
export async function requestStanding(
  tenantId: string,
  actorId: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const writing = body !== undefined;
  const serialized = writing ? JSON.stringify(body) : undefined;
  if (serialized && new TextEncoder().encode(serialized).byteLength > 16384)
    throw new Error('Standing approval request exceeds supported bounds. Nothing was sent.');
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
  const value = await readStandingJson(response, response.ok ? 1024 * 1024 : 65536);
  if (!response.ok) {
    const code = z.object({ error: z.object({ code: z.string().max(100) }) }).safeParse(value);
    throw new Error(
      code.success
        ? ((
            {
              standing_approval_unavailable:
                'Standing approval delegation is disabled or unavailable in this deployment. No coordinator readiness or authority is established; existing approvals remain separate.',
              standing_approval_context_unavailable:
                'Current measured scopes and authority could not be read. Preserve any original request and refresh before acting.',
              standing_operation_unconfirmed:
                'The standing decision is unconfirmed. Preserve the exact original request and recover its receipt before another decision.',
              standing_mfa_refused:
                'Authenticator verification was refused. Keep the original request; verify its recorded state before retrying the same decision.',
            } as Record<string, string>
          )[code.data.error.code] ?? code.data.error.code)
        : 'Standing approval outcome unconfirmed. Keep the original request.',
    );
  }
  return value;
}
