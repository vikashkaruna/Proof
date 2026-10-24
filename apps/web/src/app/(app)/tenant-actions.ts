'use server';

import { readOrganizationContexts } from '@/lib/organization-contexts';
import { cookies, headers } from 'next/headers';
import { isIP } from 'node:net';
import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@axiom/supabase';

/** Only explicitly local deployments may use an HTTP tenant preference.
 * Server Actions validate Origin against Host; no forwarded protocol is trusted. */
function isLocalHttpOrigin(origin: string | null): boolean {
  if (!['local', 'development', 'test'].includes(process.env.ENVIRONMENT ?? '')) return false;
  try {
    const url = new URL(origin ?? '');
    if (url.protocol !== 'http:') return false;
    if (url.hostname === 'localhost' || url.hostname === '[::1]') return true;
    if (isIP(url.hostname) !== 4) return false;
    const [first, second] = url.hostname.split('.').map(Number);
    return (
      first === 127 ||
      first === 10 ||
      (first === 192 && second === 168) ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31)
    );
  } catch {
    return false;
  }
}

/**
 * Switching the active tenant (W1).
 *
 * Previously the switcher wrote `axiom_active_tenant` from client JavaScript,
 * non-httpOnly, with no check of any kind. `requireTenantContext()` already
 * treats that cookie as a preference and verifies the caller's organization
 * scope, so this was never an escalation — but it left a
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

  let memberships;
  try {
    memberships = (await readOrganizationContexts(supabase, user.id)).rows;
  } catch {
    return { ok: false, reason: 'lookup_failed' };
  }
  const match = (memberships ?? []).find((row) => {
    const rel = row.tenants as unknown;
    const tenant = Array.isArray(rel) ? rel[0] : rel;
    return (tenant as { slug?: string } | null)?.slug === slug;
  });

  if (!match) return { ok: false, reason: 'not_a_member' };

  const origin = (await headers()).get('origin');
  const store = await cookies();
  store.set('axiom_active_tenant', slug, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: true,
    sameSite: 'lax',
    // HTTP LAN browsers drop Secure cookies (unlike the localhost exception).
    // Deployment URL configuration must not misclassify this request.
    secure: !isLocalHttpOrigin(origin),
  });

  revalidatePath('/', 'layout');
  return { ok: true, slug };
}
