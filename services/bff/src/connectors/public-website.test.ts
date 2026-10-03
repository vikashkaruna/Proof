import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
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
        return html(`<html><title>Our &amp; Your Privacy</title><script>secret</script>
          <h1>Privacy Notice</h1><h2>What we collect</h2>
          <a href="/contact">Contact DPO</a><a href="javascript:alert(1)">Privacy</a></html>`);
      },
    });
    expect(requested).toEqual(['https://public.org/privacy']);
    expect(checked.title).toBe('Our & Your Privacy');
    expect(checked.headings).toEqual(['Privacy Notice', 'What we collect']);
    expect(checked.publicLinks).toEqual([
      { label: 'Contact DPO', url: 'https://public.org/contact' },
    ]);
    expect(checked.contentSha256).toMatch(/^[a-f0-9]{64}$/);
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
    await Promise.all(
      servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
    );
  });

  it('connects to the pinned address while preserving the original Host', async () => {
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
