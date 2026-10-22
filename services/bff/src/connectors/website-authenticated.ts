/**
 * W4.7 signed-in website connector. Logs in with a credential held only in
 * protected deployment configuration, then crawls a bounded set of same-origin
 * pages with GET requests and records page STRUCTURE only: normalised paths,
 * content digests, form field names with personal-data category hints, and
 * which notice, consent and rights paths are reachable. No page body, title,
 * heading, field value or cookie value is retained or returned: a signed-in
 * page shows the account holder's own data, so text from it is never evidence.
 *
 * Safety rules shared by every website plug-in:
 * - one origin, fixed by reviewed configuration; DNS pinned per request;
 * - the only non-GET request is the declared login form POST;
 * - links that look like account actions (log out, delete, pay, unsubscribe,
 *   cancel, remove, deactivate) are recorded but never followed;
 * - at most 25 pages, depth 2, 512 KiB per page, 3 same-origin redirects;
 * - the crawl stops when the session falls back to the login page.
 */
import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { DefaultTreeAdapterMap } from 'parse5';
import { categoryHints } from './profile.js';
import { controllerFilePath, readControllerFile } from '../workloads/controller-files.js';
import { parsePrativedanAssessmentJson } from '../services/prativedan-assessment-json.js';
import {
  fetchPinnedPage,
  isPublicIPv4,
  parsePublicUrl,
  type PinnedRequestOptions,
  type WebsitePage,
} from './public-website.js';
import { parsePublicHtml, publicHtmlElements } from './public-form-metadata.js';
import { websitePluginFor } from './framework/plugins.js';

type Element = DefaultTreeAdapterMap['element'];
type Node = DefaultTreeAdapterMap['node'];

export const AUTHENTICATED_WEBSITE_SCAN_VERSION = 'authenticated-website-scan/1' as const;
const MAX_PAGES = 25;
const MAX_DEPTH = 2;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'AxiomProof-SignedInWebsiteCheck/1.0';
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

export class AuthenticatedWebsiteRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AuthenticatedWebsiteRefused';
  }
}

const sitePath = z
  .string()
  .max(300)
  .regex(/^\/[A-Za-z0-9._~\/-]*$/)
  .refine((path) => !path.split('/').some((segment) => segment === '..'));
const fieldName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.\-[\]]{0,79}$/);
const lowerUuid = z.uuid().transform((value) => value.toLowerCase());
export const AuthenticatedWebsiteConfiguration = z
  .object({
    schemaVersion: z.literal(1),
    environment: z.enum(['local', 'test', 'production']),
    sites: z
      .array(
        z
          .object({
            tenantId: lowerUuid,
            connectorId: lowerUuid,
            descriptorId: lowerUuid,
            baseUrl: z.string().url().max(2048),
            startPaths: z.array(sitePath).min(1).max(10),
            auth: z.discriminatedUnion('mode', [
              z
                .object({
                  mode: z.literal('form_login'),
                  loginPath: sitePath,
                  usernameField: fieldName,
                  passwordField: fieldName,
                })
                .strict(),
              z.object({ mode: z.literal('bearer') }).strict(),
              z.object({ mode: z.literal('basic') }).strict(),
            ]),
            credential: z
              .object({
                id: z.uuid(),
                revision: z.number().int().positive(),
                expiresAt: z.number().int().positive(),
                file: controllerFilePath,
              })
              .strict(),
            maxPages: z.number().int().min(1).max(MAX_PAGES).default(MAX_PAGES),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type AuthenticatedWebsiteSite = z.infer<
  typeof AuthenticatedWebsiteConfiguration
>['sites'][number];

const credentialFile = z
  .object({
    schemaVersion: z.literal(1),
    tenantId: z.uuid(),
    connectorId: z.uuid(),
    credentialId: z.uuid(),
    revision: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    username: z.string().min(1).max(320).optional(),
    secret: z.string().min(8).max(4096),
  })
  .strict();
type Credential = z.infer<typeof credentialFile>;

export interface ScanForm {
  method: 'get' | 'post' | 'dialog';
  fields: { name: string; categories: string[] }[];
  /** A checkbox or radio whose label/name speaks of consent or agreement. */
  consentControl: boolean;
  /** The form's visible text names a purpose, privacy notice or consent. */
  purposeText: boolean;
}
export interface ScanPage {
  path: string;
  depth: number;
  contentSha256: string;
  forms: ScanForm[];
}
export interface AuthenticatedWebsiteScan {
  version: typeof AUTHENTICATED_WEBSITE_SCAN_VERSION;
  baseUrl: string;
  authMode: AuthenticatedWebsiteSite['auth']['mode'];
  checkedAt: string;
  pages: ScanPage[];
  skipped: { path: string; reason: string }[];
  evidence: {
    privacyNotice: string[];
    consentControls: string[];
    accessRequest: string[];
    erasure: string[];
    correction: string[];
    grievance: string[];
    cookiesBeforeLogin: string[];
    cookiesAfterLogin: string[];
    transportSecure: boolean;
    sessionLost: boolean;
  };
}

/** Links that look like account actions are never followed. */
const DENIED =
  /log-?out|sign-?out|delete|remove|deactivat|unsubscribe|cancel|close-?account|checkout|\bpay\b|payment\/new|transfer|withdraw-?funds/i;
const RIGHTS: Record<
  'privacyNotice' | 'consentControls' | 'accessRequest' | 'erasure' | 'correction' | 'grievance',
  RegExp
> = {
  privacyNotice: /privacy|data protection notice/i,
  consentControls: /consent|preferences|cookie settings|communication settings|withdraw/i,
  accessRequest:
    /download (my |your )?data|export (my |your )?data|data (access|request|download)|access request|my data|request (a copy|your data)/i,
  erasure: /delete (my |your )?(account|data)|erase|erasure|close (my )?account|delete-account/i,
  correction: /edit profile|update (my )?(profile|details)|correct(ion)?|profile settings/i,
  grievance: /grievance|complaint|data protection officer|\bdpo\b/i,
};
const CONSENT_WORDS = /consent|agree|terms|privacy|purpose/i;

function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name === name)?.value;
}
/** Visible text of a subtree, skipping script/style and editable content
 * (textarea bodies and input values are never read). */
function visibleText(root: Node): string {
  const parts: string[] = [];
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (
      'tagName' in node &&
      ['script', 'style', 'textarea', 'template', 'noscript'].includes(node.tagName)
    )
      continue;
    if (node.nodeName === '#text' && 'value' in node) parts.push(node.value);
    if ('childNodes' in node)
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
}

/** Path with identifiers generalised: numeric, UUID-like and email-like
 * segments become placeholders so no account identifier is retained. */
export function normalisePath(pathname: string): string {
  return (
    pathname
      .split('/')
      .map((segment) =>
        /^\d+$/.test(segment) || /^[0-9a-f-]{16,}$/i.test(segment)
          ? ':id'
          : segment.includes('@') || segment.includes('%40')
            ? ':redacted'
            : segment.slice(0, 80),
      )
      .join('/')
      .slice(0, 300) || '/'
  );
}

function formsOf(document: ReturnType<typeof parsePublicHtml>): {
  forms: ScanForm[];
} {
  const forms: ScanForm[] = [];
  for (const form of publicHtmlElements(document)) {
    if (form.tagName !== 'form' || forms.length >= 20) continue;
    const fields: ScanForm['fields'] = [];
    let consentControl = false;
    for (const control of publicHtmlElements(form)) {
      if (!['input', 'select', 'textarea'].includes(control.tagName)) continue;
      const type = (attr(control, 'type') ?? 'text').toLowerCase();
      const name = (attr(control, 'name') ?? attr(control, 'id') ?? '').slice(0, 80);
      if (['checkbox', 'radio'].includes(type) && CONSENT_WORDS.test(name)) consentControl = true;
      if (['hidden', 'password', 'submit', 'button', 'image', 'reset', 'file'].includes(type))
        continue;
      if (!/^[A-Za-z_][A-Za-z0-9_.\-[\]]{0,79}$/.test(name) || fields.length >= 40) continue;
      fields.push({ name, categories: categoryHints(name) });
    }
    const text = visibleText(form);
    if (!consentControl)
      for (const label of publicHtmlElements(form))
        if (label.tagName === 'label' && CONSENT_WORDS.test(visibleText(label))) {
          const target = attr(label, 'for');
          const owned = [...publicHtmlElements(form)].some(
            (control) =>
              control.tagName === 'input' &&
              ['checkbox', 'radio'].includes((attr(control, 'type') ?? '').toLowerCase()) &&
              (target === undefined || attr(control, 'id') === target),
          );
          if (owned) consentControl = true;
        }
    const declared = (attr(form, 'method') ?? '').toLowerCase();
    forms.push({
      method: declared === 'post' || declared === 'dialog' ? declared : 'get',
      fields,
      consentControl,
      purposeText: /purpose|privacy (notice|policy)|consent|why we (collect|need)/i.test(text),
    });
  }
  return { forms };
}

/** True when the page shows the configured login form (both its username
 * and password fields): the session is gone. A change-password form, which
 * has password inputs but not the login username field, does not count. */
function showsLoginForm(
  document: ReturnType<typeof parsePublicHtml>,
  auth: Extract<AuthenticatedWebsiteSite['auth'], { mode: 'form_login' }>,
): boolean {
  return [...publicHtmlElements(document)].some((form) => {
    if (form.tagName !== 'form') return false;
    const names = new Set(
      [...publicHtmlElements(form)].map((control) => attr(control, 'name')).filter(Boolean),
    );
    return names.has(auth.usernameField) && names.has(auth.passwordField);
  });
}

interface Deps {
  resolve4?: (host: string) => Promise<string[]>;
  fetchPage?: (
    url: URL,
    address: string,
    signal: AbortSignal,
    options: PinnedRequestOptions,
  ) => Promise<WebsitePage>;
  readCredential?: (file: string) => Promise<Buffer>;
  now?: () => number;
}

/** The single origin a site may be crawled on, fixed by reviewed configuration. */
export function siteOrigin(
  site: Pick<AuthenticatedWebsiteSite, 'baseUrl'>,
  targetBinding: 'production' | 'sandbox',
  environment: 'local' | 'test' | 'production',
): URL {
  const plugin = websitePluginFor('website-authenticated')!;
  let base: URL;
  try {
    base = new URL(site.baseUrl);
  } catch {
    throw new AuthenticatedWebsiteRefused('invalid_url');
  }
  if (base.username || base.password || base.search || base.hash)
    throw new AuthenticatedWebsiteRefused('invalid_url');
  if (targetBinding === 'sandbox') {
    if (environment === 'production')
      throw new AuthenticatedWebsiteRefused('sandbox_in_production');
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      !(LOCAL_HOSTS.includes(base.hostname) || plugin.sandboxHost.test(base.hostname))
    )
      throw new AuthenticatedWebsiteRefused('sandbox_host_refused');
    return new URL(base.origin);
  }
  // Production: HTTPS on an ordinary public DNS name (the public check's rules).
  if (base.protocol !== 'https:') throw new AuthenticatedWebsiteRefused('https_required');
  return new URL(parsePublicUrl(base.origin + '/').origin);
}

export async function crawlAuthenticatedWebsite(
  site: AuthenticatedWebsiteSite,
  credential: Credential,
  targetBinding: 'production' | 'sandbox',
  environment: 'local' | 'test' | 'production',
  signal: AbortSignal,
  deps: Deps = {},
): Promise<AuthenticatedWebsiteScan> {
  const origin = siteOrigin(site, targetBinding, environment);
  const cookies = new Map<string, string>();
  const cookiesBeforeLogin = new Set<string>();
  // Cookies set while browsing anonymously, before any credential is sent.
  let anonymous = true;
  const fetchPage = deps.fetchPage ?? fetchPinnedPage;

  async function address(url: URL): Promise<string> {
    if (url.origin !== origin.origin) throw new AuthenticatedWebsiteRefused('off_site');
    if (isIP(url.hostname) === 4) return url.hostname;
    if (url.hostname === 'localhost') return '127.0.0.1';
    let addresses: string[];
    try {
      addresses = await (deps.resolve4 ?? dns.resolve4)(url.hostname);
    } catch {
      throw new AuthenticatedWebsiteRefused('dns_unavailable');
    }
    if (addresses.length === 0) throw new AuthenticatedWebsiteRefused('dns_unavailable');
    // Sandbox demo hosts live on the private app network by design; anything
    // else must resolve only to public addresses.
    if (targetBinding === 'production' && addresses.some((a) => !isPublicIPv4(a)))
      throw new AuthenticatedWebsiteRefused('non_public_target');
    return addresses[0]!;
  }
  function headers(): Record<string, string> {
    const result: Record<string, string> = {};
    if (cookies.size) result.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (site.auth.mode === 'bearer') result.authorization = `Bearer ${credential.secret}`;
    if (site.auth.mode === 'basic')
      result.authorization = `Basic ${Buffer.from(`${credential.username ?? ''}:${credential.secret}`).toString('base64')}`;
    return result;
  }
  function keepCookies(page: WebsitePage) {
    for (const raw of page.setCookie ?? []) {
      const [pair] = raw.split(';');
      const index = pair?.indexOf('=') ?? -1;
      if (!pair || index < 1) continue;
      const name = pair.slice(0, index).trim();
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(name)) continue;
      cookies.set(name, pair.slice(index + 1).trim());
      if (anonymous) cookiesBeforeLogin.add(name);
    }
  }
  /** GET (or the one login POST) with same-origin redirects only. */
  async function request(
    start: URL,
    options: PinnedRequestOptions = {},
  ): Promise<{ page: WebsitePage; url: URL }> {
    let current = start;
    let next: PinnedRequestOptions = options;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      if (signal.aborted) throw new AuthenticatedWebsiteRefused('timeout');
      const page = await fetchPage(current, await address(current), signal, {
        ...next,
        userAgent: USER_AGENT,
        headers: { ...headers(), ...next.headers },
      }).catch((cause: unknown) => {
        if (cause instanceof AuthenticatedWebsiteRefused) throw cause;
        throw new AuthenticatedWebsiteRefused(signal.aborted ? 'timeout' : 'unreachable');
      });
      keepCookies(page);
      if ([301, 302, 303, 307, 308].includes(page.status)) {
        if (!page.location || redirects === MAX_REDIRECTS)
          throw new AuthenticatedWebsiteRefused('redirect_refused');
        current = new URL(page.location, current);
        if (current.origin !== origin.origin)
          throw new AuthenticatedWebsiteRefused('off_site_redirect');
        // A redirect is always followed with GET and no body.
        next = {};
        continue;
      }
      if (page.body.length > MAX_BYTES) throw new AuthenticatedWebsiteRefused('response_too_large');
      return { page, url: current };
    }
    throw new AuthenticatedWebsiteRefused('redirect_refused');
  }

  const isHtml = (page: WebsitePage) =>
    page.status === 200 && /^text\/html(?:\s*;|$)/i.test(page.contentType);

  // ---- Login ---------------------------------------------------------------
  const loginPath = site.auth.mode === 'form_login' ? site.auth.loginPath : null;
  if (site.auth.mode === 'form_login') {
    const login = await request(new URL(site.auth.loginPath, origin));
    if (!isHtml(login.page)) throw new AuthenticatedWebsiteRefused('login_page_unavailable');
    const document = parsePublicHtml(login.page.body.toString('utf8'));
    const form = [...publicHtmlElements(document)].find(
      (element) =>
        element.tagName === 'form' &&
        [...publicHtmlElements(element)].some(
          (control) =>
            attr(control, 'name') === (site.auth as { passwordField: string }).passwordField,
        ),
    );
    if (!form) throw new AuthenticatedWebsiteRefused('login_form_missing');
    const action = new URL(attr(form, 'action') || site.auth.loginPath, login.url);
    if (action.origin !== origin.origin) throw new AuthenticatedWebsiteRefused('off_site_login');
    // Server-issued hidden fields (CSRF tokens) are echoed; nothing else is.
    const fields = new URLSearchParams();
    for (const control of publicHtmlElements(form))
      if (
        control.tagName === 'input' &&
        (attr(control, 'type') ?? '').toLowerCase() === 'hidden' &&
        attr(control, 'name')
      )
        fields.set(attr(control, 'name')!, attr(control, 'value') ?? '');
    fields.set(site.auth.usernameField, credential.username ?? '');
    fields.set(site.auth.passwordField, credential.secret);
    anonymous = false;
    const result = await request(action, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: Buffer.from(fields.toString(), 'utf8'),
    });
    const stillLogin =
      normalisePath(result.url.pathname) === normalisePath(site.auth.loginPath) ||
      (isHtml(result.page) &&
        showsLoginForm(parsePublicHtml(result.page.body.toString('utf8')), site.auth));
    if (stillLogin) throw new AuthenticatedWebsiteRefused('login_failed');
  }
  anonymous = false;

  // ---- Crawl ----------------------------------------------------------------
  const pages: ScanPage[] = [];
  const skipped: AuthenticatedWebsiteScan['skipped'] = [];
  const evidence: AuthenticatedWebsiteScan['evidence'] = {
    privacyNotice: [],
    consentControls: [],
    accessRequest: [],
    erasure: [],
    correction: [],
    grievance: [],
    cookiesBeforeLogin: [],
    cookiesAfterLogin: [],
    transportSecure: origin.protocol === 'https:',
    sessionLost: false,
  };
  const note = (key: keyof typeof RIGHTS, path: string) => {
    if (!evidence[key].includes(path) && evidence[key].length < 20) evidence[key].push(path);
  };
  const seen = new Set<string>();
  const queue: { url: URL; depth: number }[] = site.startPaths.map((path) => ({
    url: new URL(path, origin),
    depth: 0,
  }));
  while (queue.length && pages.length < site.maxPages) {
    const { url, depth } = queue.shift()!;
    const key = url.pathname;
    if (seen.has(key)) continue;
    seen.add(key);
    const path = normalisePath(url.pathname);
    if (DENIED.test(url.pathname)) {
      skipped.push({ path, reason: 'account_action_not_followed' });
      continue;
    }
    if (loginPath && normalisePath(url.pathname) === normalisePath(loginPath)) continue;
    let outcome;
    try {
      outcome = await request(url);
    } catch (cause) {
      if (signal.aborted) throw new AuthenticatedWebsiteRefused('timeout');
      skipped.push({
        path,
        reason: cause instanceof AuthenticatedWebsiteRefused ? cause.code : 'unreachable',
      });
      continue;
    }
    if (loginPath && normalisePath(outcome.url.pathname) === normalisePath(loginPath)) {
      evidence.sessionLost = true;
      skipped.push({ path, reason: 'session_lost' });
      break;
    }
    if (!isHtml(outcome.page)) {
      skipped.push({ path, reason: outcome.page.status === 200 ? 'not_html' : 'http_status' });
      continue;
    }
    const document = parsePublicHtml(outcome.page.body.toString('utf8'));
    const { forms } = formsOf(document);
    if (site.auth.mode === 'form_login' && showsLoginForm(document, site.auth)) {
      evidence.sessionLost = true;
      skipped.push({ path, reason: 'session_lost' });
      break;
    }
    pages.push({
      path,
      depth,
      contentSha256: createHash('sha256').update(outcome.page.body).digest('hex'),
      forms,
    });
    for (const [rights, pattern] of Object.entries(RIGHTS) as [keyof typeof RIGHTS, RegExp][])
      if (pattern.test(url.pathname)) note(rights, path);
    for (const link of publicHtmlElements(document)) {
      if (link.tagName !== 'a') continue;
      const href = attr(link, 'href');
      if (!href) continue;
      let target: URL;
      try {
        target = new URL(href, outcome.url);
      } catch {
        continue;
      }
      if (target.origin !== origin.origin) continue;
      target.search = '';
      target.hash = '';
      const label = visibleText(link).slice(0, 120);
      const targetPath = normalisePath(target.pathname);
      for (const [rights, pattern] of Object.entries(RIGHTS) as [keyof typeof RIGHTS, RegExp][])
        if (pattern.test(`${label} ${target.pathname}`)) note(rights, targetPath);
      if (DENIED.test(`${label} ${target.pathname}`)) {
        if (!seen.has(target.pathname)) {
          seen.add(target.pathname);
          skipped.push({ path: targetPath, reason: 'account_action_not_followed' });
        }
        continue;
      }
      if (depth < MAX_DEPTH && !seen.has(target.pathname) && queue.length < 200)
        queue.push({ url: target, depth: depth + 1 });
    }
  }
  if (pages.length === 0) throw new AuthenticatedWebsiteRefused('no_pages_read');
  evidence.cookiesBeforeLogin = [...cookiesBeforeLogin].sort().slice(0, 50);
  evidence.cookiesAfterLogin = [...cookies.keys()]
    .filter((name) => !cookiesBeforeLogin.has(name))
    .sort()
    .slice(0, 50);
  cookies.clear();
  return {
    version: AUTHENTICATED_WEBSITE_SCAN_VERSION,
    baseUrl: site.baseUrl,
    authMode: site.auth.mode,
    checkedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    pages,
    skipped: skipped.slice(0, 200),
    evidence,
  };
}

/** Reads and checks the pinned credential for one configured site. The bytes
 * are erased after parsing; the secret is used for this run only. */
export async function readSiteCredential(
  site: AuthenticatedWebsiteSite,
  read: (file: string) => Promise<Buffer> = readControllerFile,
  now: () => number = Date.now,
): Promise<Credential> {
  let bytes: Buffer | undefined;
  try {
    bytes = await read(site.credential.file);
    const value = credentialFile.parse(
      parsePrativedanAssessmentJson(new TextDecoder('utf8', { fatal: true }).decode(bytes)),
    );
    if (
      value.tenantId.toLowerCase() !== site.tenantId ||
      value.connectorId.toLowerCase() !== site.connectorId ||
      value.credentialId !== site.credential.id ||
      value.revision !== site.credential.revision ||
      value.expiresAt !== site.credential.expiresAt ||
      value.expiresAt <= now() ||
      (site.auth.mode !== 'bearer' && !value.username)
    )
      throw new Error();
    return value;
  } catch {
    throw new AuthenticatedWebsiteRefused('credential_unavailable');
  } finally {
    bytes?.fill(0);
  }
}

export async function loadAuthenticatedWebsiteConfiguration(
  filename: string | undefined,
  environment: string,
) {
  if (filename === undefined) return undefined;
  let bytes: Buffer | undefined;
  try {
    bytes = await readControllerFile(filename);
    const config = AuthenticatedWebsiteConfiguration.parse(
      parsePrativedanAssessmentJson(new TextDecoder('utf8', { fatal: true }).decode(bytes)),
    );
    if (config.environment !== (environment === 'production' ? 'production' : environment))
      throw new Error();
    const keys = new Set<string>();
    for (const site of config.sites) {
      const key = `${site.tenantId}/${site.connectorId}`;
      if (keys.has(key)) throw new Error();
      keys.add(key);
    }
    return Object.freeze(config);
  } catch {
    throw new Error('Authenticated website configuration refused');
  } finally {
    bytes?.fill(0);
  }
}
