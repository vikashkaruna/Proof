import { createMiddleware } from 'hono/factory';
import { createClient } from '@supabase/supabase-js';
import { sessionIdFromAccessToken } from '@axiom/supabase';
import { loadEnv, isAuthBypassEnabled } from '@axiom/config';
import { logger } from '../lib/logger.js';
import type { Variables } from '../types.js';

const env = loadEnv();

/**
 * The E2E identity. Reachable only under `AXIOM_AUTH_MODE=e2e-bypass`, which
 * `loadEnv()` refuses to parse outside `local`/`test` — so in staging, preprod,
 * production and onprem this constant is unreachable code.
 */
const E2E_IDENTITY = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'founder@axiomminds.ai',
  user_metadata: { full_name: 'Founder' },
  app_metadata: { provider: 'email' },
  aud: 'authenticated',
  role: 'authenticated',
  created_at: '2026-01-01T00:00:00.000Z',
} as const;

const SYNTHETIC_TOKENS = new Set(['dev-token', 'test-access-token']);

/**
 * Resolved once, at module load, from the single sanctioned switch. This is
 * deliberately NOT re-evaluated per request and deliberately does not consult
 * `ENVIRONMENT` or `NODE_ENV`.
 *
 * Before W0.0 this was a six-clause OR chain (SEC-1) that was true in staging,
 * in preprod, and in any container that simply forgot to set `NODE_ENV`. A
 * request with no `Authorization` header at all was then assigned `dev-token`
 * and resolved to the founder identity, and `tenantResolver` handed it `owner`
 * on any tenant it named.
 */
const authBypass = isAuthBypassEnabled();

/**
 * Auth middleware. Validates the Supabase JWT, extracts the user, and attaches
 * it to the request context.
 *
 * Fails closed in every direction (W0.0 rule 4): a missing credential, a
 * rejected credential, and an unreachable auth service are 401, 401 and 503
 * respectively. None of them yields an identity.
 */
export const authMiddleware = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const auth = c.req.header('authorization') ?? '';
  let token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  // E2E harnesses drive the app without a Supabase session. Contained to
  // local/test by the boot refusal in @axiom/config.
  if (!token && authBypass) token = 'dev-token';

  if (!token) {
    return c.json({ error: { code: 'unauthorized', message: 'Missing bearer token' } }, 401);
  }

  if (authBypass && SYNTHETIC_TOKENS.has(token)) {
    c.set('user', { ...E2E_IDENTITY } as never);
    c.set('token', token);
    // The synthetic identity has no Supabase session and no enrolled factor.
    // Under the one sanctioned bypass — which @axiom/config refuses to enable
    // outside local/test — MFA is bypassed with the rest of authentication.
    // This is not a second posture switch; it is the same one.
    c.set('sessionId', '');
    return next();
  }

  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    // SEC-1: this branch used to fall back to the founder identity whenever
    // `isDevOrTest` was true. It now rejects, unconditionally.
    if (error || !user) {
      logger.warn({ error: error?.message }, 'auth rejected');
      return c.json({ error: { code: 'unauthorized', message: 'Invalid or expired token' } }, 401);
    }

    c.set('user', user);
    c.set('token', token);
    // Read AFTER the token has been validated. `sessionIdFromAccessToken`
    // decodes without verifying, so it must never be the thing that decides a
    // token is trustworthy — only what pulls an identifier out of one we have
    // already accepted.
    c.set('sessionId', sessionIdFromAccessToken(token) ?? '');
    await next();
  } catch (networkErr: any) {
    // SEC-1: likewise — an outage used to grant founder access rather than
    // refuse service. A dependency being down is a 503, not an authorisation.
    logger.error({ error: networkErr?.message }, 'auth service unavailable');
    return c.json(
      { error: { code: 'auth_unavailable', message: 'Auth service unreachable' } },
      503,
    );
  }
});
