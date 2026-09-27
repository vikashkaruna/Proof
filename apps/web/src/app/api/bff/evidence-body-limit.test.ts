import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('@axiom/supabase', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: 'fixture' } } }) },
  }),
}));
const { POST } = await import('./[...path]/route');
afterEach(() => vi.unstubAllGlobals());
it('propagates caller cancellation to the BFF request', async () => {
  const controller = new AbortController();
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const request = new NextRequest('http://localhost/api/bff/v1/evidence-packs', {
    method: 'POST',
    headers: { 'x-tenant-id': 'fixture' },
    body: '{}',
    signal: controller.signal,
  });
  await POST(request, { params: Promise.resolve({ path: ['v1', 'evidence-packs'] }) });
  const forwarded = fetchMock.mock.calls[0]?.[1] as RequestInit;
  expect(forwarded.signal).toBe(request.signal);
  controller.abort();
  expect(forwarded.signal?.aborted).toBe(true);
});
it.each([undefined, '1'])(
  'rejects streamed upload beyond limit despite content-length=%s before forwarding',
  async (length) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(12 * 1024 * 1024 + 1));
      },
      cancel,
    });
    const headers: Record<string, string> = { 'x-tenant-id': 'fixture' };
    if (length) headers['content-length'] = length;
    const request = new NextRequest('http://localhost/api/bff/v1/evidence/ingestions', {
      method: 'POST',
      headers,
      body: stream,
      ...{ duplex: 'half' },
    });
    const response = await POST(request, {
      params: Promise.resolve({ path: ['v1', 'evidence', 'ingestions'] }),
    });
    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it.each([
  ['v1', 'evidence-packs'],
  ['v1', 'evidence-packs', 'pack-id', 'build'],
  ['v1', 'reports', 'report-id', 'review'],
  ['v1', 'reports', 'report-id', 'release'],
])('bounds report/pack mutation before forwarding: %j', async (...path) => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const request = new NextRequest(`http://localhost/api/bff/${path.join('/')}`, {
    method: 'POST',
    headers: { 'x-tenant-id': 'fixture', 'content-length': '1' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024 + 1));
        controller.close();
      },
    }),
    ...{ duplex: 'half' },
  });
  const response = await POST(request, { params: Promise.resolve({ path }) });
  expect(response.status).toBe(413);
  expect(fetchMock).not.toHaveBeenCalled();
});
