import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GET, POST } from './route';

const input = {
  name: 'Ravi Sharma',
  email: 'ravi@example.invalid',
  message: 'We would like a walkthrough next week.',
};
const submit = (body: unknown) =>
  POST(
    new Request('https://axiomproof.example.invalid/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
beforeEach(() => {
  vi.stubEnv('BFF_PUBLIC_URL', 'https://bff.example.invalid');
  vi.stubEnv('RESEND_API_KEY', 'private-mail-key');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('forwards only the validated inquiry to the BFF and relays its stored outcome', async () => {
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      Response.json({ id: 'inquiry', delivery: 'not_configured' }, { status: 201 }),
    );
  const res = await submit({ ...input, delivery: 'sent', extra: 'ignored' });
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({ id: 'inquiry', delivery: 'not_configured' });
  const [url, opts] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe('https://bff.example.invalid/public/contact');
  expect(JSON.parse(String(opts!.body))).toEqual(input);
  expect(JSON.stringify(opts)).not.toContain('private-mail-key');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('never reports success when the BFF cannot persist or is unreachable', async () => {
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      Response.json({ error: { code: 'persistence_failed' } }, { status: 503 }),
    )
    .mockRejectedValueOnce(new Error('offline'));
  expect((await submit(input)).status).toBe(503);
  const offline = await submit(input);
  expect(offline.status).toBe(503);
  expect(await offline.json()).toMatchObject({ error: { code: 'service_unavailable' } });
  expect(fetcher).toHaveBeenCalledTimes(2);
  vi.stubEnv('BFF_PUBLIC_URL', '');
  expect((await submit(input)).status).toBe(503);
});

it('rejects invalid input locally and relays rate limits', async () => {
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      Response.json(
        { error: { code: 'rate_limited' } },
        { status: 429, headers: { 'Retry-After': '3600' } },
      ),
    );
  expect((await submit({ ...input, email: 'bad' })).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
  const limited = await submit(input);
  expect(limited.status).toBe(429);
  expect(limited.headers.get('Retry-After')).toBe('3600');
});

it('exposes delivery configuration from the BFF and no inquiry data', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ emailDeliveryEnabled: false }));
  const res = await GET();
  expect(await res.json()).toEqual({ status: 'healthy', emailConfigured: false });
});
