import { redirect } from 'next/navigation';
import { Capability, requireCapabilityContext } from '@/lib/tenant-context';
import { StandingApprovalClient } from './standing-client';
export const dynamic = 'force-dynamic';
export default async function StandingApprovalPage() {
  const c = await requireCapabilityContext(Capability.PLAN_APPROVE);
  if (!['owner', 'admin', 'approver', 'founder'].includes(c.role))
    redirect('/portal?error=forbidden');
  return (
    <StandingApprovalClient
      key={`${c.tenantId}:${c.userId}`}
      tenantId={c.tenantId}
      actorId={c.userId}
    />
  );
}
