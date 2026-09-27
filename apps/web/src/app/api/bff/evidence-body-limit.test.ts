import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('@axiom/supabase', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: 'fixture' } } }) },
  }),
}));
const { POST } = await import('./[...path]/route');
afterEach(() => vi.unstubAllGlobals());
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
