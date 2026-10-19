import { hasLiveFounderReportAccess } from '@/lib/founder-report-access';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@axiom/supabase';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { capabilitiesFor, UserRole } from '@axiom/types';
import { canAccessClosureDossiers } from '@/lib/closure-dossier-access';
import { logoutAction } from '../(auth)/login/actions';
import { AppShell } from './app-shell';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const activeTenantSlug = cookieStore.get('axiom_active_tenant')?.value;

  const supabase = await createSupabaseServerClient();
  let authResult;
  try {
    authResult = await supabase.auth.getUser();
  } catch {
    throw new Error('Authentication service is temporarily unavailable');
  }
  if (isAuthRetryableFetchError(authResult.error)) {
    throw new Error('Authentication service is temporarily unavailable');
  }
  const { user } = authResult.data;

  if (!user) redirect('/login');

  // Tenant membership + role
  const readMemberships = () =>
    supabase
      .from('tenant_users')
      .select('tenant_id, role, tenants:tenant_id(slug, name)')
      .eq('user_id', user.id);
  let { data: memberships, error: membershipsError } = await readMemberships();
  if (
    membershipsError?.code === 'PGRST303' &&
    membershipsError.message === 'JWT issued at future'
  ) {
    // GoTrue and PostgREST can straddle a one-second clock boundary immediately
    // after sign-in. Retry only that specific token-timing refusal, then fail closed.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    ({ data: memberships, error: membershipsError } = await readMemberships());
  }
  if (membershipsError || !memberships) {
    throw new Error('Tenant memberships are unavailable');
  }

  const tenants = [...(memberships ?? [])]
    .sort((a, b) => a.tenant_id.localeCompare(b.tenant_id))
    .map((m) => {
      // Handle Supabase single or array relationship type
      const tenantRel = m.tenants as unknown;
      let name = 'Unknown';
      let slug = '';
      if (Array.isArray(tenantRel) && tenantRel[0]) {
        name = tenantRel[0].name ?? 'Unknown';
        slug = tenantRel[0].slug ?? '';
      } else if (tenantRel && typeof tenantRel === 'object' && 'name' in tenantRel) {
        const rel = tenantRel as { name?: string; slug?: string };
        name = rel.name ?? 'Unknown';
        slug = rel.slug ?? '';
      }

      return {
        id: m.tenant_id,
        role: m.role,
        name,
        slug,
      };
    });

  // The persona for the tenant currently being acted in — not a union across
  // memberships. Someone who owns tenant A and merely views tenant B must see
  // B's navigation while they are in B.
  const active =
    tenants.find((t) => t.slug === activeTenantSlug || t.id === activeTenantSlug) ?? tenants[0];
  const capabilities = active ? capabilitiesFor(active.role as UserRole) : [];
  let founderIsInternal = false;
  if (active?.role === UserRole.FOUNDER) {
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('is_axiom_internal')
      .eq('id', user.id)
      .maybeSingle();
    founderIsInternal = !profileError && profile?.is_axiom_internal === true;
  }
  const canViewClosureDossiers = active
    ? canAccessClosureDossiers(active.role as UserRole, founderIsInternal)
    : false;

  const canReviewFounderReports =
    active?.role === UserRole.FOUNDER &&
    (await hasLiveFounderReportAccess({
      userId: user.id,
      role: UserRole.FOUNDER,
      isAxiomInternal: founderIsInternal,
      supabase,
    }));

  return (
    <AppShell
      user={user}
      tenants={tenants}
      activeTenantSlug={activeTenantSlug}
      capabilities={capabilities}
      canViewClosureDossiers={canViewClosureDossiers}
      canReviewFounderReports={Boolean(canReviewFounderReports)}
      logoutAction={logoutAction}
    >
      {children}
    </AppShell>
  );
}
