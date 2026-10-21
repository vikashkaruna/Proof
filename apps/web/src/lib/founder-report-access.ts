import { readLiveFounderDesignation } from './organization-contexts';
import type { TenantContext } from './tenant-context';

/** A role label or employee flag alone never establishes founder review access. */
export async function hasLiveFounderReportAccess(
  context: Pick<TenantContext, 'userId' | 'role' | 'isAxiomInternal' | 'supabase'>,
): Promise<boolean> {
  try {
    return await readLiveFounderDesignation(context.supabase, context.userId);
  } catch {
    return false;
  }
}
