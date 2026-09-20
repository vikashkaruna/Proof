'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@axiom/supabase';

/**
 * Switching the active tenant (W1).
 *
 * Previously the switcher wrote `axiom_active_tenant` from client JavaScript,
 * non-httpOnly, with no check of any kind. `requireTenantContext()` already
 * treats that cookie as a *preference* and ignores a slug the caller is not a
 * member of, so this was never an escalation — but it left a
 * browser-writable cookie steering server rendering, and "it is ignored
 * downstream" is a property that has to keep being true at every call site
 * forever.
 *
 * Setting it here instead means the value is verified once, when it changes,
 * and the cookie is httpOnly so page scripts cannot touch it at all.
 */

export type SwitchTenantResult = { ok: true; slug: string } | { ok: false; reason: string };

export async function switchTenantAction(slug: string): Promise<SwitchTenantResult> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: 'unauthenticated' };

  // RLS confines this to the caller's own memberships, so a slug that comes
  // back is one they belong to. Naming a tenant is not the same as belonging
  // to it, and this is where that distinction is enforced.
  const { data: memberships, error } = await supabase
    .from('tenant_users')
    .select('tenant_id, tenants:tenant_id(slug)')
    .eq('user_id', user.id);

  if (error) return { ok: false, reason: 'lookup_failed' };

  const match = (memberships ?? []).find((row) => {
    const rel = row.tenants as unknown;
    const tenant = Array.isArray(rel) ? rel[0] : rel;
    return (tenant as { slug?: string } | null)?.slug === slug;
  });

  if (!match) return { ok: false, reason: 'not_a_member' };

  const store = await cookies();
  store.set('axiom_active_tenant', slug, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: true,
    sameSite: 'lax',
    // Set on every deployed origin. `secure` on a localhost http origin would
    // mean the cookie is silently dropped in local development, so it follows
    // whether the request itself arrived over TLS.
    secure: process.env.NEXT_PUBLIC_SITE_URL?.startsWith('https://') ?? true,
  });

  revalidatePath('/', 'layout');
  return { ok: true, slug };
}
