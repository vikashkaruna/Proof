import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => vi.fn());
const cookieJar = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/gap-scan-backend', () => ({ gapScanBackend: backend }));
vi.mock('next/headers', () => ({ cookies: async () => cookieJar }));
import { POST } from './route';

const token = 'a'.repeat(64);
const originalEnvironment = process.env.ENVIRONMENT;
const request = (body: unknown, url = 'https://axiomproof.ai/api/gap-scan') =>
  new Request(url, { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => {
  backend.mockReset();
  cookieJar.get.mockReset();
  delete process.env.ENVIRONMENT;
});
afterEach(() => {
  if (originalEnvironment === undefined) delete process.env.ENVIRONMENT;
  else process.env.ENVIRONMENT = originalEnvironment;
  vi.restoreAllMocks();
});

it('rejects invalid submissions before calling the BFF', async () => {
  const response = await POST(request({ sessionId: 'x', answers: {} }));
  expect(response.status).toBe(400);
  expect(backend).not.toHaveBeenCalled();
});

it('relays a valid scan, strips the ownership token, and sets an HttpOnly secure cookie', async () => {
  cookieJar.get.mockImplementation((name: string) =>
    name === '__session' ? { value: `gap-scan.${token}` } : undefined,
  );
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
  expect(response.headers.get('set-cookie')).toContain('__session=gap-scan.');
  expect(response.headers.get('set-cookie')).toContain('SameSite=lax');
  expect(response.headers.get('set-cookie')).toContain('Path=/');
  expect(response.headers.get('set-cookie')).not.toContain('Domain=');
  expect(response.headers.get('set-cookie')).not.toContain('report-id');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});

it('does not forward a product session as gap-scan ownership', async () => {
  cookieJar.get.mockImplementation((name: string) =>
    name === '__session' ? { value: token } : undefined,
  );
  backend.mockResolvedValue(
    Response.json({ id: 'report-id', accessToken: token }, { status: 201 }),
  );
  const response = await POST(request({ sessionId: 'session-123', answers: {} }));
  expect(response.status).toBe(201);
  const init = backend.mock.calls[0]?.[1] as RequestInit;
  expect(init.headers).not.toHaveProperty('X-Gap-Scan-Access');
});

it.each(['preprod', 'production'])(
  'sets Secure in %s even when the internal Cloud Run request is HTTP',
  async (environment) => {
    process.env.ENVIRONMENT = environment;
    backend.mockResolvedValue(
      Response.json({ id: 'report-id', accessToken: token }, { status: 201 }),
    );
    const response = await POST(
      request({ sessionId: 'session-123', answers: {} }, 'http://internal/api/gap-scan'),
    );
    expect(response.headers.get('set-cookie')).toContain('Secure');
    expect(response.headers.get('set-cookie')).toContain('__session=gap-scan.');
  },
);

it('allows a host-only HTTP cookie during local development', async () => {
  process.env.ENVIRONMENT = 'local';
  backend.mockResolvedValue(
    Response.json({ id: 'report-id', accessToken: token }, { status: 201 }),
  );
  const response = await POST(
    request({ sessionId: 'session-123', answers: {} }, 'http://localhost:3000/api/gap-scan'),
  );
  expect(response.headers.get('set-cookie')).not.toContain('Secure');
  expect(response.headers.get('set-cookie')).not.toContain('Domain=');
});

it('fails closed when a successful backend response lacks a valid ownership token', async () => {
  backend.mockResolvedValue(
    Response.json({ id: 'report-id', accessToken: 'bad' }, { status: 201 }),
  );
  const response = await POST(request({ sessionId: 'session-123', answers: {} }));
  expect(response.status).toBe(503);
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('cache-control')).toBe('private, no-store');
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
