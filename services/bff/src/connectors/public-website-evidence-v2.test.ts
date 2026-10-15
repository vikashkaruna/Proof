import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  checkPublicWebsite,
  checkPublicWebsiteEvidenceV2,
  PublicWebsiteRefused,
  type WebsitePage,
} from './public-website';
import { publicControlPayloadV2Schema } from '@axiom/types';
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const response = (text: string): WebsitePage => ({
  status: 200,
  contentType: 'text/html',
  body: Buffer.from(text),
});
const root =
  '<a href=/privacy>Privacy</a><a href=/contact>Contact</a><a href=/terms>Terms</a><a href=/consent>Consent preferences</a><form><input type=email value="never-retain@example.com"></form>';
function dependencies(content: Record<string, string> = {}) {
  const calls: string[] = [];
  const deps = {
    resolve4: vi.fn(async () => ['8.8.8.8']),
    fetchPage: vi.fn(async (url: URL, address: string) => {
      expect(address).toBe('8.8.8.8');
      calls.push(url.href);
      return response(
        content[url.pathname] ??
          (url.pathname === '/' ? root : '<p>Privacy policy and retention notice.</p>'),
      );
    }),
  };
  return { deps, calls };
}
afterEach(() => vi.useRealTimers());
it('captures fresh five-page evidence with actual body hashes, same requests and exact legacy check shape', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
  const v1 = dependencies(),
    v2 = dependencies({
      '/consent':
        '<h1>Consent controls demo</h1><button>Accept analytics cookies</button><p>Withdraw consent.</p>',
    });
  const legacy = await checkPublicWebsite(
    'https://public.org/',
    new AbortController().signal,
    v1.deps,
  );
  const result = await checkPublicWebsiteEvidenceV2(
    'https://public.org/',
    new AbortController().signal,
    v2.deps,
  );
  expect(result.check).toEqual(legacy);
  expect(JSON.stringify(result.check)).toBe(JSON.stringify(legacy));
  expect(v1.calls).toEqual([
    'https://public.org/',
    'https://public.org/privacy',
    'https://public.org/contact',
    'https://public.org/terms',
  ]);
  expect(v2.calls).toEqual([...v1.calls, 'https://public.org/consent']);
  const payload = publicControlPayloadV2Schema.parse(JSON.parse(result.evidence.payloadText));
  expect(payload.pages.map((p) => p.page)).toEqual([
    'root',
    'privacy',
    'contact',
    'terms',
    'consent',
  ]);
  expect(payload.pages.every((p) => p.state === 'examined')).toBe(true);
  expect(result.evidence.payloadSha256).toBe(hash(result.evidence.payloadText));
  expect(payload.pages[0]!.contentSha256).toBe(hash(root));
  expect(
    payload.candidates.some(
      (c) => c.locator.page === 'consent' && c.facet === 'consent_ui' && c.context === 'demo',
    ),
  ).toBe(true);
  expect(result.evidence.pageSources).toEqual(
    payload.pages.map((p) => ({
      page: p.page,
      requestedUrl: `https://public.org/${p.page === 'root' ? '' : p.page}`,
      finalUrl: `https://public.org/${p.page === 'root' ? '' : p.page}`,
      state: 'examined',
      contentSha256: p.contentSha256,
    })),
  );
  expect(result.evidence.payloadText).not.toContain('never-retain');
  expect(result.evidence.payloadText).not.toContain('tenantId');
  expect(result.check.auditPages).toHaveLength(3);
  expect(result.check.observations).toHaveLength(3);
});
it('marks absent links unexamined with null provenance and never follows an action or hidden consent link', async () => {
  const { deps, calls } = dependencies({
    '/': '<script>const link="<a href=/consent>Consent</a>"</script><form action=/consent><input value="secret"></form><template><a href=/consent>Consent</a></template>',
  });
  const result = await checkPublicWebsiteEvidenceV2(
    'https://public.org/',
    new AbortController().signal,
    deps,
  );
  expect(calls).toEqual(['https://public.org/']);
  expect(result.evidence.pageSources.slice(1)).toEqual(
    ['privacy', 'contact', 'terms', 'consent'].map((page) => ({
      page,
      requestedUrl: null,
      finalUrl: null,
      state: 'unexamined',
      contentSha256: null,
    })),
  );
});
it.each([
  'off_site',
  'query',
  'userinfo',
  'private_dns',
  'offsite_redirect',
  'large',
  'type',
  'failure',
])('preserves SSRF/failure bounds on consent: %s', async (mode) => {
  const href =
    mode === 'off_site'
      ? 'https://other.org/consent'
      : mode === 'query'
        ? '/consent?token=secret'
        : mode === 'userinfo'
          ? 'https://u:p@public.org/consent'
          : '/consent';
  const { deps, calls } = dependencies({ '/': `<a href="${href}">Consent</a>` });
  if (mode === 'private_dns')
    deps.resolve4.mockResolvedValueOnce(['8.8.8.8']).mockResolvedValue(['169.254.169.254']);
  const original = deps.fetchPage.getMockImplementation()!;
  deps.fetchPage.mockImplementation(async (url, address) => {
    if (url.pathname !== '/consent') return original(url, address);
    calls.push(url.href);
    if (mode === 'offsite_redirect')
      return { ...response(''), status: 302, location: 'https://other.org/consent' };
    if (mode === 'large') return { ...response(''), body: Buffer.alloc(512 * 1024 + 1) };
    if (mode === 'type') return { ...response(''), contentType: 'application/json' };
    throw new PublicWebsiteRefused('unreachable');
  });
  const result = await checkPublicWebsiteEvidenceV2(
    'https://public.org/',
    new AbortController().signal,
    deps,
  );
  const consent = result.evidence.pageSources.find((p) => p.page === 'consent')!;
  expect(consent.state).toBe(
    ['off_site', 'query', 'userinfo'].includes(mode) ? 'unexamined' : 'unavailable',
  );
  expect(consent.finalUrl).toBeNull();
  expect(consent.contentSha256).toBeNull();
  expect(consent.requestedUrl).toBe(
    consent.state === 'unavailable' ? 'https://public.org/consent' : null,
  );
  expect(calls.every((url) => url.startsWith('https://public.org/'))).toBe(true);
  expect(calls).not.toContain('https://other.org/consent');
});
it('uses the original signal for consent and refuses a result after cancellation', async () => {
  const controller = new AbortController();
  const { deps } = dependencies({ '/': '<a href=/consent>Consent</a>' });
  deps.fetchPage.mockImplementation(async (url) => {
    if (url.pathname === '/consent') {
      controller.abort();
      return response('<p>Consent notice</p>');
    }
    return response('<a href=/consent>Consent</a>');
  });
  await expect(
    checkPublicWebsiteEvidenceV2('https://public.org/', controller.signal, deps),
  ).rejects.toMatchObject({ code: 'timeout' });
});
it('retains only accepted final consent body hash and vetted redirect provenance', async () => {
  const { deps, calls } = dependencies({ '/': '<base href=/legal/><a href=consent>Consent</a>' });
  deps.fetchPage.mockImplementation(async (url, address) => {
    expect(address).toBe('8.8.8.8');
    calls.push(url.href);
    return url.pathname === '/legal/consent'
      ? { ...response('do not hash redirect body'), status: 302, location: '/consent-final' }
      : url.pathname === '/consent-final'
        ? response('<p>We provide consent withdrawal.</p>')
        : response('<base href=/legal/><a href=consent>Consent</a>');
  });
  const result = await checkPublicWebsiteEvidenceV2(
    'https://public.org/',
    new AbortController().signal,
    deps,
  );
  expect(result.evidence.pageSources.at(-1)).toEqual({
    page: 'consent',
    requestedUrl: 'https://public.org/legal/consent',
    finalUrl: 'https://public.org/consent-final',
    state: 'examined',
    contentSha256: hash('<p>We provide consent withdrawal.</p>'),
  });
  expect(calls).toEqual([
    'https://public.org/',
    'https://public.org/legal/consent',
    'https://public.org/consent-final',
  ]);
});
it('keeps coverage reasons and truncation from the trusted extractor and refuses invalid UTF8 evidence', async () => {
  const { deps } = dependencies({ '/': '<p>Privacy policy</p><svg><text>Consent</text></svg>' });
  const result = await checkPublicWebsiteEvidenceV2(
    'https://public.org/',
    new AbortController().signal,
    deps,
  );
  const payload = publicControlPayloadV2Schema.parse(JSON.parse(result.evidence.payloadText));
  expect(payload.pages[0]!.coverageReasons).toContain('unsupported_foreign_markup');
  expect(payload.pages[0]!.truncated).toBe(true);
  const invalid = dependencies();
  invalid.deps.fetchPage.mockResolvedValue({ ...response(''), body: Buffer.from([0xc3, 0x28]) });
  await expect(
    checkPublicWebsiteEvidenceV2('https://public.org/', new AbortController().signal, invalid.deps),
  ).rejects.toThrow();
});
it('refuses unsafe root before any transport and preserves unavailable notice source states', async () => {
  const unsafe = dependencies();
  await expect(
    checkPublicWebsiteEvidenceV2('http://127.0.0.1/', new AbortController().signal, unsafe.deps),
  ).rejects.toThrow();
  expect(unsafe.deps.fetchPage).not.toHaveBeenCalled();
  const { deps } = dependencies({ '/': '<a href=/privacy>Privacy</a>' });
  deps.fetchPage.mockImplementation(async (url) => {
    if (url.pathname === '/privacy') throw new Error('private diagnostic');
    return response('<a href=/privacy>Privacy</a>');
  });
  const result = await checkPublicWebsiteEvidenceV2(
    'https://public.org/',
    new AbortController().signal,
    deps,
  );
  expect(result.evidence.pageSources[1]).toMatchObject({
    page: 'privacy',
    state: 'unavailable',
    requestedUrl: 'https://public.org/privacy',
    finalUrl: null,
    contentSha256: null,
  });
  expect(result.evidence.payloadText).not.toContain('private diagnostic');
});

it('deduplicates consent against checked pages and limits distinct consent links to one fetch', async () => {
  const shared = dependencies({ '/': '<a href=/privacy>Privacy and consent notice</a>' });
  const reused = await checkPublicWebsiteEvidenceV2(
    'https://public.org/',
    new AbortController().signal,
    shared.deps,
  );
  expect(shared.calls).toEqual(['https://public.org/', 'https://public.org/privacy']);
  expect(reused.evidence.pageSources.at(-1)).toMatchObject({
    page: 'consent',
    state: 'unexamined',
    requestedUrl: null,
    finalUrl: null,
  });
  const multiple = dependencies({ '/': root + '<a href=/consent-extra>Other consent page</a>' });
  await checkPublicWebsiteEvidenceV2(
    'https://public.org/',
    new AbortController().signal,
    multiple.deps,
  );
  expect(multiple.calls).toHaveLength(5);
  expect(multiple.calls).not.toContain('https://public.org/consent-extra');
});
