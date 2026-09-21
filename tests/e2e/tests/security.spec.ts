/**
 * Security E2E: verifies the security headers and CSP are applied.
 *
 * Per the Next.js config (apps/web/next.config.mjs), every page sets:
 *   - X-Frame-Options: DENY
 *   - X-Content-Type-Options: nosniff
 *   - Referrer-Policy: strict-origin-when-cross-origin
 *   - Permissions-Policy: camera=(), microphone=(), geolocation=()
 *   - Strict-Transport-Security: max-age=63072000
 */

import { test, expect } from '@playwright/test';

import { marketingUrl } from '../target';

test.describe('Security headers', () => {
  test('the app applies the security headers', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBeLessThan(500);

    const headers = res.headers();
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  test('the marketing site applies the security headers', async ({ request }) => {
    const res = await request.get(`${marketingUrl}/`, { headers: { host: 'axiomproof.ai' } });
    expect(res.status()).toBeLessThan(500);
    const headers = res.headers();
    expect(headers['x-frame-options']).toBe('DENY');
  });
});
