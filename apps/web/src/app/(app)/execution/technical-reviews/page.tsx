import { Capability, UserRole, can } from '@axiom/types';
import { requireTenantContext } from '@/lib/tenant-context';
import { TechnicalReviewsClient, type TechnicalPlan } from './reviews-client';

export const dynamic = 'force-dynamic';

export default async function TechnicalReviewsPage() {
  const { supabase, tenantId, role, isAxiomInternal } = await requireTenantContext();
  if (!can(Capability.REPORT_READ, { role }))
    return <p role="alert">Your role cannot view reports.</p>;
  const plans = await supabase
    .from('remediation_plans')
    .select('id,title,status,created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (plans.error)
    return <p role="alert">Recorded remediation plans are unavailable. Refresh to try again.</p>;
  return (
    <TechnicalReviewsClient
      tenantId={tenantId}
      plans={(plans.data ?? []) as TechnicalPlan[]}
      canRequest={
        can(Capability.REPORT_GENERATE, { role }) &&
        (role === UserRole.OWNER ||
          role === UserRole.ADMIN ||
          (role === UserRole.FOUNDER && isAxiomInternal))
      }
      founder={role === UserRole.FOUNDER && isAxiomInternal}
    />
  );
}
