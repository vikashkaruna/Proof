import { requireCapabilityContext } from '@/lib/tenant-context';
import { Capability } from '@axiom/types';
import { DataFlowClient } from './flow-client';
export const dynamic = 'force-dynamic';
export default async function DataFlowPage() {
  const c = await requireCapabilityContext(Capability.POSTURE_READ);
  return (
    <DataFlowClient key={`${c.tenantId}:${c.userId}`} tenantId={c.tenantId} actorId={c.userId} />
  );
}
