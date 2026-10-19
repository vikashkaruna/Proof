import { afterEach, expect, it, vi } from 'vitest';
import { readDataFlowJson, requestDataFlow } from './flow-transport';
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
    readDataFlowJson(new Response(stream, { headers: { 'content-type': 'application/json' } }), 20),
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
    requestDataFlow(
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
      '/data-flows/recover',
    ),
  ).rejects.toThrow(/bounds/);
});
it('refuses malformed UTF8 and non-JSON responses safely', async () => {
  await expect(
    readDataFlowJson(
      new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }),
    ),
  ).rejects.toThrow();
  await expect(readDataFlowJson(new Response('<html>bad</html>'))).rejects.toThrow(/JSON/);
});
