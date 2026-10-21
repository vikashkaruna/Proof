import { UserRole } from '@axiom/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

export interface OrganizationContextRow {
  tenant_id: string;
  role: UserRole;
  approval_scopes: string[] | null;
  tenants:
    | { slug: string; name?: string; is_demo?: boolean | null }
    | { slug: string; name?: string; is_demo?: boolean | null }[]
    | null;
}
/** The database designation includes the trusted internal flag and revocation.
 * A tenant role, email, cookie or client-provided founder claim is never enough. */
export async function readLiveFounderDesignation(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  try {
    const result = await supabase
      .rpc('is_live_platform_founder', { p_user_id: userId })
      .abortSignal(AbortSignal.timeout(5000));
    if (result.error || typeof result.data !== 'boolean') throw Error();
    return result.data;
  } catch {
    throw Error('Founder designation is unavailable');
  }
}
const organization = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  is_demo: z.boolean().nullable().optional(),
});
/** User-scoped RLS reads throughout. SQL181 grants a live platform founder all
 * organization rows; ordinary accounts keep their recorded memberships. */
export async function readOrganizationContexts(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ globalFounder: boolean; rows: OrganizationContextRow[] }> {
  const globalFounder = await readLiveFounderDesignation(supabase, userId);
  const read = () =>
    globalFounder
      ? supabase.from('tenants').select('id,slug,name,is_demo')
      : supabase
          .from('tenant_users')
          .select('tenant_id,role,approval_scopes,tenants:tenant_id(slug,name,is_demo)')
          .eq('user_id', userId);
  let result = await read();
  if (result.error?.code === 'PGRST303' && result.error.message === 'JWT issued at future') {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    result = await read();
  }
  if (result.error || !Array.isArray(result.data))
    throw Error('Tenant memberships are unavailable');
  if (!globalFounder)
    return { globalFounder, rows: result.data as unknown as OrganizationContextRow[] };
  const rows = z
    .array(organization)
    .parse(result.data)
    .map((tenant) => ({
      tenant_id: tenant.id,
      role: UserRole.FOUNDER,
      approval_scopes: [],
      tenants: { slug: tenant.slug, name: tenant.name, is_demo: tenant.is_demo },
    }));
  return { globalFounder, rows };
}
