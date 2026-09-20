import { createMiddleware } from 'hono/factory';
import { createClient } from '@supabase/supabase-js';
import { loadEnv, isAuthBypassEnabled } from '@axiom/config';
import { logger } from '../lib/logger.js';
import type { Variables } from '../types.js';
import type { UserRole } from '@axiom/types';

const env = loadEnv();

/**
 * Resolved once at boot from the single sanctioned switch. See auth.ts for why
 * this is not an environment comparison.
 */
const authBypass = isAuthBypassEnabled();

const SYNTHETIC_TOKENS = new Set(['dev-token', 'test-access-token']);

/**
 * Routes that legitimately run before the caller has any tenant.
 *
 * They are exempt from *resolution*, not from authorisation: they receive no
 * `tenantId` and no `role`, so nothing downstream can mistake the exemption
 * for a grant. Before W0.0 this path set `role: 'owner'`, which combined with
 * SEC-1 let an unauthenticated caller create tenants and self-assign
 * ownership (SEC-5).
 */
const TENANTLESS_ROUTES = ['/organizations/onboard', '/user/tenants'];

/**
 * The fixture tenants the local/test seed creates. Under `e2e-bypass` the
 * membership round-trip is skipped for these and only these — see below.
 */
const SEEDED_E2E_TENANTS = new Set([
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003',
]);

/**
 * Tenant resolver. Reads X-Tenant-Id, verifies the caller is a member of that
 * tenant, and attaches the membership role to the request context.
 *
 * The membership lookup runs with the user's own JWT, so RLS does the work and
 * a forged header cannot outrun the database policy. NFR-2 ("tenant isolation
 * — absolute") depends on this being unconditional.
 */
export const tenantResolver = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const path = c.req.path;
  if (TENANTLESS_ROUTES.some((route) => path.endsWith(route))) {
    return next();
  }

  // SEC-1: this used to fall back to a hardcoded tenant whenever `isDevOrTest`
  // was true, so a caller who named no tenant was silently given one.
  const tenantId = c.req.header('x-tenant-id');
  if (!tenantId) {
    return c.json(
      { error: { code: 'tenant_required', message: 'X-Tenant-Id header is required' } },
      400,
    );
  }

  const user = c.get('user');
  const token = c.get('token');

  // Under bypass the E2E identity resolves without a round-trip — but only
  // against the seeded fixture tenants. "Any tenant you name" is the exact
  // shape of SEC-1 step 5 and is gone in every mode, so a local E2E run and a
  // preprod run agree on cross-tenant refusal. W0.1 removes this branch
  // outright once local and preprod both run a real seeded database.
  if (authBypass && SYNTHETIC_TOKENS.has(token)) {
    if (!SEEDED_E2E_TENANTS.has(tenantId)) {
      logger.warn({ tenantId }, 'e2e bypass refused: tenant is not a seeded fixture');
      return c.json(
        { error: { code: 'tenant_forbidden', message: 'Not a member of this tenant' } },
        403,
      );
    }
    c.set('tenantId', tenantId);
    c.set('role', 'owner' as UserRole);
    c.set('approvalScopes', []);
    return next();
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: membership, error } = await supabase
    .from('tenant_users')
    .select('role, approval_scopes')
    .eq('tenant_id', tenantId)
    .eq('user_id', user.id)
    .single();

  if (error || !membership) {
    logger.warn({ userId: user.id, tenantId, error: error?.message }, 'tenant access denied');
    return c.json(
      { error: { code: 'tenant_forbidden', message: 'Not a member of this tenant' } },
      403,
    );
  }

  c.set('tenantId', tenantId);
  c.set('role', membership.role as UserRole);
  c.set('approvalScopes', (membership.approval_scopes as string[] | null) ?? []);
  await next();
});
