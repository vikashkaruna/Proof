import { coveragePresentation } from './scheduled-coverage';
import { z } from 'zod';

const answerCount = z.number().int().min(0).max(5000);
const applicabilityDeclaration = z
  .object({
    value: z.boolean().nullable(),
    provenance: z.enum(['unknown', 'caller_declared_unverified']),
  })
  .strict()
  .refine(
    (row) => (row.value === null) === (row.provenance === 'unknown'),
    'Applicability declaration provenance is inconsistent',
  );
const assessmentProvenance = z
  .object({
    status: z.enum(['unavailable', 'caller_declared_unverified']),
    runId: z.uuid().nullable(),
    libraryDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    estimates: z.enum(['provisional', 'provenance_unavailable']),
    applicability: z
      .object({
        sdfSelfAttested: applicabilityDeclaration,
        processesChildren: applicabilityDeclaration,
        processesHealth: applicabilityDeclaration,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((row, ctx) => {
    const available = row.status === 'caller_declared_unverified';
    if (
      (row.runId === null) !== (row.libraryDigest === null) ||
      (available &&
        (row.runId === null || row.estimates !== 'provisional' || !row.applicability)) ||
      (!available &&
        (row.estimates !== 'provenance_unavailable' || row.applicability !== undefined))
    )
      ctx.addIssue({ code: 'custom', message: 'Assessment provenance is inconsistent' });
  });

export const AssessmentControlSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    domain: z.string(),
    cite: z.string(),
    score: z.number().min(0).max(100).nullable(),
    status: z.enum(['pass', 'partial', 'fail', 'unassessed', 'unknown', 'not_applicable']),
    scoreBand: z.enum(['pass', 'partial', 'fail']).nullable().optional(),
    answerState: z
      .enum([
        'unavailable',
        'unknown',
        'partially_answered',
        'caller_declared_unverified',
        'not_boolean_assessable',
      ])
      .optional(),
    applicabilityState: z
      .enum([
        'unavailable',
        'unconditional',
        'unknown',
        'caller_declared_applicable_unverified',
        'caller_declared_not_applicable_unverified',
      ])
      .optional(),
    answerCounts: z
      .object({
        knownBooleanQuestions: answerCount,
        callerAffirmed: answerCount,
        callerDenied: answerCount,
        unknown: answerCount,
      })
      .optional(),
    evidenceIds: z.array(z.uuid()),
  })
  .superRefine((row, ctx) => {
    const counts = row.answerCounts;
    let inconsistent = false;
    if (counts) {
      const declared = counts.callerAffirmed + counts.callerDenied;
      inconsistent =
        declared + counts.unknown !== counts.knownBooleanQuestions ||
        (row.answerState === 'unknown' && (counts.knownBooleanQuestions === 0 || declared !== 0)) ||
        (row.answerState === 'partially_answered' && (declared === 0 || counts.unknown === 0)) ||
        (row.answerState === 'caller_declared_unverified' &&
          (counts.knownBooleanQuestions === 0 || counts.unknown !== 0)) ||
        (row.answerState === 'not_boolean_assessable' && counts.knownBooleanQuestions !== 0) ||
        row.answerState === undefined ||
        row.answerState === 'unavailable';
    } else if (row.answerState !== undefined && row.answerState !== 'unavailable')
      inconsistent = true;
    if (row.applicabilityState !== undefined && row.status !== 'unassessed') {
      if (
        (row.status === 'not_applicable') !==
        (row.applicabilityState === 'caller_declared_not_applicable_unverified')
      )
        inconsistent = true;
      if (row.applicabilityState === 'unknown' && row.status !== 'unknown') inconsistent = true;
      if (
        row.applicabilityState !== 'caller_declared_not_applicable_unverified' &&
        ['unknown', 'partially_answered', 'not_boolean_assessable'].includes(
          row.answerState ?? '',
        ) &&
        row.status !== 'unknown'
      )
        inconsistent = true;
    }
    if (inconsistent)
      ctx.addIssue({ code: 'custom', message: 'Assessment control provenance is inconsistent' });
  });
export const AssessmentSnapshotSchema = z.object({
  scheduledCoverage: coveragePresentation.optional(),
  tenantId: z.uuid(),
  engagement: z
    .object({ id: z.uuid(), title: z.string(), libraryVersion: z.string(), status: z.string() })
    .nullable(),
  isSdf: z.boolean(),
  exposureInr: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  provenance: assessmentProvenance.optional(),
  controls: z.array(AssessmentControlSchema),
  summary: z.object({
    pass: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    unassessed: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative().optional(),
    not_applicable: z.number().int().nonnegative().optional(),
  }),
});
export type AssessmentSnapshot = z.infer<typeof AssessmentSnapshotSchema>;
export type AssessmentControl = z.infer<typeof AssessmentControlSchema>;
