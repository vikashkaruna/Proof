import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient, sessionIdFromAccessToken } from '@axiom/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Capability, authorize, type UserRole } from '@axiom/types';

/**
 * The single entry point for tenant-scoped data access in the web app (W1).
 *
 * SEC-3: 22 files in `apps/web` called `createSupabaseAdmin()`, whose own
 * docstring says "The Next.js apps NEVER use this — they go through the
 * user-scoped client and rely on RLS to enforce tenancy." The service-role key
 * bypasses RLS by design, and most of those files carried no `tenant_id`
 * filter at all, so any authenticated user of any tenant could see every
 * tenant's findings, evidence, DSARs, breaches, reports, plans and approvals.
 * NFR-2 ("tenant isolation — absolute") was false in the running product while
 * the database policies were entirely correct.
 *
 * Two distinct mistakes produced that, and this helper closes both:
 *
 *  1. **Using the service-role client.** The client returned here is
 *     user-scoped, so every query runs under RLS. A missing `.eq('tenant_id')`
 *     becomes an empty result rather than a cross-tenant leak — the database
 *     policy is the backstop it was designed to be.
 *
 *  2. **Trusting the active-tenant cookie.** Pages read
 *     `axiom_active_tenant` and queried whatever slug it named. A cookie is
 *     attacker-controlled. Membership is verified here, every time.
 */

export interface TenantContext {
  userId: string;
  email: string | undefined;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  role: UserRole;
  /** From `tenant_users.approval_scopes`. Empty means unrestricted. */
  approvalScopes: string[];
  isAxiomInternal: boolean;
  /**
   * Whether this tenant may be shown illustrative sample figures.
   *
   * Ten module pages carry hardcoded demo numbers ("12.4M rows", "47 tables")
   * that render whenever a query returns nothing. On a compliance product that
   * is the wrong default in the wrong direction: a real client with a sparse
   * estate sees invented numbers presented as their own posture, and has no
   * way to tell them apart from a genuine finding.
   *
   * Sample data is now opt-in per tenant and labelled as simulated wherever it
   * appears — the same treatment non-production connector bindings get.
   */
  isDemo: boolean;
  /**
   * User-scoped Supabase client. RLS applies to every query made with it.
   * This is deliberately the only client a page is given.
   */
  supabase: SupabaseClient;
}

interface TenantRel {
  slug: string;
  name: string;
  is_demo?: boolean | null;
}

interface MembershipRow {
  tenant_id: string;
  role: UserRole;
  approval_scopes: string[] | null;
  tenants: TenantRel | TenantRel[] | null;
}

/** Supabase types an embedded relation as either an object or an array. */
function readTenant(rel: MembershipRow['tenants']): TenantRel {
  if (Array.isArray(rel)) return rel[0] ?? { slug: '', name: 'Unknown' };
  return rel ?? { slug: '', name: 'Unknown' };
}

/**
 * Resolves the caller's session and active tenant, verifying membership.
 *
 * Redirects rather than throwing, because every caller is a server component
 * rendering a page: `/login` when there is no session, `/onboarding` when the
 * user belongs to no tenant yet.
 *
 * @param requestedSlug an explicit tenant slug (e.g. from a query param).
 *        Still subject to the membership check — naming a tenant is not the
 *        same as belonging to it.
 */
/**
 * Login-time MFA (W1 · SEC-8).
 *
 * Redirects rather than refuses, because this runs during a page render and
 * the user needs somewhere to go. The refusal that matters is the BFF's — a
 * caller who skips the browser entirely gets a 401 from `requireSessionMfa`,
 * and nothing here is load-bearing for that.
 *
 * Every read is through the user's own client under RLS: their memberships,
 * their factors, their attestations. No service-role key is involved, which is
 * the SEC-3 rule and also means a bug here cannot read someone else's state.
 */
async function enforceLoginMfa(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  userId: string,
  tenantId: string,
  role: string,
): Promise<void> {
  let required = ALWAYS_MFA_REQUIRED.has(role);

  if (!required) {
    const { data: tenant, error } = await supabase
      .from('tenants')
      .select('mfa_required_roles')
      .eq('id', tenantId)
      .maybeSingle();
    // Fail closed, matching the BFF: a policy we cannot read is not a policy
    // that exempts anyone. The cost of being wrong this way is a code prompt.
    required = error || !tenant ? true : (tenant.mfa_required_roles ?? []).includes(role);
  }

  if (!required) return;

  const { data: factors } = await supabase
    .from('user_mfa_factors')
    .select('id')
    .eq('factor_type', 'totp')
    .eq('status', 'active')
    .limit(1);

  if (!factors || factors.length === 0) redirect('/settings/security?enrol=required');

  // The attestation is bound to the GoTrue session id, which survives the
  // hourly access-token refresh. Keying it on the token itself would ask the
  // user for a code every hour and look like a bug.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const sessionId = session?.access_token ? sessionIdFromAccessToken(session.access_token) : null;
  if (!sessionId) redirect('/verify');

  const { data: attestations } = await supabase
    .from('mfa_session_attestations')
    .select('expires_at')
    .eq('user_id', userId)
    .eq('session_id', sessionId)
    .is('revoked_at', null);

  const live = (attestations ?? []).some(
    (row) => new Date(row.expires_at as string).getTime() > Date.now(),
  );
  if (!live) redirect('/verify');
}

export interface TenantContextOptions {
  /**
   * Skip the login-MFA gate. Only the pages a quarantined user must still be
   * able to reach pass this — enrolment and the code prompt — because a
   * quarantine with no exit is just an outage.
   *
   * It is opt-out rather than opt-in so that a new page is gated by default.
   * The reverse would mean every page added from here on is an unguarded one
   * until somebody remembers.
   */
  allowUnverifiedMfa?: boolean;
}

/**
 * Roles the platform requires a factor from regardless of tenant policy.
 * Mirrors `ALWAYS_MFA_REQUIRED` in the BFF — the BFF is the authoritative
 * gate, and this copy exists so the browser is redirected rather than shown a
 * page that will fail every call it makes.
 */
const ALWAYS_MFA_REQUIRED = new Set<string>(['founder']);

export async function requireTenantContext(
  requestedSlug?: string,
  options: TenantContextOptions = {},
): Promise<TenantContext> {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // RLS restricts this to the caller's own memberships, so the list is already
  // the set of tenants they may act in.
  const { data: memberships } = await supabase
    .from('tenant_users')
    .select('tenant_id, role, approval_scopes, tenants:tenant_id(slug, name, is_demo)')
    .eq('user_id', user.id);

  const rows = (memberships ?? []) as unknown as MembershipRow[];
  const [firstMembership] = rows;
  if (!firstMembership) redirect('/onboarding');

  const cookieStore = await cookies();
  const cookieSlug = cookieStore.get('axiom_active_tenant')?.value;
  const wanted = requestedSlug || cookieSlug;

  // The cookie is a *preference*, not an authorisation. If it names a tenant
  // the user is not a member of, it is ignored rather than honoured — the
  // previous code queried whatever slug the cookie carried.
  const selected =
    (wanted ? rows.find((r) => readTenant(r.tenants).slug === wanted) : undefined) ??
    firstMembership;

  const tenant = readTenant(selected.tenants);

  const { data: profile } = await supabase
    .from('users')
    .select('is_axiom_internal')
    .eq('id', user.id)
    .maybeSingle();

  if (!options.allowUnverifiedMfa) {
    await enforceLoginMfa(supabase, user.id, selected.tenant_id, selected.role);
  }

  return {
    userId: user.id,
    email: user.email,
    tenantId: selected.tenant_id,
    tenantSlug: tenant.slug,
    tenantName: tenant.name,
    role: selected.role,
    approvalScopes: selected.approval_scopes ?? [],
    isAxiomInternal: Boolean(profile?.is_axiom_internal),
    isDemo: Boolean(tenant.is_demo),
    supabase,
  };
}

/**
 * As above, but additionally requires a capability.
 *
 * Render gating is a usability concern — the BFF remains the authoritative
 * gate — but a page that renders data the caller may not see is itself the
 * leak. `apps/web` previously contained zero role checks of any kind: every
 * page rendered for every authenticated user (SEC-9).
 */
export async function requireCapabilityContext(
  capability: Capability,
  requestedSlug?: string,
): Promise<TenantContext> {
  const ctx = await requireTenantContext(requestedSlug);
  const decision = authorize(capability, {
    role: ctx.role,
    approvalScopes: ctx.approvalScopes,
  });
  if (!decision.allowed) redirect('/portal?error=forbidden');
  return ctx;
}

/**
 * Axiom-internal surfaces (the workbench, the cross-tenant ledger view).
 *
 * Distinct from a tenant role: an `owner` has full authority inside their own
 * tenant and none at all over Axiom's internal tooling.
 */
export async function requireInternalContext(requestedSlug?: string): Promise<TenantContext> {
  const ctx = await requireTenantContext(requestedSlug);
  if (!ctx.isAxiomInternal) redirect('/portal');
  return ctx;
}

export { Capability };
