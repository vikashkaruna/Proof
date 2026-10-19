import { UserRole } from '@axiom/types';
import type { TenantContext } from './tenant-context';

/** A role label or employee flag alone never establishes founder review access. */
export async function hasLiveFounderReportAccess(
  context: Pick<TenantContext, 'userId' | 'role' | 'isAxiomInternal' | 'supabase'>,
): Promise<boolean> {
  if (context.role !== UserRole.FOUNDER || !context.isAxiomInternal) return false;
  try {
    const result = await context.supabase
      .rpc('is_live_platform_founder', { p_user_id: context.userId })
      .abortSignal(AbortSignal.timeout(5000));
    return !result.error && result.data === true;
  } catch {
    return false;
  }
}
