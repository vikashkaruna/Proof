import { Capability, can } from '@axiom/types';
import { requireTenantContext } from '@/lib/tenant-context';
import { EvidenceClient } from './evidence-client';

export const dynamic = 'force-dynamic';

export default async function EvidencePage() {
  const { tenantId, role } = await requireTenantContext();
  if (!can(Capability.EVIDENCE_READ, { role }))
    return <p role="alert">Your role cannot view evidence records.</p>;
  return (
    <EvidenceClient
      key={tenantId}
      tenantId={tenantId}
      canRecord={can(Capability.EVIDENCE_RECORD, { role })}
      canExport={can(Capability.EVIDENCE_EXPORT, { role })}
    />
  );
}
