import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

const DB_TIMEOUT_MS = 25_000;
const CONTROL_TIMEOUT_MS = 5_000;
const METADATA_TIMEOUT_MS = 3_000;
const MAX_DB_RECEIPT_BYTES = 1024 * 1024;
const RETRY_AFTER_SECONDS = '5';

export type MarketingIdleConfig = {
  ENVIRONMENT: string;
  GCP_PROJECT_ID: string;
  GCP_REGION: string;
  AXIOM_IDLE_PROJECT_ID: string;
  AXIOM_IDLE_CONTROLLER_URL: string;
  AXIOM_IDLE_CONTROLLER_AUDIENCE: string;
  SUPABASE_URL: string;
};

type Tracker = { pending: number; uncertain: boolean; deadlineAt: number };

async function withinSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('Marketing request deadline expired');
  let rejectAbort: (reason: Error) => void = () => {};
  const onAbort = () => rejectAbort(new Error('Marketing request deadline expired'));
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function controllerOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.run.app') ||
    url.hostname === 'run.app' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.origin !== value
  ) {
    throw new Error('Invalid marketing idle controller configuration');
  }
  return url.origin;
}

/** One durable lease surrounds each DB-bound public HTTP execution. */
export function createMarketingIdleGate(
  config: MarketingIdleConfig,
  transport: typeof fetch = fetch,
) {
  if (
    config.ENVIRONMENT !== 'preprod' ||
    config.GCP_REGION !== 'asia-south1' ||
    !config.GCP_PROJECT_ID ||
    config.AXIOM_IDLE_PROJECT_ID !== config.GCP_PROJECT_ID ||
    controllerOrigin(config.AXIOM_IDLE_CONTROLLER_URL) !==
      controllerOrigin(config.AXIOM_IDLE_CONTROLLER_AUDIENCE) ||
    !controllerOrigin(config.SUPABASE_URL)
  ) {
    throw new Error('Invalid marketing idle controller configuration');
  }
  const origin = config.AXIOM_IDLE_CONTROLLER_URL;
  const storage = new AsyncLocalStorage<Tracker>();

  async function identityToken(audience: string, parentSignal?: AbortSignal): Promise<string> {
    const metadata = new URL(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity',
    );
    metadata.searchParams.set('audience', audience);
    metadata.searchParams.set('format', 'full');
    const signal = parentSignal
      ? AbortSignal.any([parentSignal, AbortSignal.timeout(METADATA_TIMEOUT_MS)])
      : AbortSignal.timeout(METADATA_TIMEOUT_MS);
    const response = await transport(metadata, {
      headers: { 'Metadata-Flavor': 'Google' },
      redirect: 'error',
      signal,
    });
    if (!response.ok || response.headers.get('Metadata-Flavor') !== 'Google')
      throw new Error('Identity token unavailable');
    const token = (await withinSignal(response.text(), signal)).trim();
    if (token.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
      throw new Error('Invalid identity token');
    return token;
  }

  async function controller(
    path: '/gate/acquire' | '/gate/release',
    body: object,
  ): Promise<Response> {
    const token = await identityToken(config.AXIOM_IDLE_CONTROLLER_AUDIENCE);
    return transport(`${origin}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
  }

  const databaseFetch: typeof fetch = async (input, init) => {
    const tracker = storage.getStore();
    if (!tracker) throw new Error('Marketing database request without idle lease');
    tracker.pending++;
    const remaining = Math.floor(tracker.deadlineAt - performance.now());
    if (remaining <= 0) {
      tracker.pending--;
      tracker.uncertain = true;
      throw new Error('Marketing database request deadline expired');
    }
    const timeout = AbortSignal.timeout(Math.min(DB_TIMEOUT_MS, remaining));
    const suppliedSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = suppliedSignal ? AbortSignal.any([suppliedSignal, timeout]) : timeout;
    try {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (
        target.origin !== config.SUPABASE_URL ||
        target.username ||
        target.password ||
        target.hash
      )
        throw new Error('Unexpected marketing database target');
      const token = await identityToken(config.SUPABASE_URL, signal);
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      headers.set('X-Serverless-Authorization', `Bearer ${token}`);
      const response = await transport(input, { ...init, headers, signal, redirect: 'error' });
      if (response.status >= 300 && response.status < 400)
        throw new Error('Database redirect refused');
      const receipt = await withinSignal(response.arrayBuffer(), signal);
      if (receipt.byteLength > MAX_DB_RECEIPT_BYTES) throw new Error('Oversized database response');
      const outcome = response.headers.get('X-Axiom-DB-Outcome');
      if (outcome === 'unknown' || (response.status >= 500 && outcome !== 'not-started'))
        tracker.uncertain = true;
      return new Response(response.status === 204 ? null : receipt, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      // An aborted network request does not prove the database stopped working.
      tracker.uncertain = true;
      throw new Error('Marketing database response uncertain');
    } finally {
      tracker.pending--;
    }
  };

  const middleware: MiddlewareHandler = async (c, next) => {
    if (c.req.path === '/public/contact/config' || c.req.path === '/public/gap-scan/config')
      return next();
    const body = { requestId: randomUUID(), leaseToken: randomBytes(32).toString('hex') };
    const unavailable = () => {
      c.header('Cache-Control', 'private, no-store');
      c.header('Retry-After', RETRY_AFTER_SECONDS);
      return c.json(
        {
          error: { code: 'service_unavailable', message: 'Please try again shortly.' },
          saved: false,
        },
        503,
      );
    };
    const uncertain = () => {
      c.header('Cache-Control', 'private, no-store');
      const response = c.json(
        {
          error: {
            code: 'outcome_unknown',
            message: 'Request outcome could not be confirmed. Do not resubmit automatically.',
          },
          saved: null,
          outcome: 'unknown',
        },
        503,
      );
      // Hono has already finalized the downstream response after next().
      // Explicitly replace it so an uncertain write cannot return 201.
      c.res = response;
      return response;
    };
    let admitted: Response;
    let requestMaxSeconds = 0;
    try {
      admitted = await controller('/gate/acquire', body);
      if (!admitted.ok) return unavailable();
      const reply: unknown = await admitted.json();
      if (
        !reply ||
        typeof reply !== 'object' ||
        !('status' in reply) ||
        reply.status !== 'admitted' ||
        !('requestId' in reply) ||
        reply.requestId !== body.requestId ||
        !('requestMaxSeconds' in reply) ||
        typeof reply.requestMaxSeconds !== 'number' ||
        !Number.isInteger(reply.requestMaxSeconds) ||
        reply.requestMaxSeconds > 25 ||
        reply.requestMaxSeconds < 1 ||
        !('expiresAt' in reply) ||
        typeof reply.expiresAt !== 'number' ||
        reply.expiresAt <= Date.now() / 1000
      )
        return unavailable();
      requestMaxSeconds = reply.requestMaxSeconds;
    } catch {
      // A lost acquire reply may conceal a durable lease. Do not send release.
      return unavailable();
    }
    const tracker: Tracker = {
      pending: 0,
      uncertain: false,
      deadlineAt: performance.now() + requestMaxSeconds * 1_000,
    };
    try {
      await storage.run(tracker, () => next());
    } catch {
      tracker.uncertain = true;
    }
    if (tracker.uncertain || tracker.pending !== 0) return uncertain();
    try {
      await controller('/gate/release', body);
    } catch {
      // A failed release is an unresolved lease for controller reconciliation.
    }
  };
  return { middleware, databaseFetch };
}
