import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';

export type AssessmentBasis = 'recorded_assessment' | 'scheduled_coverage' | 'unavailable';
const uuid = z.uuid();
const run = z
  .object({
    tenant_id: uuid,
    engagement_id: uuid,
    agent: z.literal('parikshan'),
    status: z.string(),
    output_redacted_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    completed_at: z.iso.datetime({ offset: true }).nullable(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();
/** Server-only classification from tenant-scoped, trusted persisted run metadata.
 * Missing/error/truncated/unknown provenance never authorizes displaying numbers.
 * This is presentation filtering; raw persisted calculations and RLS stay intact. */
export async function readAssessmentBases(
  db: Pick<SupabaseClient, 'from'>,
  tenantId: string,
  engagementIds: readonly string[],
): Promise<ReadonlyMap<string, AssessmentBasis>> {
  const result = new Map<string, AssessmentBasis>(engagementIds.map((id) => [id, 'unavailable']));
  const ids = [...new Set(engagementIds)];
  if (
    !ids.length ||
    ids.length > 100 ||
    !uuid.safeParse(tenantId).success ||
    ids.some((id) => !uuid.safeParse(id).success)
  )
    return result;
  try {
    const response = await db
      .from('agent_runs')
      .select('tenant_id,engagement_id,agent,status,output_redacted_hash,completed_at,metadata', {
        count: 'exact',
      })
      .eq('tenant_id', tenantId)
      .eq('agent', 'parikshan')
      .in('engagement_id', ids)
      .limit(1001)
      .abortSignal(AbortSignal.timeout(5000));
    if (response.error) return result;
    const rows = z.array(run).max(1000).parse(response.data);
    // PostgREST may silently cap below our requested limit. Only a same-query
    // exact total proves every matching run was received; a sentinel cannot.
    if (!Number.isSafeInteger(response.count) || response.count !== rows.length) return result;
    if (rows.some((row) => row.tenant_id !== tenantId || !result.has(row.engagement_id)))
      return result;
    const unknown = new Set<string>();
    for (const row of rows) {
      const kind = row.metadata.request_kind;
      if (kind === 'scheduled_coverage_reassessment_v1')
        result.set(row.engagement_id, 'scheduled_coverage');
      else if (
        kind !== undefined &&
        !['questionnaire_v1', 'public_control_review_set_v1'].includes(String(kind))
      )
        unknown.add(row.engagement_id);
      else if (
        row.status === 'succeeded' &&
        row.completed_at &&
        row.output_redacted_hash &&
        result.get(row.engagement_id) !== 'scheduled_coverage'
      )
        result.set(row.engagement_id, 'recorded_assessment');
    }
    for (const id of unknown)
      if (result.get(id) !== 'scheduled_coverage') result.set(id, 'unavailable');
    return result;
  } catch {
    return result;
  }
}
export function assessmentMetrics(
  basis: AssessmentBasis | undefined,
  posture: unknown,
  exposure: unknown,
) {
  return {
    score:
      basis === 'recorded_assessment' &&
      typeof posture === 'number' &&
      Number.isFinite(posture) &&
      posture >= 0 &&
      posture <= 100
        ? posture
        : null,
    exposureInr:
      basis === 'recorded_assessment' &&
      typeof exposure === 'number' &&
      Number.isSafeInteger(exposure) &&
      exposure >= 0
        ? exposure
        : null,
  };
}
