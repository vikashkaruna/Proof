import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuthenticatedWebsiteRefused,
  crawlAuthenticatedWebsite,
  normalisePath,
  readSiteCredential,
  siteOrigin,
  type AuthenticatedWebsiteSite,
} from './website-authenticated.js';

const TENANT = '76760000-0000-4000-8000-000000000001';
const CONNECTOR = '76760000-0000-4000-8000-000000000002';
const PASSWORD = 'portal-test-password-1';
const TOKEN = 'portal-test-bearer-token-1';
const SESSION = 'session-value-must-never-leak';
const requested: string[] = [];
let dropSessionAfter = Infinity;
let inlineLoginAfter = Infinity;
let served = 0;
let server: Server;
let base = '';

const page = (body: string) =>
  `<!doctype html><html><head><title>Account of Asha Rao</title></head><body>${body}</body></html>`;
beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requested.push(`${req.method} ${url.pathname}`);
    const authed =
      (req.headers.cookie ?? '').includes(`sid=${SESSION}`) ||
      req.headers.authorization === `Bearer ${TOKEN}`;
    const html = (
      status: number,
      body: string,
      headers: Record<string, string | string[]> = {},
    ) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(page(body));
    };
    if (url.pathname === '/login' && req.method === 'GET')
      return html(
        200,
        `<form method="post" action="/login"><input type="hidden" name="csrf" value="t0k3n">
        <input name="email"><input type="password" name="password"><button>Sign in</button></form>`,
        {
          'set-cookie': ['tracking_id=abc123; Path=/'],
        },
      );
    if (url.pathname === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        if (
          form.get('csrf') === 't0k3n' &&
          form.get('email') === 'demo.owner@example.in' &&
          form.get('password') === PASSWORD
        ) {
          res.writeHead(303, {
            location: '/account',
            'set-cookie': [`sid=${SESSION}; HttpOnly; Path=/`],
          });
          return res.end();
        }
        html(
          200,
          `<p>Wrong password</p><form method="post"><input name="email"><input type="password" name="password"></form>`,
        );
      });
      return;
    }
    served += 1;
    // Some sites show the login form in place (HTTP 200) instead of redirecting.
    if (served > inlineLoginAfter)
      return html(
        200,
        '<form method="post" action="/login"><input name="email"><input type="password" name="password"></form>',
      );
    if (!authed || served > dropSessionAfter) {
      res.writeHead(302, { location: '/login' });
      return res.end();
    }
    switch (url.pathname) {
      case '/account':
        return html(
          200,
          `<h1>Welcome, Asha Rao</h1>
          <form method="post" action="/account"><input name="full_name" value="Asha Rao">
          <input name="email" value="asha@example.in"><input name="mobile" value="9876543210">
          <input name="pan_no" value="ABCDE1234F"><input name="date_of_birth"><textarea name="notes">private note</textarea></form>
          <a href="/privacy">Privacy notice</a> <a href="/consent-settings">Consent preferences</a>
          <a href="/data-request">Download my data</a> <a href="/account/delete">Delete my account</a>
          <a href="/logout">Log out</a> <a href="/transactions/12345?page=2">Statement</a>
          <a href="/members/asha@example.in">Profile</a> <a href="https://elsewhere.example/x">Partner</a>
          <a href="/change-password">Change password</a>`,
        );
      case '/privacy':
        return html(200, '<h1>Privacy notice</h1><a href="/grievance">Grievance officer</a>');
      case '/consent-settings':
        return html(
          200,
          `<form method="post"><label><input type="checkbox" name="marketing_consent"> I consent to offers</label>
          <p>We use this for the purpose of marketing.</p></form>`,
        );
      case '/change-password':
        return html(
          200,
          '<form method="post"><input type="password" name="current"><input type="password" name="next"></form>',
        );
      case '/data-request':
      case '/grievance':
      case '/transactions/12345':
      case '/members/asha@example.in':
        return html(200, '<p>ok</p>');
      default:
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('missing');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  requested.length = 0;
  dropSessionAfter = Infinity;
  inlineLoginAfter = Infinity;
  served = 0;
});

const site = (overrides: Partial<AuthenticatedWebsiteSite> = {}): AuthenticatedWebsiteSite => ({
  tenantId: TENANT,
  connectorId: CONNECTOR,
  descriptorId: '41440000-0000-4000-8000-000000000003',
  baseUrl: base,
  startPaths: ['/account'],
  auth: {
    mode: 'form_login',
    loginPath: '/login',
    usernameField: 'email',
    passwordField: 'password',
  },
  credential: {
    id: '76760000-0000-4000-8000-000000000003',
    revision: 1,
    expiresAt: Date.now() + 60_000,
    file: '/run/x.json',
  },
  maxPages: 25,
  ...overrides,
});
const credential = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1 as const,
  tenantId: TENANT,
  connectorId: CONNECTOR,
  credentialId: '76760000-0000-4000-8000-000000000003',
  revision: 1,
  expiresAt: Date.now() + 60_000,
  username: 'demo.owner@example.in',
  secret: PASSWORD,
  ...overrides,
});
const crawl = (s = site(), c = credential()) =>
  crawlAuthenticatedWebsite(s, c, 'sandbox', 'test', AbortSignal.timeout(10_000));

describe('signed-in website crawl', () => {
  it('logs in once, crawls GET-only, and records structure without any page text or secret', async () => {
    const scan = await crawl();
    expect(scan.pages.map((p) => p.path).sort()).toEqual([
      '/account',
      '/change-password',
      '/consent-settings',
      '/data-request',
      '/grievance',
      '/members/:redacted',
      '/privacy',
      '/transactions/:id',
    ]);
    expect(scan.evidence).toMatchObject({
      privacyNotice: ['/privacy'],
      accessRequest: ['/data-request'],
      erasure: ['/account/delete'],
      grievance: ['/grievance'],
      cookiesBeforeLogin: ['tracking_id'],
      cookiesAfterLogin: ['sid'],
      transportSecure: false,
      sessionLost: false,
    });
    expect(scan.evidence.consentControls).toContain('/consent-settings');
    const profile = scan.pages.find((p) => p.path === '/account')!.forms[0]!;
    expect(profile.fields.map((f) => f.name)).toEqual([
      'full_name',
      'email',
      'mobile',
      'pan_no',
      'date_of_birth',
      'notes',
    ]);
    expect(profile.fields.find((f) => f.name === 'pan_no')?.categories).toEqual(['identity']);
    expect(profile).toMatchObject({ consentControl: false, purposeText: false });
    expect(scan.pages.find((p) => p.path === '/consent-settings')!.forms[0]).toMatchObject({
      consentControl: true,
      purposeText: true,
    });
    // Account actions are recorded but never requested; only the login is a POST.
    expect(scan.skipped).toEqual(
      expect.arrayContaining([
        { path: '/account/delete', reason: 'account_action_not_followed' },
        { path: '/logout', reason: 'account_action_not_followed' },
      ]),
    );
    expect(requested.filter((r) => /logout|delete/.test(r))).toEqual([]);
    expect(requested.filter((r) => r.startsWith('POST'))).toEqual(['POST /login']);
    const serialized = JSON.stringify(scan);
    for (const secret of [
      'Asha Rao',
      'asha@example.in',
      '9876543210',
      'ABCDE1234F',
      'private note',
      PASSWORD,
      SESSION,
      'abc123',
      't0k3n',
      'elsewhere.example',
    ])
      expect(serialized).not.toContain(secret);
  });

  it('refuses a wrong password without crawling', async () => {
    await expect(crawl(site(), credential({ secret: 'wrong-password-123' }))).rejects.toMatchObject(
      {
        code: 'login_failed',
      },
    );
    expect(requested.filter((r) => r.startsWith('GET /account'))).toEqual([]);
  });

  it('supports bearer-token sessions', async () => {
    const scan = await crawl(
      site({ auth: { mode: 'bearer' } }),
      credential({ username: undefined, secret: TOKEN }),
    );
    expect(scan.authMode).toBe('bearer');
    expect(scan.pages.length).toBeGreaterThan(3);
    expect(requested.some((r) => r.includes('/login'))).toBe(false);
  });

  it('stops when the session falls back to the login page', async () => {
    // The post-login redirect itself serves /account once.
    dropSessionAfter = 3;
    const scan = await crawl();
    expect(scan.evidence.sessionLost).toBe(true);
    expect(scan.pages).toHaveLength(2);
    expect(scan.skipped.at(-1)?.reason).toBe('session_lost');
  });

  it('stops when the login form reappears in place, but not on a change-password page', async () => {
    inlineLoginAfter = 3;
    const scan = await crawl();
    expect(scan.evidence.sessionLost).toBe(true);
    expect(scan.pages).toHaveLength(2);
    expect(scan.skipped.at(-1)?.reason).toBe('session_lost');
  });

  it('honours the page budget', async () => {
    const scan = await crawl(site({ maxPages: 3 }));
    expect(scan.pages).toHaveLength(3);
  });
});

describe('site origin and credential rules', () => {
  it('keeps sandbox hosts local and production sites on public HTTPS', () => {
    expect(
      siteOrigin({ baseUrl: 'http://axiom-portal-nimbus:8080' }, 'sandbox', 'local').origin,
    ).toBe('http://axiom-portal-nimbus:8080');
    for (const [url, binding, env, code] of [
      ['http://portal.example.com', 'sandbox', 'local', 'sandbox_host_refused'],
      ['http://axiom-portal-nimbus:8080', 'sandbox', 'production', 'sandbox_in_production'],
      ['http://portal.kosha.in', 'production', 'production', 'https_required'],
      ['https://user:pw@portal.kosha.in', 'production', 'production', 'invalid_url'],
    ] as const)
      expect(() => siteOrigin({ baseUrl: url }, binding, env)).toThrow(
        new AuthenticatedWebsiteRefused(code),
      );
    expect(() =>
      siteOrigin({ baseUrl: 'https://127.0.0.1' }, 'production', 'production'),
    ).toThrow();
  });

  it('generalises identifiers in paths', () => {
    expect(normalisePath('/users/42/orders/3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe(
      '/users/:id/orders/:id',
    );
    expect(normalisePath('/members/asha%40example.in')).toBe('/members/:redacted');
  });

  it('accepts only the pinned, unexpired credential for the configured site', async () => {
    const read = (value: unknown) => async () => Buffer.from(JSON.stringify(value));
    await expect(readSiteCredential(site(), read(credential()))).resolves.toMatchObject({
      username: 'demo.owner@example.in',
    });
    for (const change of [
      { connectorId: '76760000-0000-4000-8000-000000000009' },
      { revision: 2 },
      { expiresAt: Date.now() - 1 },
      { username: undefined },
      { extra: 'field' },
    ])
      await expect(readSiteCredential(site(), read(credential(change)))).rejects.toMatchObject({
        code: 'credential_unavailable',
      });
  });
});
