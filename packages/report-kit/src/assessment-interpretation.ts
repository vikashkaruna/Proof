/** Source-bound interpretation for generated review documents. Numerical scores
 * never establish verified compliance, applicability, or corrective work. */
import { z } from 'zod';
import { validateQuestionnaireProvenance } from '@axiom/types';

const count = z.number().int().min(0).max(500);
export const AssessmentReportInterpretationSchema = z
  .object({
    version: z.literal(1),
    provenance: z.enum(['caller_declared_unverified', 'unavailable']),
    estimates: z.enum(['provisional', 'provenance_unavailable']),
    review_required: z.literal(true),
  })
  .strict()
  .refine(
    (value) =>
      value.estimates ===
      (value.provenance === 'unavailable' ? 'provenance_unavailable' : 'provisional'),
  );
export const AssessmentReportFindingInterpretationSchema = z
  .object({
    display_state: z.enum([
      'unknown',
      'declared_not_applicable_unverified',
      'not_boolean_assessable',
      'provisional_score_band',
      'provenance_unavailable',
    ]),
    answer_state: z
      .enum([
        'unknown',
        'partially_answered',
        'caller_declared_unverified',
        'not_boolean_assessable',
      ])
      .nullable(),
    applicability_state: z
      .enum([
        'unconditional',
        'unknown',
        'caller_declared_applicable_unverified',
        'caller_declared_not_applicable_unverified',
      ])
      .nullable(),
    answer_counts: z
      .object({
        known: z.number().int().min(0).max(1000),
        affirmed: z.number().int().min(0).max(1000),
        denied: z.number().int().min(0).max(1000),
        unknown: z.number().int().min(0).max(1000),
      })
      .strict()
      .nullable(),
    score_band: z.enum(['at_least_80', 'from_40_to_under_80', 'under_40']).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const counts = value.answer_counts;
    const unavailable = value.display_state === 'provenance_unavailable';
    const answerState = counts
      ? counts.known === 0
        ? 'not_boolean_assessable'
        : counts.unknown === counts.known
          ? 'unknown'
          : counts.unknown > 0
            ? 'partially_answered'
            : 'caller_declared_unverified'
      : null;
    const displayState = unavailable
      ? 'provenance_unavailable'
      : value.applicability_state === 'caller_declared_not_applicable_unverified'
        ? 'declared_not_applicable_unverified'
        : value.applicability_state === 'unknown' ||
            answerState === 'unknown' ||
            answerState === 'partially_answered'
          ? 'unknown'
          : answerState === 'not_boolean_assessable'
            ? 'not_boolean_assessable'
            : 'provisional_score_band';
    if (
      (unavailable
        ? value.answer_state !== null || value.applicability_state !== null || counts !== null
        : value.answer_state === null || value.applicability_state === null || counts === null) ||
      value.answer_state !== answerState ||
      value.display_state !== displayState ||
      (value.display_state === 'provisional_score_band') !== (value.score_band !== null) ||
      (counts && counts.known !== counts.affirmed + counts.denied + counts.unknown)
    )
      ctx.addIssue({ code: 'custom', message: 'Assessment interpretation is inconsistent' });
  });
export const AssessmentReportSummarySchema = z
  .object({
    posture_score: z.number().finite().min(0).max(100),
    total_controls: count,
    provisional_score_bands: z
      .object({ at_least_80: count, from_40_to_under_80: count, under_40: count })
      .strict(),
    unknown_controls: count,
    not_applicable_controls: count,
    not_boolean_assessable_controls: count,
    provenance_unavailable_controls: count,
    estimated_exposure_inr: z.number().int().safe().nonnegative(),
    narrative: z.string().min(10).max(10000),
  })
  .strict()
  .refine(
    (value) =>
      value.total_controls ===
      value.unknown_controls +
        value.not_applicable_controls +
        value.not_boolean_assessable_controls +
        value.provenance_unavailable_controls +
        Object.values(value.provisional_score_bands).reduce((sum, n) => sum + n, 0),
    { message: 'Assessment summary is incomplete' },
  );

export type AssessmentReportFindingInterpretation = z.infer<
  typeof AssessmentReportFindingInterpretationSchema
>;
const resultSchema = z.object({
  library_version: z.string().min(1).max(200),
  posture_score: z.number().finite().min(0).max(100),
  estimated_exposure_inr: z.number().int().safe().nonnegative(),
  findings: z
    .array(
      z.object({
        control_id: z.string().min(1).max(200),
        score: z.number().finite().min(0).max(100),
      }),
    )
    .min(1)
    .max(500),
});
export function interpretAssessmentReport(
  resultValue: unknown,
  controlsValue: unknown,
  libraryDigest: string,
  title: string,
) {
  const result = resultSchema.parse(resultValue);
  const controls = z
    .array(z.object({ id: z.string().min(1).max(200) }))
    .min(1)
    .max(500)
    .parse(controlsValue);
  const ids = new Set(controls.map((c) => c.id));
  if (
    ids.size !== controls.length ||
    result.findings.length !== controls.length ||
    new Set(result.findings.map((f) => f.control_id)).size !== controls.length ||
    result.findings.some((f) => !ids.has(f.control_id))
  )
    throw new Error('Assessment finding register is incomplete');
  const validated = validateQuestionnaireProvenance(resultValue, controlsValue, libraryDigest);
  const provenance = validated.provenance;
  const interpretation = AssessmentReportInterpretationSchema.parse({
    version: 1,
    provenance: provenance ? 'caller_declared_unverified' : 'unavailable',
    estimates: provenance ? 'provisional' : 'provenance_unavailable',
    review_required: true,
  });
  const byId = new Map(provenance?.controls.map((c) => [c.control_id, c]));
  const findings = result.findings.map((f) => {
    const declared = byId.get(f.control_id);
    const state: AssessmentReportFindingInterpretation['display_state'] = !declared
      ? 'provenance_unavailable'
      : declared.applicability_state === 'caller_declared_not_applicable_unverified'
        ? 'declared_not_applicable_unverified'
        : declared.applicability_state === 'unknown' ||
            ['unknown', 'partially_answered'].includes(declared.answer_state)
          ? 'unknown'
          : declared.answer_state === 'not_boolean_assessable'
            ? 'not_boolean_assessable'
            : 'provisional_score_band';
    return {
      control_id: f.control_id,
      ...AssessmentReportFindingInterpretationSchema.parse({
        display_state: state,
        answer_state: declared?.answer_state ?? null,
        applicability_state: declared?.applicability_state ?? null,
        answer_counts: declared
          ? {
              known: declared.known_boolean_question_count,
              affirmed: declared.caller_affirmed_count,
              denied: declared.caller_denied_count,
              unknown: declared.unknown_count,
            }
          : null,
        score_band:
          state === 'provisional_score_band'
            ? f.score >= 80
              ? 'at_least_80'
              : f.score >= 40
                ? 'from_40_to_under_80'
                : 'under_40'
            : null,
      }),
    };
  });
  const narrative = `This report summarizes the recorded assessment for ${title}. The computed posture score is ${result.posture_score}%. Scores and exposure are provisional computation estimates requiring evidence and human/legal review. Questionnaire declarations and applicability remain unverified; unavailable provenance cannot establish answers or applicability.`;
  const summary = AssessmentReportSummarySchema.parse({
    posture_score: result.posture_score,
    total_controls: controls.length,
    provisional_score_bands: {
      at_least_80: findings.filter((f) => f.score_band === 'at_least_80').length,
      from_40_to_under_80: findings.filter((f) => f.score_band === 'from_40_to_under_80').length,
      under_40: findings.filter((f) => f.score_band === 'under_40').length,
    },
    unknown_controls: findings.filter((f) => f.display_state === 'unknown').length,
    not_applicable_controls: findings.filter(
      (f) => f.display_state === 'declared_not_applicable_unverified',
    ).length,
    not_boolean_assessable_controls: findings.filter(
      (f) => f.display_state === 'not_boolean_assessable',
    ).length,
    provenance_unavailable_controls: findings.filter(
      (f) => f.display_state === 'provenance_unavailable',
    ).length,
    estimated_exposure_inr: result.estimated_exposure_inr,
    narrative,
  });
  return { interpretation, summary, findings };
}
export function assessmentReviewRecommendation(
  state: AssessmentReportFindingInterpretation['display_state'],
  patterns?: string[],
) {
  if (state === 'provenance_unavailable')
    return 'Review the source questionnaire and applicability; their provenance is unavailable.';
  if (state === 'unknown')
    return 'Verify unanswered questionnaire declarations and applicability with supporting evidence before proposing corrective work.';
  if (state === 'not_boolean_assessable')
    return 'Collect supporting evidence for this control; its questionnaire has no Boolean questions.';
  if (state === 'declared_not_applicable_unverified')
    return 'Review the caller’s applicability declaration with supporting evidence before treating this control as out of scope.';
  return `Review the declared answers and supporting evidence. Recorded remediation pattern: ${patterns?.[0] || 'No remediation pattern is recorded in the frozen control library.'}`;
}
