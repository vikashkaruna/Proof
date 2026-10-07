import { requireCapabilityContext, Capability } from '@/lib/tenant-context';
import { loadAssessmentSnapshot } from '@/lib/assessment-snapshot';
import { AssessmentClient } from './assessment-client';
import { can } from '@axiom/types';

export const dynamic = 'force-dynamic';

export default async function AssessmentPage({
  searchParams,
}: {
  searchParams: Promise<{ engagement?: string }>;
}) {
  const { supabase, tenantId, role, userId } = await requireCapabilityContext(
    Capability.POSTURE_READ,
  );
  const { engagement } = await searchParams;
  // Missing/unreadable saved results are never replaced with demo posture.
  const snapshot = await loadAssessmentSnapshot(supabase, tenantId, engagement);
  return (
    <AssessmentClient
      snapshot={snapshot}
      actorId={userId}
      canCreate={can(Capability.ENGAGEMENT_CREATE, { role })}
      canInvokeAgent={
        can(Capability.AGENT_INVOKE, { role }) && can(Capability.ASSESSMENT_RUN, { role })
      }
    />
  );
}
