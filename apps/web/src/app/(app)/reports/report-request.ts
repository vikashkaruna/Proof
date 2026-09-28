import { z } from 'zod';

const errorSchema = z.object({ error: z.object({ code: z.string().max(100) }) });

/** No automatic mutation retries: an interrupted response can follow a committed write. */
export async function reportRequest(
  tenantId: string,
  path: string,
  options: { body?: unknown; signal?: AbortSignal } = {},
): Promise<Response> {
  const writing = options.body !== undefined;
  let response: Response;
  try {
    response = await fetch(`/api/bff/v1${path}`, {
      method: writing ? 'POST' : 'GET',
      cache: 'no-store',
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
      headers: {
        'x-tenant-id': tenantId,
        ...(writing
          ? { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }
          : {}),
      },
      ...(writing ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    throw new Error(
      writing
        ? 'The outcome is uncertain. Refresh the recorded state before trying again.'
        : 'Unable to load the recorded state. Retry when the connection is available.',
    );
  }
  if (!response.ok) {
    const parsed = errorSchema.safeParse(await response.json().catch(() => null));
    throw new Error(
      parsed.success ? parsed.data.error.code : `Request failed (${response.status}).`,
    );
  }
  return response;
}

const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    'Invalid UUID',
  );

const prepareSchema = z.object({
  operationKey: uuidSchema,
  title: z.string().trim().min(1).max(200),
  evidenceReceiptIds: z.array(uuidSchema).min(1).max(20),
  engagementId: uuidSchema.nullable(),
});

export function preparePackBody(
  form: FormData,
  receiptIds: readonly string[],
  operationKey: string,
) {
  if (form.get('confirmed') !== 'on')
    throw new Error('Review the selected evidence and authorize preparation.');
  if (new Set(receiptIds).size !== receiptIds.length)
    throw new Error('Choose each evidence version only once.');
  const parsed = prepareSchema.safeParse({
    operationKey,
    title: form.get('title'),
    evidenceReceiptIds: receiptIds,
    engagementId: String(form.get('engagementId') ?? '').trim() || null,
  });
  if (!parsed.success)
    throw new Error('Enter a title, select 1–20 verified versions and choose an engagement scope.');
  return parsed.data;
}

/** Bound the actual response stream before retaining or hashing an archive. */
export async function readReleasedArchive(
  response: Response,
  expectedSize: number,
  expectedHash: string,
) {
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 1 ||
    expectedSize > 64 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(expectedHash)
  )
    throw new Error('A valid archive release receipt is required.');
  if (!response.body) throw new Error('The archive response has no bytes.');
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Archive download timed out. No file was accepted.')),
      30_000,
    );
  });
  const bytes = new Uint8Array(expectedSize);
  let offset = 0;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      if (offset + next.value.length > expectedSize)
        throw new Error('Downloaded archive exceeds its recorded size.');
      bytes.set(next.value, offset);
      offset += next.value.length;
    }
    if (offset !== expectedSize)
      throw new Error('Downloaded archive size differs from its release receipt.');
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    if (digest !== expectedHash)
      throw new Error('Downloaded archive does not match its released SHA-256.');
    return new Blob([bytes], { type: 'application/zip' });
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}
