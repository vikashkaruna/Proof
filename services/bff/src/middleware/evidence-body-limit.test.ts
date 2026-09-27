import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { evidenceBodyLimit, EVIDENCE_HTTP_MAX_BYTES } from './evidence-body-limit.js';

function app() {
  const instance = new Hono();
  instance.use('/upload', evidenceBodyLimit);
  instance.post('/upload', async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
  return instance;
}

describe('bounded evidence request body before idempotency', () => {
  it('rejects actual bytes exceeding the bound despite a forged small length', async () => {
    const res = await app().request('/upload', {
      method: 'POST',
      headers: { 'content-length': '1' },
      body: new Uint8Array(EVIDENCE_HTTP_MAX_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: { code: 'payload_too_large' } });
  });
  it('preserves bounded bytes for downstream consumers', async () => {
    const res = await app().request('/upload', { method: 'POST', body: 'abc' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bytes: 3 });
  });
  it('rejects a chunked body once cumulative bytes exceed the bound', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(EVIDENCE_HTTP_MAX_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const req = new Request('http://localhost/upload', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit);
    expect((await app().fetch(req)).status).toBe(413);
  });
});
