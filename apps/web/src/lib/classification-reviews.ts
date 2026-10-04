import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

export const CLASSIFICATION_REVIEW_PAGE_SIZE = 50;
const sensitivity = z.enum(['public', 'internal', 'confidential', 'restricted', 'critical_pii']);
const reviewSchema = z
  .object({
    id: z.uuid(),
    tenant_id: z.uuid(),
    system_id: z.string().trim().min(1).max(200),
    resource_path: z.string().trim().min(1).max(1000),
    sensitivity_level: sensitivity,
    detected_categories: z.array(z.string().trim().min(1)).min(1).max(50),
    confidence_score: z.number().min(0).max(100),
    reviewed_by: z.uuid(),
    decision: z.enum(['confirmed', 'adjusted', 'overridden', 'dismissed']),
    adjusted_sensitivity: sensitivity.nullable(),
    justification: z.string().trim().min(1).max(2000),
    created_at: z.iso.datetime({ offset: true }),
  })
  .refine((row) =>
    ['adjusted', 'overridden'].includes(row.decision)
      ? row.adjusted_sensitivity !== null
      : row.adjusted_sensitivity === null,
  );
export type ClassificationReview = z.infer<typeof reviewSchema>;
export type ClassificationReviewHistory =
  | { state: 'unavailable' }
  | { state: 'invalid_page' }
  | { state: 'ready'; reviews: ClassificationReview[]; page: number; hasNext: boolean };

/** Human-recorded reviews only: the schema records no authoritative agent source. */
export async function loadClassificationReviewHistory(
  supabase: SupabaseClient,
  tenantId: string,
  requestedPage?: string | string[],
): Promise<ClassificationReviewHistory> {
  const parsedPage = z
    .string()
    .regex(/^[1-9]\d{0,3}$/)
    .transform(Number)
    .pipe(z.number().int().max(1000))
    .safeParse(requestedPage ?? '1');
  if (!parsedPage.success) return { state: 'invalid_page' };
  const page = parsedPage.data;
  const offset = (page - 1) * CLASSIFICATION_REVIEW_PAGE_SIZE;
  try {
    const { data, error } = await supabase
      .from('classification_reviews')
      .select(
        'id,tenant_id,system_id,resource_path,sensitivity_level,detected_categories,confidence_score,reviewed_by,decision,adjusted_sensitivity,justification,created_at',
      )
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + CLASSIFICATION_REVIEW_PAGE_SIZE)
      .abortSignal(AbortSignal.timeout(15_000));
    const parsed = z
      .array(reviewSchema)
      .max(CLASSIFICATION_REVIEW_PAGE_SIZE + 1)
      .safeParse(data);
    if (error || !parsed.success || parsed.data.some((row) => row.tenant_id !== tenantId))
      return { state: 'unavailable' };
    return {
      state: 'ready',
      reviews: parsed.data.slice(0, CLASSIFICATION_REVIEW_PAGE_SIZE),
      page,
      hasNext: parsed.data.length > CLASSIFICATION_REVIEW_PAGE_SIZE,
    };
  } catch {
    return { state: 'unavailable' };
  }
}
