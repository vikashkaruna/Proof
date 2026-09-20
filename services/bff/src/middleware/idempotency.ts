import { createMiddleware } from 'hono/factory';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from '@axiom/config';
import type { Variables } from '../types.js';

const env = loadEnv();
const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Idempotency middleware. For all mutating endpoints (POST, PUT, PATCH,
 * DELETE), require an Idempotency-Key header. We store the key + the
 * response in a table so a retry returns the cached response rather
 * than re-executing.
 *
 * The key is scoped to (user, tenant, path) — a user can't accidentally
 * collide with another user's key.
 */
export const idempotency = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  if (
    !['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method) ||
    c.req.path.endsWith('/ledger/verify')
  ) {
    return next();
  }

  // SEC-13 row 3: a missing key used to be auto-generated in development,
  // local, preprod, staging and any container without NODE_ENV. Every
  // generated key is unique by construction, so the retry-safety FR-8.3
  // specifies was disabled in exactly the environments meant to test it.
  //
  // There is no environment in which this is relaxed — including e2e-bypass,
  // which relaxes authentication only. A test harness supplies a key like any
  // other client.
  const key = c.req.header(IDEMPOTENCY_HEADER);

  if (!key) {
    return c.json(
      {
        error: {
          code: 'idempotency_required',
          message: 'Mutating endpoints require an Idempotency-Key header',
        },
      },
      400,
    );
  }
  if (key.length < 8 || key.length > 256) {
    return c.json(
      {
        error: {
          code: 'idempotency_invalid',
          message: 'Idempotency-Key must be 8–256 characters',
        },
      },
      400,
    );
  }

  const user = c.get('user');
  const tenantId = c.get('tenantId');

  // Use service role to check the cache
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  const { data: existing } = await supabase
    .from('idempotency_keys')
    .select('response_status, response_body')
    .eq('user_id', user.id)
    .eq('tenant_id', tenantId)
    .eq('path', c.req.path)
    .eq('method', c.req.method)
    .eq('key', key)
    .maybeSingle();

  if (existing) {
    return c.json(
      existing.response_body,
      existing.response_status as 200 | 201 | 202 | 400 | 404 | 500,
    );
  }

  c.set('idempotencyKey', key);
  await next();

  // Cache the response. We do this after the route handler runs, so
  // successful (or expected-error) responses are stored. The route
  // handler is responsible for NOT short-circuiting the response.
  const response = c.res.clone();
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = { raw: body };
  }

  await supabase.from('idempotency_keys').insert({
    user_id: user.id,
    tenant_id: tenantId,
    path: c.req.path,
    method: c.req.method,
    key,
    response_status: response.status,
    response_body: parsed,
  });
});
