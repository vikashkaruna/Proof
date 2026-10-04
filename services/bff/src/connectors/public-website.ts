import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import {
  extractPublicFormMetadata,
  parsePublicHtml,
  publicHtmlElements,
  publicHtmlText,
  type PublicHtmlDocument,
  type PublicFormMetadata,
} from './public-form-metadata.js';

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
const AUDIT_KINDS = ['privacy', 'contact', 'terms'] as const;
type AuditKind = (typeof AUDIT_KINDS)[number];

export class PublicWebsiteRefused extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** A deliberately narrow first target: ordinary public DNS names over 80/443. */
export function parsePublicUrl(value: string): URL {
  if (value.length > 2_048) throw new PublicWebsiteRefused('invalid_url');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicWebsiteRefused('invalid_url');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    isIP(url.hostname) !== 0 ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(url.hostname) ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)
  )
    throw new PublicWebsiteRefused('invalid_url');
  url.hash = '';
  return url;
}

/** Reject non-global IPv4 space, including metadata, carrier NAT and documentation ranges. */
export function isPublicIPv4(value: string): boolean {
  if (isIP(value) !== 4) return false;
  const [a = 0, b = 0, c = 0] = value.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || (b === 88 && c === 99) || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

export interface WebsitePage {
  status: number;
  contentType: string;
  location?: string;
  body: Buffer;
}

/** The request uses the validated DNS answer as its socket destination while preserving Host/SNI. */
export function fetchPinnedPage(
  url: URL,
  address: string,
  signal: AbortSignal,
): Promise<WebsitePage> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'GET',
        headers: {
          accept: 'text/html',
          'accept-encoding': 'identity',
          'user-agent': 'AxiomProof-PublicWebsiteCheck/1.0',
        },
        family: 4,
        // A pooled socket can bypass this request's DNS lookup. Force a fresh
        // connection so every hop uses the address validated immediately above.
        agent: false,
        lookup: (_hostname, _options, callback) => callback(null, address, 4),
        timeout: TIMEOUT_MS,
        signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (
          response.headers['content-encoding'] &&
          response.headers['content-encoding'] !== 'identity'
        ) {
          response.destroy();
          reject(new PublicWebsiteRefused('unsupported_content_encoding'));
          return;
        }
        const length = Number(response.headers['content-length']);
        if (Number.isFinite(length) && length > MAX_BYTES) {
          response.destroy();
          reject(new PublicWebsiteRefused('response_too_large'));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) {
            response.destroy();
            reject(new PublicWebsiteRefused('response_too_large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            status,
            contentType: String(response.headers['content-type'] ?? ''),
            location: response.headers.location,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new PublicWebsiteRefused('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function extract(document: PublicHtmlDocument, base: URL) {
  // Only genuine public DOM nodes contribute summaries; controls and inert
  // subtrees cannot turn stored values or quoted markup into public evidence.
  const elements = [...publicHtmlElements(document, true)];
  let documentBase = base;
  const baseHref = elements
    .find((element) => element.tagName === 'base')
    ?.attrs.find((attribute) => attribute.name === 'href')?.value;
  if (baseHref) {
    try {
      documentBase = new URL(baseHref, base);
    } catch {
      // A malformed base is ignored by this limited extractor.
    }
  }
  const titleElement = elements.find((element) => element.tagName === 'title');
  const title = titleElement ? publicHtmlText(titleElement) : '';
  const headings = elements
    .filter((element) => element.tagName === 'h1' || element.tagName === 'h2')
    .slice(0, 12)
    .map(publicHtmlText)
    .filter(Boolean);
  const links: { label: string; url: string }[] = [];
  const linksPerKind = new Map<AuditKind, number>();
  for (const element of elements) {
    if (element.tagName !== 'a') continue;
    const href = element.attrs.find((attribute) => attribute.name === 'href')?.value;
    if (!href) continue;
    try {
      const target = new URL(href, documentBase);
      if (!['http:', 'https:'].includes(target.protocol)) continue;
      const label = publicHtmlText(element);
      const kind = auditKind({ label, url: target.href });
      if (
        kind &&
        !target.search &&
        !target.username &&
        !target.password &&
        target.origin === base.origin &&
        target.href.length <= 512 &&
        (linksPerKind.get(kind) ?? 0) < 2
      ) {
        links.push({ label: label.slice(0, 120), url: target.origin + target.pathname });
        linksPerKind.set(kind, (linksPerKind.get(kind) ?? 0) + 1);
      }
    } catch {
      // Ignore malformed public links.
    }
    if (links.length >= 6) break;
  }
  return { title, headings, publicLinks: links };
}

export interface WebsiteCheck {
  requestedUrl: string;
  finalUrl: string;
  checkedAt: string;
  status: 'checked';
  httpStatus: 200;
  bytes: number;
  contentSha256: string;
  title: string;
  headings: string[];
  publicLinks: { label: string; url: string }[];
  auditPages: AuditPage[];
  observations: AuditObservation[];
  formMetadata?: PublicFormMetadata;
}

export interface AuditPage {
  kind: AuditKind;
  requestedUrl: string;
  status: 'checked' | 'unavailable';
  finalUrl?: string;
  title?: string;
  contentSha256?: string;
  errorCode?: string;
  formMetadata?: PublicFormMetadata;
}

export interface AuditObservation {
  kind: AuditKind;
  status: 'retrieved' | 'not_linked' | 'unavailable';
}

function auditKind(link: { label: string; url: string }): AuditKind | undefined {
  const value = `${link.label} ${new URL(link.url).pathname}`;
  if (/privacy|data protection/i.test(value)) return 'privacy';
  if (/contact/i.test(value)) return 'contact';
  if (/terms/i.test(value)) return 'terms';
  return undefined;
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new PublicWebsiteRefused('timeout'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new PublicWebsiteRefused('timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(cause);
      },
    );
  });
}

async function checkSinglePage(
  requested: URL,
  signal: AbortSignal,
  deps: {
    resolve4?: (host: string) => Promise<string[]>;
    fetchPage?: (url: URL, address: string, signal: AbortSignal) => Promise<WebsitePage>;
  },
  allowedOrigin?: string,
): Promise<Omit<WebsiteCheck, 'auditPages' | 'observations'>> {
  let current = requested;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    if (allowedOrigin && current.origin !== allowedOrigin)
      throw new PublicWebsiteRefused('off_site_redirect');
    let addresses: string[];
    try {
      addresses = await abortable((deps.resolve4 ?? dns.resolve4)(current.hostname), signal);
    } catch (cause) {
      if (cause instanceof PublicWebsiteRefused) throw cause;
      throw new PublicWebsiteRefused('dns_unavailable');
    }
    if (addresses.length === 0 || addresses.some((address) => !isPublicIPv4(address)))
      throw new PublicWebsiteRefused('non_public_target');
    let page: WebsitePage;
    try {
      page = await (deps.fetchPage ?? fetchPinnedPage)(current, addresses[0]!, signal);
    } catch (cause) {
      if (cause instanceof PublicWebsiteRefused) throw cause;
      throw new PublicWebsiteRefused(signal.aborted ? 'timeout' : 'unreachable');
    }
    if ([301, 302, 303, 307, 308].includes(page.status)) {
      if (!page.location || redirects === MAX_REDIRECTS)
        throw new PublicWebsiteRefused('redirect_refused');
      current = parsePublicUrl(new URL(page.location, current).href);
      continue;
    }
    if (page.status !== 200) throw new PublicWebsiteRefused('http_status');
    if (!/^text\/html(?:\s*;|$)/i.test(page.contentType))
      throw new PublicWebsiteRefused('unsupported_content_type');
    if (page.body.length > MAX_BYTES) throw new PublicWebsiteRefused('response_too_large');
    const document = parsePublicHtml(page.body.toString('utf8'));
    const contentSha256 = createHash('sha256').update(page.body).digest('hex');
    return {
      requestedUrl: requested.href,
      finalUrl: current.href,
      checkedAt: new Date().toISOString(),
      status: 'checked',
      httpStatus: 200,
      bytes: page.body.length,
      contentSha256,
      formMetadata: extractPublicFormMetadata(document, contentSha256),
      ...extract(document, current),
    };
  }
  throw new PublicWebsiteRefused('redirect_refused');
}

/** Check the starting page and at most one same-origin public page per notice kind. */
export async function checkPublicWebsite(
  rawUrl: string,
  signal: AbortSignal,
  deps: {
    resolve4?: (host: string) => Promise<string[]>;
    fetchPage?: (url: URL, address: string, signal: AbortSignal) => Promise<WebsitePage>;
  } = {},
): Promise<WebsiteCheck> {
  const root = await checkSinglePage(parsePublicUrl(rawUrl), signal, deps);
  const origin = new URL(root.finalUrl).origin;
  const auditPages: AuditPage[] = [];
  const observations: AuditObservation[] = [];
  const seen = new Set([root.finalUrl]);
  for (const kind of AUDIT_KINDS) {
    const rootKind = auditKind({ label: '', url: root.finalUrl });
    if (rootKind === kind) {
      observations.push({ kind, status: 'retrieved' });
      continue;
    }
    const candidate = root.publicLinks.find((link) => {
      if (auditKind(link) !== kind) return false;
      try {
        const url = parsePublicUrl(link.url);
        return url.origin === origin && !seen.has(url.href);
      } catch {
        return false;
      }
    });
    if (!candidate) {
      observations.push({ kind, status: 'not_linked' });
      continue;
    }
    const url = parsePublicUrl(candidate.url);
    seen.add(url.href);
    try {
      const page = await checkSinglePage(url, signal, deps, origin);
      auditPages.push({
        kind,
        requestedUrl: url.href,
        status: 'checked',
        finalUrl: page.finalUrl,
        title: page.title,
        contentSha256: page.contentSha256,
        formMetadata: page.formMetadata,
      });
      observations.push({ kind, status: 'retrieved' });
    } catch (cause) {
      if (signal.aborted) throw new PublicWebsiteRefused('timeout');
      auditPages.push({
        kind,
        requestedUrl: url.href,
        status: 'unavailable',
        errorCode: cause instanceof PublicWebsiteRefused ? cause.code : 'unreachable',
      });
      observations.push({ kind, status: 'unavailable' });
    }
  }
  return { ...root, auditPages, observations };
}
