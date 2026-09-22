/** Memberships must come from the authenticated user's RLS-scoped query. */
export interface TenantMembership {
  tenant_id: string;
  tenants: { slug: string } | { slug: string }[] | null;
}

/** Stable default shared by SSR and the bridge; no synthetic/demo tenant. */
export function selectTenantMembership<T extends TenantMembership>(
  rows: readonly T[],
  wanted?: string,
): T | undefined {
  const ordered = [...rows].sort((a, b) => a.tenant_id.localeCompare(b.tenant_id));
  if (wanted === undefined) return ordered[0];
  return ordered.find((row) => {
    const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
    return row.tenant_id === wanted || tenant?.slug === wanted;
  });
}
