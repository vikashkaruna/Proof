import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@axiom/supabase';
import { capabilitiesFor, type UserRole } from '@axiom/types';
import { logoutAction } from '../(auth)/login/actions';
import { AppShell } from './app-shell';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const activeTenantSlug = cookieStore.get('axiom_active_tenant')?.value;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  // Tenant membership + role
  const { data: memberships } = await supabase
    .from('tenant_users')
    .select('tenant_id, role, tenants:tenant_id(slug, name)')
    .eq('user_id', user.id);

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

  return (
    <AppShell
      user={user}
      tenants={tenants}
      activeTenantSlug={activeTenantSlug}
      capabilities={capabilities}
      logoutAction={logoutAction}
    >
      {children}
    </AppShell>
  );
}
