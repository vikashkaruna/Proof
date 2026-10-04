import http, { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkPublicWebsite,
  fetchPinnedPage,
  isPublicIPv4,
  parsePublicUrl,
  PublicWebsiteRefused,
  type WebsitePage,
} from './public-website.js';

const html = (body: string, status = 200, location?: string): WebsitePage => ({
  status,
  contentType: 'text/html; charset=utf-8',
  location,
  body: Buffer.from(body),
});
const signal = AbortSignal.timeout(5_000);

describe('public website target boundary', () => {
  it.each([
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://localhost/',
    'https://internal.local/',
    'https://user:pass@public.org/',
    'https://public.org:8443/',
    'https://public.org/?token=secret',
    'file:///etc/passwd',
    'https://public.org.evil.test/',
  ])('rejects unsafe target %s', (url) => {
    expect(() => parsePublicUrl(url)).toThrow(PublicWebsiteRefused);
  });

  it.each([
    ['8.8.8.8', true],
    ['1.1.1.1', true],
    ['0.1.2.3', false],
    ['10.2.3.4', false],
    ['100.64.1.2', false],
    ['127.0.0.1', false],
    ['169.254.169.254', false],
    ['172.31.255.2', false],
    ['192.0.2.1', false],
    ['192.168.1.1', false],
    ['198.18.0.1', false],
    ['198.51.100.2', false],
    ['203.0.113.5', false],
    ['224.0.0.1', false],
    ['255.255.255.255', false],
    ['::1', false],
  ])('classifies %s as global=%s', (ip, expected) => {
    expect(isPublicIPv4(ip)).toBe(expected);
  });

  it('pins a vetted address and extracts bounded public page signals', async () => {
    const requested: string[] = [];
    const checked = await checkPublicWebsite('https://public.org/privacy', signal, {
      resolve4: async (host) => {
        expect(host).toBe('public.org');
        return ['8.8.8.8'];
      },
      fetchPage: async (url, address) => {
        requested.push(url.href);
        expect(address).toBe('8.8.8.8');
        if (url.pathname === '/contact') return html('<title>Contact us</title>');
        return html(`<html><title>Our &amp; Your Privacy</title><script>secret</script>
          <h1>Privacy Notice</h1><h2>What we collect</h2>
          <a href="/contact">Contact DPO</a><a href="javascript:alert(1)">Privacy</a></html>`);
      },
    });
    expect(requested).toEqual(['https://public.org/privacy', 'https://public.org/contact']);
    expect(checked.title).toBe('Our & Your Privacy');
    expect(checked.headings).toEqual(['Privacy Notice', 'What we collect']);
    expect(checked.publicLinks).toEqual([
      { label: 'Contact DPO', url: 'https://public.org/contact' },
    ]);
    expect(checked.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(checked.auditPages).toMatchObject([
      { kind: 'contact', status: 'checked', title: 'Contact us' },
    ]);
    expect(checked.observations).toEqual([
      { kind: 'privacy', status: 'retrieved' },
      { kind: 'contact', status: 'retrieved' },
      { kind: 'terms', status: 'not_linked' },
    ]);
  });

  it('checks at most three same-site notice pages and records retrievability honestly', async () => {
    const requested: string[] = [];
    const checked = await checkPublicWebsite('https://public.org/', signal, {
      resolve4: async () => ['8.8.8.8'],
      fetchPage: async (url) => {
        requested.push(url.href);
        if (url.pathname === '/privacy') return html('<title>Privacy</title>');
        if (url.pathname === '/contact') return html('Missing', 404);
        if (url.pathname === '/terms') return html('Redirect', 302, 'https://other.org/terms');
        return html(`<title>Home</title>
          <a href="/privacy">Privacy</a><a href="/contact">Contact</a>
          <a href="/terms">Terms</a><a href="https://other.org/privacy">Other privacy</a>
          <a href="/privacy?token=private">Private query</a>`);
      },
    });
    expect(requested).toEqual([
      'https://public.org/',
      'https://public.org/privacy',
      'https://public.org/contact',
      'https://public.org/terms',
    ]);
    expect(checked.auditPages).toMatchObject([
      { kind: 'privacy', status: 'checked', title: 'Privacy' },
      { kind: 'contact', status: 'unavailable', errorCode: 'http_status' },
      { kind: 'terms', status: 'unavailable', errorCode: 'off_site_redirect' },
    ]);
    expect(checked.observations).toEqual([
      { kind: 'privacy', status: 'retrieved' },
      { kind: 'contact', status: 'unavailable' },
      { kind: 'terms', status: 'unavailable' },
    ]);
    expect(JSON.stringify(checked)).not.toContain('token=private');
  });

  it('revalidates DNS on linked pages and refuses a rebound to private space', async () => {
    let lookups = 0;
    const requested: string[] = [];
    const checked = await checkPublicWebsite('https://public.org/', signal, {
      resolve4: async () => (++lookups === 1 ? ['8.8.8.8'] : ['10.0.0.1']),
      fetchPage: async (url) => {
        requested.push(url.href);
        return html('<a href="/privacy">Privacy</a>');
      },
    });
    expect(lookups).toBe(2);
    expect(requested).toEqual(['https://public.org/']);
    expect(checked.auditPages).toEqual([
      {
        kind: 'privacy',
        requestedUrl: 'https://public.org/privacy',
        status: 'unavailable',
        errorCode: 'non_public_target',
      },
    ]);
  });

  it('does not let repeated contact links hide a later same-site privacy notice', async () => {
    const requested: string[] = [];
    const checked = await checkPublicWebsite('https://public.org/', signal, {
      resolve4: async () => ['8.8.8.8'],
      fetchPage: async (url) => {
        requested.push(url.href);
        return url.pathname === '/'
          ? html(
              `${'<a href="/contact">Contact</a>'.repeat(30)}<a href="/privacy">Privacy policy</a>`,
            )
          : html('<title>Privacy</title>');
      },
    });
    expect(requested).toContain('https://public.org/privacy');
    expect(checked.observations[0]).toEqual({ kind: 'privacy', status: 'retrieved' });
  });

  it('resolves unquoted links against the HTML base and ignores data-href lookalikes', async () => {
    const requested: string[] = [];
    const checked = await checkPublicWebsite('https://public.org/', signal, {
      resolve4: async () => ['8.8.8.8'],
      fetchPage: async (url) => {
        requested.push(url.href);
        return url.pathname === '/'
          ? html(
              '<base href="/legal/"><a data-href="/contact">Contact</a><a href=privacy>Privacy policy</a>',
            )
          : html('<title>Privacy</title>');
      },
    });
    expect(requested).toEqual(['https://public.org/', 'https://public.org/legal/privacy']);
    expect(checked.observations).toContainEqual({ kind: 'privacy', status: 'retrieved' });
    expect(checked.observations).toContainEqual({ kind: 'contact', status: 'not_linked' });
  });

  it('does not follow relative links when an HTML base points off-site', async () => {
    const requested: string[] = [];
    const checked = await checkPublicWebsite('https://public.org/', signal, {
      resolve4: async () => ['8.8.8.8'],
      fetchPage: async (url) => {
        requested.push(url.href);
        return html('<base href="https://other.org/"><a href=privacy>Privacy</a>');
      },
    });
    expect(requested).toEqual(['https://public.org/']);
    expect(checked.observations[0]).toEqual({ kind: 'privacy', status: 'not_linked' });
  });

  it('revalidates every redirect and never fetches a private destination', async () => {
    let requests = 0;
    await expect(
      checkPublicWebsite('https://public.org/', signal, {
        resolve4: async (host) => (host === 'public.org' ? ['8.8.8.8'] : ['169.254.169.254']),
        fetchPage: async () => {
          requests++;
          return html('', 302, 'https://metadata.cloud.org/latest');
        },
      }),
    ).rejects.toMatchObject({ code: 'non_public_target' });
    expect(requests).toBe(1);
  });

  it('refuses a mixed DNS answer, a redirect loop, and non-HTML content', async () => {
    await expect(
      checkPublicWebsite('https://public.org/', signal, {
        resolve4: async () => ['8.8.8.8', '10.0.0.1'],
        fetchPage: async () => {
          throw new Error('must not fetch');
        },
      }),
    ).rejects.toMatchObject({ code: 'non_public_target' });
    await expect(
      checkPublicWebsite('https://public.org/', signal, {
        resolve4: async () => ['8.8.8.8'],
        fetchPage: async () => html('', 302, '/again'),
      }),
    ).rejects.toMatchObject({ code: 'redirect_refused' });
    await expect(
      checkPublicWebsite('https://public.org/', signal, {
        resolve4: async () => ['8.8.8.8'],
        fetchPage: async () => ({ ...html('pdf'), contentType: 'application/pdf' }),
      }),
    ).rejects.toMatchObject({ code: 'unsupported_content_type' });
  });
});

describe('pinned HTTP transport', () => {
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
    );
  });

  it('connects to the pinned address while preserving the original Host', async () => {
    const request = vi.spyOn(http, 'request');
    let observedHost = '';
    const server = createServer((req, res) => {
      observedHost = req.headers.host ?? '';
      res.setHeader('content-type', 'text/html');
      res.end('<h1>Observed</h1>');
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no test port');
    const page = await fetchPinnedPage(
      new URL(`http://public.org:${address.port}/`),
      '127.0.0.1',
      signal,
    );
    expect(page.body.toString()).toContain('Observed');
    expect(observedHost).toBe(`public.org:${address.port}`);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ agent: false });
  });

  it('cuts off oversized responses even without Content-Length', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.write(Buffer.alloc(512 * 1024));
      res.end('extra');
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no test port');
    await expect(
      fetchPinnedPage(new URL(`http://public.org:${address.port}/`), '127.0.0.1', signal),
    ).rejects.toMatchObject({ code: 'response_too_large' });
  });
});
