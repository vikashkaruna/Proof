import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => vi.fn());
const cookieJar = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/gap-scan-backend', () => ({ gapScanBackend: backend }));
vi.mock('next/headers', () => ({ cookies: async () => cookieJar }));
import { POST } from './route';

const token = 'a'.repeat(64);
const request = (body: unknown, url = 'https://axiomproof.ai/api/gap-scan') =>
  new Request(url, { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => {
  backend.mockReset();
  cookieJar.get.mockReset();
});
afterEach(() => vi.restoreAllMocks());

it('rejects invalid submissions before calling the BFF', async () => {
  const response = await POST(request({ sessionId: 'x', answers: {} }));
  expect(response.status).toBe(400);
  expect(backend).not.toHaveBeenCalled();
});

it('relays a valid scan, strips the ownership token, and sets an HttpOnly secure cookie', async () => {
  cookieJar.get.mockReturnValue({ value: token });
  backend.mockResolvedValue(
    Response.json({ id: 'report-id', accessToken: token }, { status: 201 }),
  );
  const response = await POST(
    request({ sessionId: 'session-123', answers: { notice: true }, extra: 'discard' }),
  );
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ id: 'report-id' });
  expect(backend).toHaveBeenCalledWith(
    '/public/gap-scan',
    expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gap-Scan-Access': token },
      body: JSON.stringify({
        sessionId: 'session-123',
        answers: { notice: true },
        followUpRequested: false,
        marketingConsent: false,
      }),
    }),
  );
  expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  expect(response.headers.get('set-cookie')).toContain('Secure');
  expect(response.headers.get('set-cookie')).not.toContain('report-id');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});

it('fails closed when a successful backend response lacks a valid ownership token', async () => {
  backend.mockResolvedValue(
    Response.json({ id: 'report-id', accessToken: 'bad' }, { status: 201 }),
  );
  const response = await POST(request({ sessionId: 'session-123', answers: {} }));
  expect(response.status).toBe(503);
  expect(response.headers.get('set-cookie')).toBeNull();
});

it('preserves BFF rate limits without setting a cookie', async () => {
  backend.mockResolvedValue(
    Response.json(
      { error: { code: 'rate_limited' } },
      { status: 429, headers: { 'Retry-After': '30' } },
    ),
  );
  const response = await POST(request({ sessionId: 'session-123', answers: {} }));
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('30');
  expect(response.headers.get('set-cookie')).toBeNull();
});

it('reports service unavailability without leaking an upstream exception', async () => {
  backend.mockRejectedValue(new Error('private upstream URL'));
  const response = await POST(request({ sessionId: 'session-123', answers: {} }));
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain('private upstream URL');
});
