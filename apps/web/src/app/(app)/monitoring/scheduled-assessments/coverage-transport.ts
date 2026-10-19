import { z } from 'zod';
export async function readCoverageJson(
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
    throw new Error('Scheduled coverage response exceeds supported bounds.');
  }
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Scheduled coverage response timed out. Keep the original request.')),
      30000,
    );
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes)
        throw new Error('Scheduled coverage response exceeds supported bounds.');
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
export async function requestCoverage(
  tenantId: string,
  actorId: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const writing = body !== undefined;
  const serialized = writing ? JSON.stringify(body) : undefined;
  if (serialized && new TextEncoder().encode(serialized).byteLength > 16384)
    throw new Error('Scheduled coverage request exceeds supported bounds. Nothing was sent.');
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
  const value = await readCoverageJson(response, response.ok ? 1024 * 1024 : 65536);
  if (!response.ok) {
    const code = z.object({ error: z.object({ code: z.string().max(100) }) }).safeParse(value);
    throw new Error(
      code.success
        ? ((
            {
              coverage_approval_unavailable:
                'Scheduled assessment delegation is disabled or unavailable in this deployment. No new assessment authority is established.',
              coverage_producer_unavailable:
                'The private scheduled-assessment producer is unavailable. Recorded history does not establish runtime readiness. Preserve any original request.',
              coverage_approval_context_unavailable:
                'Current eligible sources and scope history could not be read. Preserve any original request and refresh before acting.',
              coverage_operation_unconfirmed:
                'The scheduled-assessment decision is unconfirmed. Preserve the exact original request and recover its receipt before another decision.',
              current_owner_required:
                'Only the current organization owner may authorize or revoke this assessment scope. Preserve any original request.',
              current_actor_session_required:
                'The current owner session could not be confirmed. Preserve the original request and restore the same authorized account and organization.',
              coverage_mfa_refused:
                'Authenticator verification was refused. Keep the original request and recover its recorded state before retrying the same decision.',
              coverage_mfa_required:
                'The original phase-bound authenticator challenge is required. Preserve and recover the original request.',
              coverage_mfa_unavailable:
                'A fresh authenticator challenge is unavailable. Preserve the original request and recover its recorded state.',
              invalid_request:
                'The scheduled-assessment request was refused. Preserve the original intent; do not replace an uncertain operation.',
            } as Record<string, string>
          )[code.data.error.code] ?? code.data.error.code)
        : 'Scheduled coverage outcome unconfirmed. Keep the original request.',
    );
  }
  return value;
}
