import { createHash } from 'node:crypto';
import { z } from 'zod';
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

  // Only the BFF can claim or complete requests. Client roles have no access.
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  const requestHash = createHash('sha256')
    .update(JSON.stringify([new URL(c.req.url).search, await c.req.raw.clone().text()]))
    .digest('hex');
  // Do not replay privileged material after a role change or into a different
  // login session, even when the user presents the same key and body.
  const authorityHash = createHash('sha256')
    .update(
      JSON.stringify({
        role: c.get('role') ?? null,
        scopes: [...(c.get('approvalScopes') ?? [])].sort(),
        session: c.get('sessionId') ?? null,
      }),
    )
    .digest('hex');
  const { data, error } = await supabase.rpc('claim_request', {
    p_user_id: user.id,
    p_tenant_id: tenantId ?? null,
    p_path: c.req.path,
    p_method: c.req.method,
    p_key: key,
    p_request_sha256: requestHash,
    p_authority_sha256: authorityHash,
  });
  const claim = z
    .discriminatedUnion('decision', [
      z.object({ decision: z.literal('claimed'), id: z.uuid() }),
      z.object({
        decision: z.literal('replay'),
        status: z.number().int().min(200).max(599),
        body: z.unknown(),
      }),
      z.object({ decision: z.enum(['conflict', 'in_progress', 'expired']) }),
    ])
    .safeParse(data);
  if (error || !claim.success) {
    return c.json(
      {
        error: { code: 'idempotency_unavailable', message: 'Could not claim this request safely.' },
      },
      503,
    );
  }
  if (claim.data.decision === 'replay') {
    return new Response(
      [204, 205, 304].includes(claim.data.status) ? null : JSON.stringify(claim.data.body),
      {
        status: claim.data.status,
        headers: { 'content-type': 'application/json', 'idempotency-replayed': 'true' },
      },
    );
  }
  if (claim.data.decision !== 'claimed') {
    return c.json(
      {
        error: {
          code: `idempotency_${claim.data.decision}`,
          message:
            'The key is already claimed. Do not retry with a different key until the original outcome is known.',
        },
      },
      409,
    );
  }
  c.set('idempotencyKey', key);
  // A crash/throw leaves an in-progress claim. Never automatically run a
  // potentially mutating handler again; reconcile its durable operation first.
  await next();
  const response = c.res.clone();
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  const { data: completed, error: completionError } = await supabase.rpc('complete_request', {
    p_id: claim.data.id,
    p_request_sha256: requestHash,
    p_status: response.status,
    p_body: body,
  });
  if (completionError || completed !== true) {
    c.res = c.json(
      {
        error: {
          code: 'idempotency_outcome_unknown',
          message:
            'The operation may have completed. Keep this key and reconcile its status before trying again.',
        },
      },
      503,
    );
  }
});
