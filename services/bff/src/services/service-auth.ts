/**
 * Optional Google ID-token auth for the BFF's calls to the internal Cloud Run
 * services (agent runtime, model gateway).
 *
 * Defence in depth: this is added alongside, never instead of, the existing
 * X-Internal-Token / bearer headers. Cloud Run IAM reads
 * X-Serverless-Authorization, which leaves Authorization free for the
 * service's own bearer key.
 *
 * AXIOM_SERVICE_AUTH unset or empty => no headers, no network call (local,
 * staging, on-prem and tests). 'gcp-id-token' => fetch an ID token from the
 * metadata server. Any other value throws: a misconfiguration must never
 * silently disable auth. When the mode is on, a failed token fetch throws too
 * (fail closed); the request is never sent unauthenticated.
 */

export interface ServiceAuthDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  env?: Record<string, string | undefined>;
}

const METADATA_IDENTITY_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';
const METADATA_TIMEOUT_MS = 2_000;
/** Refresh this long before the token's own expiry. */
const EXPIRY_MARGIN_MS = 300_000;
/** Google ID tokens live one hour; used when `exp` cannot be read. */
const FALLBACK_TTL_MS = 50 * 60_000;

interface CachedToken {
  token: string;
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<string>>();

export function resetServiceAuthCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

/** Reads `exp` (ms) from the unverified JWT payload; null when unreadable. */
function tokenExpiryMs(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof claims !== 'object' || claims === null) return null;
    const exp = (claims as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

async function fetchIdToken(
  audience: string,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<string> {
  let token: string;
  try {
    const url = `${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(audience)}&format=full`;
    const response = await fetchImpl(url, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`metadata server returned ${response.status}`);
    }
    token = (await response.text()).trim();
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`service auth: could not obtain ID token for ${audience} (${reason})`);
  }
  if (!token) throw new Error(`service auth: empty ID token for ${audience}`);
  const exp = tokenExpiryMs(token);
  cache.set(audience, {
    token,
    expiresAt: exp === null ? now() + FALLBACK_TTL_MS : exp - EXPIRY_MARGIN_MS,
  });
  return token;
}

export async function serviceAuthHeaders(
  targetUrl: string,
  deps: ServiceAuthDeps = {},
): Promise<Record<string, string>> {
  const env = deps.env ?? process.env;
  const mode = env.AXIOM_SERVICE_AUTH;
  if (mode === undefined || mode === '') return {};
  if (mode !== 'gcp-id-token') {
    throw new Error(`service auth: unsupported AXIOM_SERVICE_AUTH value '${mode}'`);
  }
  const now = deps.now ?? Date.now;
  const audience = new URL(targetUrl).origin;
  const cached = cache.get(audience);
  if (cached && cached.expiresAt > now()) {
    return { 'X-Serverless-Authorization': `Bearer ${cached.token}` };
  }
  let pending = inflight.get(audience);
  if (!pending) {
    pending = fetchIdToken(audience, deps.fetchImpl ?? fetch, now).finally(() => {
      inflight.delete(audience);
    });
    inflight.set(audience, pending);
  }
  return { 'X-Serverless-Authorization': `Bearer ${await pending}` };
}
