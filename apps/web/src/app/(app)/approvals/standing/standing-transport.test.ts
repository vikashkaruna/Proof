import { afterEach, expect, it, vi } from 'vitest';
import { readStandingJson, requestStanding } from './standing-transport';
afterEach(() => vi.unstubAllGlobals());
it('bounds streamed JSON before parsing, including unknown content length', async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(' '.repeat(30)));
    },
    cancel,
  });
  await expect(
    readStandingJson(new Response(stream, { headers: { 'content-type': 'application/json' } }), 20),
  ).rejects.toThrow(/bounds/);
  expect(cancel).toHaveBeenCalled();
});
it('bounds error response streams before parsing server error JSON', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(' '.repeat(65537), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
  await expect(
    requestStanding(
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
      '/standing-approvals/recover',
    ),
  ).rejects.toThrow(/bounds/);
});
it('refuses malformed UTF8 and non-JSON responses safely', async () => {
  await expect(
    readStandingJson(
      new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }),
    ),
  ).rejects.toThrow();
  await expect(readStandingJson(new Response('<html>bad</html>'))).rejects.toThrow(/JSON/);
});
