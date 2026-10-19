import { requireCapabilityContext, Capability } from '@/lib/tenant-context';
import {
  loadAssessmentSnapshot,
  loadAssessmentConfigurationDetails,
} from '@/lib/assessment-snapshot';
import { AssessmentClient } from './assessment-client';
import { can } from '@axiom/types';
import Link from 'next/link';
import { assessmentReviewSelectionSchema } from './review-selection';
import { routeCapability } from '@/app/(app)/nav';

export const dynamic = 'force-dynamic';

export default async function AssessmentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { supabase, tenantId, role, userId } = await requireCapabilityContext(
    routeCapability('/assessment'),
  );
  const selection = assessmentReviewSelectionSchema.safeParse(await searchParams);
  if (!selection.success)
    return (
      <p role="alert">
        The assessment or recorded-review selection is incomplete or malformed. Return to{' '}
        <Link href="/discovery" className="underline">
          Discovery
        </Link>{' '}
        and use the exact recorded review link, or{' '}
        <Link href="/assessment" className="underline">
          open Assessment without a review selection
        </Link>
        . Nothing was submitted.
      </p>
    );
  const { engagement, reviewRef } = selection.data;
  // Missing/unreadable saved results are never replaced with demo posture.
  const [snapshot, configuration] = await Promise.all([
    loadAssessmentSnapshot(supabase, tenantId, engagement),
    loadAssessmentConfigurationDetails(supabase, tenantId),
  ]);
  if (reviewRef && snapshot?.engagement?.id !== engagement)
    return (
      <p role="alert">
        The assessment selected for this recorded review is unavailable. Return to{' '}
        <Link href="/discovery" className="underline">
          Discovery
        </Link>{' '}
        and refresh the saved human review. Nothing was submitted.
      </p>
    );
  return (
    <AssessmentClient
      reviewRef={reviewRef}
      configuration={configuration?.configuration ?? 'unknown'}
      sourceRequirement={configuration?.sourceRequirement ?? 'unknown'}
      snapshot={snapshot}
      actorId={userId}
      canCreate={can(Capability.ENGAGEMENT_CREATE, { role })}
      canInvokeAgent={
        can(Capability.AGENT_INVOKE, { role }) && can(Capability.ASSESSMENT_RUN, { role })
      }
    />
  );
}
