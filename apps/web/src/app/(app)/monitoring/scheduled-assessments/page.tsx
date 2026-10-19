import { redirect } from 'next/navigation';
import { Capability, requireCapabilityContext } from '@/lib/tenant-context';
import { CoverageClient } from './coverage-client';
export const dynamic = 'force-dynamic';
export default async function CoveragePage() {
  const c = await requireCapabilityContext(Capability.ASSESSMENT_RUN);
  if (c.role !== 'owner') redirect('/monitoring?error=forbidden');
  return (
    <CoverageClient key={`${c.tenantId}:${c.userId}`} tenantId={c.tenantId} actorId={c.userId} />
  );
}
