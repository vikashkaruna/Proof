import { createMiddleware } from 'hono/factory';

export const EVIDENCE_HTTP_MAX_BYTES = 12 * 1024 * 1024;
export const REPORT_HTTP_MAX_BYTES = 64 * 1024;

/** Count actual bytes before idempotency clones the upload; never trust a length header. */
export function boundedJsonBody(maxBytes: number) {
  return createMiddleware(async (c, next) => {
    if (c.req.method !== 'POST' || !c.req.raw.body) return next();
    const reader = c.req.raw.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('upload_timeout')), 30_000);
    });
    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), timeout]);
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          void reader.cancel().catch(() => {});
          return c.json({ error: { code: 'payload_too_large' } }, 413);
        }
        chunks.push(value);
      }
    } catch {
      void reader.cancel().catch(() => {});
      return c.json({ error: { code: 'upload_body_unavailable' } }, 408);
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    c.req.raw = new Request(c.req.raw, { body });
    return next();
  });
}
export const evidenceBodyLimit = boundedJsonBody(EVIDENCE_HTTP_MAX_BYTES);
const smallBodyLimit = boundedJsonBody(REPORT_HTTP_MAX_BYTES);
export const reportBodyLimit = createMiddleware(async (c, next) => {
  if (/^\/v1\/(?:evidence-packs|reports)(?:\/|$)/.test(c.req.path)) return smallBodyLimit(c, next);
  return next();
});
