import { afterEach, expect, it, vi } from 'vitest';
import { readCoverageJson, requestCoverage } from './coverage-transport';
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
    readCoverageJson(new Response(stream, { headers: { 'content-type': 'application/json' } }), 20),
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
    requestCoverage(
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
      '/scheduled-coverage/recover',
    ),
  ).rejects.toThrow(/bounds/);
});
it('refuses malformed UTF8 and non-JSON responses safely', async () => {
  await expect(
    readCoverageJson(
      new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }),
    ),
  ).rejects.toThrow();
  await expect(readCoverageJson(new Response('<html>bad</html>'))).rejects.toThrow(/JSON/);
});

it.each([
  ['coverage_approval_unavailable', 'disabled or unavailable'],
  ['coverage_producer_unavailable', 'producer is unavailable'],
  ['current_owner_required', 'current organization owner'],
  ['coverage_operation_unconfirmed', 'exact original request'],
])('explains actual %s without treating uncertainty as absence', async (code, message) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
  await expect(
    requestCoverage(
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
      '/scheduled-coverage',
    ),
  ).rejects.toThrow(message);
});
