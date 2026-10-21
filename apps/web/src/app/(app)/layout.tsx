import { readOrganizationContexts } from '@/lib/organization-contexts';
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

  const { rows: memberships, globalFounder } = await readOrganizationContexts(supabase, user.id);
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

  // A live platform founder has effective founder authority in every company.
  // Ordinary users get only the selected membership's role, never a union.
  const active =
    tenants.find((t) => t.slug === activeTenantSlug || t.id === activeTenantSlug) ?? tenants[0];
  const capabilities = active ? capabilitiesFor(active.role as UserRole) : [];
  const canViewClosureDossiers = active
    ? canAccessClosureDossiers(active.role as UserRole, globalFounder)
    : false;
  const canReviewFounderReports = globalFounder;

  return (
    <AppShell
      user={user}
      tenants={tenants}
      activeTenantSlug={activeTenantSlug}
      capabilities={capabilities}
      canViewClosureDossiers={canViewClosureDossiers}
      canReviewFounderReports={Boolean(canReviewFounderReports)}
      logoutAction={logoutAction}
      isGlobalFounder={globalFounder}
    >
      {children}
    </AppShell>
  );
}
