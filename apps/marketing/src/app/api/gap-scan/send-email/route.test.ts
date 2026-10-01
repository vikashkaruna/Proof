import { beforeEach, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => vi.fn());
const cookieJar = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/gap-scan-backend', () => ({ gapScanBackend: backend }));
vi.mock('next/headers', () => ({ cookies: async () => cookieJar }));
import { POST } from './route';

const id = 'c9910225-81b2-4ef9-84c9-29b14beafc14';
const submit = (body: unknown) =>
  POST(
    new Request('https://axiomproof.ai/api/gap-scan/send-email', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  backend.mockReset();
  cookieJar.get.mockReset();
});

it('validates the report and destination before forwarding', async () => {
  expect((await submit({ id: 'missing', email: 'bad' })).status).toBe(400);
  expect(backend).not.toHaveBeenCalled();
});

it('passes an ownership cookie and only validated fields to the BFF', async () => {
  cookieJar.get.mockReturnValue({ value: 'ownership-token' });
  backend.mockResolvedValue(Response.json({ status: 'queued' }, { status: 202 }));
  const result = await submit({ id, email: 'reader@example.invalid', extra: 'ignored' });
  expect(result.status).toBe(202);
  expect(result.headers.get('cache-control')).toBe('private, no-store');
  expect(backend).toHaveBeenCalledWith(
    '/public/gap-scan/send-email',
    expect.objectContaining({
      headers: { 'Content-Type': 'application/json', 'X-Gap-Scan-Access': 'ownership-token' },
      body: JSON.stringify({ id, email: 'reader@example.invalid' }),
    }),
  );
});

it('preserves BFF refusal and rate-limit information without claiming delivery', async () => {
  backend.mockResolvedValue(
    Response.json(
      { error: { code: 'rate_limited' } },
      {
        status: 429,
        headers: { 'Retry-After': '60' },
      },
    ),
  );
  const result = await submit({ id, email: 'reader@example.invalid' });
  expect(result.status).toBe(429);
  expect(result.headers.get('retry-after')).toBe('60');
  expect(await result.json()).toEqual({ error: { code: 'rate_limited' } });
});

it('converts an upstream outage into a generic unavailable response', async () => {
  backend.mockRejectedValue(new Error('internal private key'));
  const result = await submit({ id, email: 'reader@example.invalid' });
  expect(result.status).toBe(503);
  expect(JSON.stringify(await result.json())).not.toContain('private key');
});
