import { requireCapabilityContext, Capability } from '@/lib/tenant-context';
import { AssessmentSnapshotSchema, type AssessmentSnapshot } from '@axiom/types';
import { AssessmentClient } from './assessment-client';

export const dynamic = 'force-dynamic';

export default async function AssessmentPage({
  searchParams,
}: {
  searchParams: Promise<{ engagement?: string }>;
}) {
  const { supabase, tenantId } = await requireCapabilityContext(Capability.POSTURE_READ);
  const { engagement } = await searchParams;
  let snapshot: AssessmentSnapshot | null = null;
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.access_token) {
      const target = new URL(
        '/v1/assessment',
        process.env.BFF_PUBLIC_URL || 'http://localhost:4000',
      );
      if (engagement !== undefined) target.searchParams.set('engagementId', engagement);
      const response = await fetch(target, {
        headers: { Authorization: `Bearer ${session.access_token}`, 'X-Tenant-Id': tenantId },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        const parsed = AssessmentSnapshotSchema.safeParse(await response.json());
        if (
          parsed.success &&
          parsed.data.tenantId === tenantId &&
          (engagement === undefined || parsed.data.engagement?.id === engagement)
        )
          snapshot = parsed.data;
      }
    }
  } catch {
    // Missing/unreadable saved results are never replaced with demo posture.
  }
  return <AssessmentClient snapshot={snapshot} />;
}
