import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@axiom/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@axiom/config')>()),
  loadWebEnv: () => ({
    ENVIRONMENT: 'preprod',
    AXIOM_RELEASE_SHA: 'a'.repeat(40),
    AXIOM_AUTH_MODE: 'local',
  }),
}));
import RootLayout from './layout';
import robots from './robots';
import sitemap from './sitemap';
import { GET as health } from './api/health/route';

afterEach(() => vi.unstubAllEnvs());

it('publishes only public pages to robots and sitemap', () => {
  const rules = robots();
  expect(rules.rules).toEqual([{ userAgent: '*', allow: '/', disallow: ['/api/'] }]);
  const urls = sitemap().map((entry) => entry.url);
  expect(urls).toContain('https://axiomproof.ai/privacy');
  expect(urls).toContain('https://axiomproof.ai/terms');
  expect(urls.every((url) => !url.includes('/api/'))).toBe(true);
});

it('uses the configured preprod marketing origin in public metadata', () => {
  vi.stubEnv('AXIOM_PROOF_MARKETING_URL', 'https://stg.axiomproof.ai');
  expect(robots().sitemap).toBe('https://stg.axiomproof.ai/sitemap.xml');
  expect(sitemap().map((entry) => entry.url)).toContain('https://stg.axiomproof.ai/privacy');
});

it('rejects a malformed or missing deployment marketing origin', () => {
  // A different HTTPS origin is syntactically valid; a scheme downgrade is not.
  vi.stubEnv('AXIOM_PROOF_MARKETING_URL', 'http://stg.axiomproof.ai');
  expect(() => sitemap()).toThrow('bare HTTPS origin');
  vi.stubEnv('AXIOM_PROOF_MARKETING_URL', '');
  vi.stubEnv('AXIOM_STRICT_PUBLIC_URLS', '1');
  expect(() => robots()).toThrow('required');
});

it('exposes deployment identity without credentials or cacheable status', async () => {
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'private-key');
  const response = health();
  expect(response.headers.get('cache-control')).toBe('no-store');
  const payload = await response.json();
  expect(payload).toMatchObject({
    status: 'ok',
    service: 'axiom-marketing',
    environment: 'preprod',
    revision: 'a'.repeat(40),
  });
  expect(JSON.stringify(payload)).not.toContain('private-key');
});

it('wraps public content in the branded accessible document structure', () => {
  const html = renderToStaticMarkup(
    <RootLayout>
      <main id="content">Hello</main>
    </RootLayout>,
  );
  expect(html).toContain('id="content"');
  expect(html).toContain('Hello');
  expect(html).toContain('<html');
  expect(html).toContain('<body');
});
