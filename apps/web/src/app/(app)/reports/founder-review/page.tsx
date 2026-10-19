import { redirect } from 'next/navigation';
import { requireCapabilityContext } from '@/lib/tenant-context';
import { hasLiveFounderReportAccess } from '@/lib/founder-report-access';
import { routeCapability } from '../../nav';
import { FounderReportReviewClient } from './review-client';
export const dynamic = 'force-dynamic';
export default async function FounderReportReviewPage() {
  const context = await requireCapabilityContext(routeCapability('/reports/founder-review'));
  if (!(await hasLiveFounderReportAccess(context))) redirect('/reports?error=founder_required');
  return (
    <FounderReportReviewClient
      key={`${context.tenantId}:${context.userId}`}
      tenantId={context.tenantId}
      actorId={context.userId}
      tenantName={context.tenantName}
    />
  );
}
