import { Capability, UserRole, can } from '@axiom/types';
import { requireTenantContext } from '@/lib/tenant-context';
import { ReportsClient } from './reports-client';
import { canAccessClosureDossiers } from '@/lib/closure-dossier-access';

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  const { tenantId, role, isAxiomInternal } = await requireTenantContext();
  if (!can(Capability.REPORT_READ, { role }))
    return <p role="alert">Your role cannot view reports.</p>;
  const canViewClosureDossiers = canAccessClosureDossiers(role, isAxiomInternal);
  return (
    <ReportsClient
      key={tenantId}
      tenantId={tenantId}
      canPrepare={can(Capability.EVIDENCE_RECORD, { role })}
      canReview={isAxiomInternal && can(Capability.REPORT_REVIEW, { role })}
      canRelease={isAxiomInternal && can(Capability.REPORT_RELEASE, { role })}
      canExport={can(Capability.EVIDENCE_EXPORT, { role })}
      canRequestBoard={canViewClosureDossiers && can(Capability.REPORT_GENERATE, { role })}
      canManageBoard={isAxiomInternal && role === UserRole.FOUNDER}
    />
  );
}
