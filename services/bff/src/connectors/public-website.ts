import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;

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

const codePoint = (value: number) =>
  Number.isInteger(value) && value > 0 && value <= 0x10ffff && (value < 0xd800 || value > 0xdfff)
    ? String.fromCodePoint(value)
    : '\ufffd';
const decode = (text: string) =>
  text
    .replace(/&#(\d+);/g, (_, value: string) => codePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_, value: string) => codePoint(parseInt(value, 16)))
    .replace(
      /&(amp|lt|gt|quot|apos|nbsp);/gi,
      (_, name: string) =>
        ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[
          name.toLowerCase() as 'amp' | 'lt' | 'gt' | 'quot' | 'apos' | 'nbsp'
        ],
    );
const plain = (html: string) =>
  decode(
    html
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ).slice(0, 300);

function extract(html: string, base: URL) {
  const safeHtml = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const title = plain(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(safeHtml)?.[1] ?? '');
  const headings = [...safeHtml.matchAll(/<h[1-2]\b[^>]*>([\s\S]*?)<\/h[1-2]>/gi)]
    .slice(0, 12)
    .map((match) => plain(match[1] ?? ''))
    .filter(Boolean);
  const links: { label: string; url: string }[] = [];
  for (const match of safeHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(match[1] ?? '')?.[1];
    if (!href) continue;
    try {
      const target = new URL(decode(href), base);
      if (!['http:', 'https:'].includes(target.protocol)) continue;
      const label = plain(match[2] ?? '');
      if (/privacy|contact|data protection|terms/i.test(`${label} ${target.pathname}`))
        links.push({ label, url: target.origin + target.pathname });
    } catch {
      // Ignore malformed links; a website check never follows discovered links.
    }
    if (links.length >= 12) break;
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

export async function checkPublicWebsite(
  rawUrl: string,
  signal: AbortSignal,
  deps: {
    resolve4?: (host: string) => Promise<string[]>;
    fetchPage?: (url: URL, address: string, signal: AbortSignal) => Promise<WebsitePage>;
  } = {},
): Promise<WebsiteCheck> {
  const requested = parsePublicUrl(rawUrl);
  let current = requested;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
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
    const html = page.body.toString('utf8');
    return {
      requestedUrl: requested.href,
      finalUrl: current.href,
      checkedAt: new Date().toISOString(),
      status: 'checked',
      httpStatus: 200,
      bytes: page.body.length,
      contentSha256: createHash('sha256').update(page.body).digest('hex'),
      ...extract(html, current),
    };
  }
  throw new PublicWebsiteRefused('redirect_refused');
}
