import { z } from 'zod';

export const AssessmentControlSchema = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string(),
  cite: z.string(),
  score: z.number().min(0).max(100).nullable(),
  status: z.enum(['pass', 'partial', 'fail', 'unassessed']),
  evidenceIds: z.array(z.uuid()),
});
export const AssessmentSnapshotSchema = z.object({
  tenantId: z.uuid(),
  engagement: z
    .object({ id: z.uuid(), title: z.string(), libraryVersion: z.string(), status: z.string() })
    .nullable(),
  isSdf: z.boolean(),
  exposureInr: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  controls: z.array(AssessmentControlSchema),
  summary: z.object({
    pass: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    unassessed: z.number().int().nonnegative(),
  }),
});
export type AssessmentSnapshot = z.infer<typeof AssessmentSnapshotSchema>;
export type AssessmentControl = z.infer<typeof AssessmentControlSchema>;
