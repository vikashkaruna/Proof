import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AssessmentConfigurationSchema,
  type AssessmentConfiguration,
  AssessmentSnapshotSchema,
  type AssessmentSnapshot,
} from '@axiom/types';

/**
 * The BFF's saved-results projection for the caller's verified tenant (C-W0-7).
 * Returns null when results are missing or unreadable; callers must render an
 * explicit empty/unavailable state and never substitute sample posture.
 */
export async function loadAssessmentSnapshot(
  supabase: SupabaseClient,
  tenantId: string,
  engagementId?: string,
): Promise<AssessmentSnapshot | null> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) return null;
    const target = new URL('/v1/assessment', process.env.BFF_PUBLIC_URL || 'http://localhost:4000');
    if (engagementId !== undefined) target.searchParams.set('engagementId', engagementId);
    const response = await fetch(target, {
      headers: { Authorization: `Bearer ${session.access_token}`, 'X-Tenant-Id': tenantId },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const parsed = AssessmentSnapshotSchema.safeParse(await response.json());
    if (
      !parsed.success ||
      parsed.data.tenantId !== tenantId ||
      (engagementId !== undefined && parsed.data.engagement?.id !== engagementId)
    )
      return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** Configuration presence is not controller health or execution acceptance. */
export async function loadAssessmentConfiguration(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<AssessmentConfiguration['configuration']> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) return 'unknown';
    const response = await fetch(
      new URL(
        '/v1/assessment/configuration',
        process.env.BFF_PUBLIC_URL || 'http://localhost:4000',
      ),
      {
        headers: { Authorization: `Bearer ${session.access_token}`, 'X-Tenant-Id': tenantId },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) return 'unknown';
    const result = AssessmentConfigurationSchema.safeParse(await response.json());
    return result.success && result.data.tenantId === tenantId
      ? result.data.configuration
      : 'unknown';
  } catch {
    return 'unknown';
  }
}
