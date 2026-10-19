import { requireCapabilityContext } from '@/lib/tenant-context';
import { routeCapability } from '../../nav';
import { DataFlowClient } from './flow-client';
export const dynamic = 'force-dynamic';
export default async function DataFlowPage() {
  const c = await requireCapabilityContext(routeCapability('/datamap/flows'));
  return (
    <DataFlowClient key={`${c.tenantId}:${c.userId}`} tenantId={c.tenantId} actorId={c.userId} />
  );
}
