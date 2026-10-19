import { hasLiveFounderReportAccess } from '@/lib/founder-report-access';
import Link from 'next/link';
import { Capability, UserRole, can } from '@axiom/types';
import { requireTenantContext } from '@/lib/tenant-context';
import { ReportsClient } from './reports-client';
import { canAccessClosureDossiers } from '@/lib/closure-dossier-access';

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  const context = await requireTenantContext();
  const { tenantId, userId, role, isAxiomInternal } = context;
  const canUseFounderWorkspace = await hasLiveFounderReportAccess(context);
  if (!can(Capability.REPORT_READ, { role }))
    return <p role="alert">Your role cannot view reports.</p>;
  const canViewClosureDossiers = canAccessClosureDossiers(role, isAxiomInternal);
  return (
    <>
      {canUseFounderWorkspace && (
        <Link href="/reports/founder-review">
          Founder report review — saved board and auditor requests
        </Link>
      )}
      {isAxiomInternal && role === UserRole.FOUNDER && (
        <Link href="/reports/accounted-drafts">Accounted unpublished assessment drafts</Link>
      )}
      <ReportsClient
        key={tenantId}
        tenantId={tenantId}
        actorId={userId}
        canPrepare={can(Capability.EVIDENCE_RECORD, { role })}
        canReview={isAxiomInternal && can(Capability.REPORT_REVIEW, { role })}
        canRelease={isAxiomInternal && can(Capability.REPORT_RELEASE, { role })}
        canExport={can(Capability.EVIDENCE_EXPORT, { role })}
        canRequestBoard={canViewClosureDossiers && can(Capability.REPORT_GENERATE, { role })}
        canManageBoard={isAxiomInternal && role === UserRole.FOUNDER}
        canReadSealed
      />
    </>
  );
}
