import { prepareReportOperationKey } from '../report-request';
import { z } from 'zod';
export async function readDraftJson(
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
    throw new Error('Draft response exceeds supported bounds.');
  }
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Draft response timed out. Keep the original request.')),
      30000,
    );
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error('Draft response exceeds supported bounds.');
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
export async function requestDraft(
  tenantId: string,
  actorId: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const writing = body !== undefined;
  const serialized = writing ? JSON.stringify(body) : undefined;
  if (serialized && new TextEncoder().encode(serialized).byteLength > 16384)
    throw new Error('Draft request exceeds supported bounds. Nothing was sent.');
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
          ? { 'content-type': 'application/json', 'idempotency-key': prepareReportOperationKey() }
          : {}),
      },
      ...(serialized ? { body: serialized } : {}),
    });
  } catch {
    throw new Error(
      'Outcome uncertain. Keep the original request and reconcile its recorded state.',
    );
  }
  const value = await readDraftJson(response, response.ok ? 4 * 1024 * 1024 : 65536);
  if (!response.ok) {
    const code = z.object({ error: z.object({ code: z.string().max(100) }) }).safeParse(value);
    throw new Error(
      code.success ? code.data.error.code : 'Draft outcome unconfirmed. Keep the original request.',
    );
  }
  return value;
}
