import { Capability, UserRole, can } from '@axiom/types';
import { requireTenantContext } from '@/lib/tenant-context';
import { DpbReviewsClient, type DpbBreach, type DpbNotification } from './reviews-client';

export const dynamic = 'force-dynamic';

export default async function DpbReviewsPage() {
  const { supabase, tenantId, role, isAxiomInternal } = await requireTenantContext();
  if (!can(Capability.REPORT_READ, { role }))
    return <p role="alert">Your role cannot view reports.</p>;
  const [breaches, notifications] = await Promise.all([
    supabase
      .from('breaches')
      .select('id,title,detected_at')
      .eq('tenant_id', tenantId)
      .order('detected_at', { ascending: false })
      .limit(100),
    supabase
      .from('breach_notifications')
      .select('id,breach_id,kind,status,subject,reviewed_at,delivery_outcome')
      .eq('tenant_id', tenantId)
      .eq('kind', 'dpb')
      .in('status', ['reviewed', 'sent'])
      .order('reviewed_at', { ascending: false })
      .limit(200),
  ]);
  if (breaches.error || notifications.error)
    return (
      <p role="alert">
        Recorded breach sources are unavailable. Refresh when the connection is restored.
      </p>
    );
  return (
    <DpbReviewsClient
      tenantId={tenantId}
      breaches={(breaches.data ?? []) as DpbBreach[]}
      notifications={(notifications.data ?? []) as DpbNotification[]}
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
