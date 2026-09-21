import { afterEach, expect, it, vi } from 'vitest';
import { gapScanBackend } from './gap-scan-backend';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it('routes through BFF without forwarding database/mail secrets and refuses redirects', async () => {
  vi.stubEnv('BFF_PUBLIC_URL', 'https://bff.example.invalid');
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'private-database-key');
  vi.stubEnv('RESEND_API_KEY', 'private-mail-key');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 'report' }));
  await gapScanBackend('/public/gap-scan', {
    method: 'POST',
    headers: { 'X-Gap-Scan-Access': 'proof' },
    body: '{}',
  });
  const [url, opts] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe('https://bff.example.invalid/public/gap-scan');
  expect(opts).toMatchObject({
    cache: 'no-store',
    redirect: 'error',
    headers: { 'X-Gap-Scan-Access': 'proof' },
  });
  expect(JSON.stringify(opts)).not.toContain('private-');
});
it('fails when BFF is unavailable instead of falling back to local storage', async () => {
  vi.stubEnv('BFF_PUBLIC_URL', '');
  const fetcher = vi.spyOn(globalThis, 'fetch');
  await expect(gapScanBackend('/public/gap-scan')).rejects.toThrow('not configured');
  expect(fetcher).not.toHaveBeenCalled();
  vi.stubEnv('BFF_PUBLIC_URL', 'https://bff.example.invalid');
  fetcher.mockRejectedValue(new Error('offline'));
  await expect(gapScanBackend('/public/gap-scan')).rejects.toThrow('offline');
});
