import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const declaration = z
  .object({
    value: z.boolean().nullable(),
    provenance: z.enum(['unknown', 'caller_declared_unverified']),
  })
  .strict()
  .refine((v) => v.provenance === (v.value === null ? 'unknown' : 'caller_declared_unverified'));
const questionDeclaration = z
  .object({
    question_id: z.string().min(1).max(200),
    declaration: z.enum(['unknown', 'caller_affirmed', 'caller_denied']),
  })
  .strict();
const provenanceControl = z
  .object({
    control_id: z.string().min(1).max(200),
    questions: z.array(questionDeclaration).max(1000),
    known_boolean_question_count: z.number().int().min(0).max(1000),
    caller_affirmed_count: z.number().int().min(0).max(1000),
    caller_denied_count: z.number().int().min(0).max(1000),
    unknown_count: z.number().int().min(0).max(1000),
    answer_state: z.enum([
      'unknown',
      'partially_answered',
      'caller_declared_unverified',
      'not_boolean_assessable',
    ]),
    applicability_state: z.enum([
      'unconditional',
      'unknown',
      'caller_declared_applicable_unverified',
      'caller_declared_not_applicable_unverified',
    ]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const total = value.questions.length;
    const yes = value.questions.filter((q) => q.declaration === 'caller_affirmed').length;
    const no = value.questions.filter((q) => q.declaration === 'caller_denied').length;
    const unknown = total - yes - no;
    const state =
      total === 0
        ? 'not_boolean_assessable'
        : unknown === total
          ? 'unknown'
          : unknown
            ? 'partially_answered'
            : 'caller_declared_unverified';
    if (
      new Set(value.questions.map((q) => q.question_id)).size !== total ||
      value.known_boolean_question_count !== total ||
      value.caller_affirmed_count !== yes ||
      value.caller_denied_count !== no ||
      value.unknown_count !== unknown ||
      value.answer_state !== state
    )
      ctx.addIssue({ code: 'custom', message: 'Question declaration binding refused' });
  });
export const questionnaireProvenanceSchema = z
  .object({
    version: z.literal(1),
    source_library_version: z.string().min(1).max(200),
    source_library_digest: digest.nullable(),
    estimates: z.literal('provisional'),
    review_required: z.literal(true),
    controls: z.array(provenanceControl).min(1).max(500),
    applicability: z
      .object({
        sdf_self_attested: declaration,
        processes_children: declaration,
        processes_health: declaration,
      })
      .strict(),
  })
  .strict()
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262144, {
    message: 'Questionnaire provenance size limit exceeded',
  });
export type QuestionnaireProvenance = z.infer<typeof questionnaireProvenanceSchema>;
const minimalAssessmentSourceSchema = z
  .object({
    library_version: z.string().min(1).max(200),
    findings: z
      .array(z.object({ control_id: z.string().min(1).max(200) }))
      .min(1)
      .max(500),
    questionnaire_provenance: questionnaireProvenanceSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const provenance = value.questionnaire_provenance;
    if (!provenance) return;
    const ids = provenance.controls.map((c) => c.control_id);
    if (
      provenance.source_library_version !== value.library_version ||
      new Set(ids).size !== ids.length ||
      new Set(value.findings.map((f) => f.control_id)).size !== value.findings.length ||
      ids.length !== value.findings.length ||
      value.findings.some((f) => !ids.includes(f.control_id))
    )
      ctx.addIssue({ code: 'custom', message: 'Control provenance binding refused' });
  });
export const pinnedQuestionnaireControlsSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(200),
      library_version: z.string().min(1).max(200),
      sdf_only: z.boolean(),
      children_only: z.boolean(),
      assessment_questions: z
        .array(z.object({ id: z.string().min(1).max(200), type: z.string().min(1).max(100) }))
        .max(1000),
    }),
  )
  .min(1)
  .max(500)
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262144, {
    message: 'Pinned questionnaire source size limit exceeded',
  });

/** Validate against an actual trusted immutable packet; no rationale parsing,
 * caller-provided library substitute or legacy inference is permitted. */
export function validateQuestionnaireProvenance(
  result: unknown,
  controls: unknown,
  expectedLibraryDigest: string,
) {
  const parsed = minimalAssessmentSourceSchema.parse(result);
  const provenance = parsed.questionnaire_provenance;
  if (!provenance) return { status: 'unavailable' as const, provenance: null };
  if (provenance.source_library_digest !== digest.parse(expectedLibraryDigest))
    throw new Error('Assessment provenance binding refused');
  const library = pinnedQuestionnaireControlsSchema.parse(controls);
  if (
    new Set(library.map((c) => c.id)).size !== library.length ||
    library.length !== provenance.controls.length
  )
    throw new Error('Assessment provenance binding refused');
  for (const control of library) {
    const declared = provenance.controls.find((c) => c.control_id === control.id);
    const questions = control.assessment_questions
      .filter((q) => q.type === 'boolean')
      .map((q) => q.id);
    if (
      !declared ||
      control.library_version !== parsed.library_version ||
      new Set(questions).size !== questions.length ||
      declared.questions.length !== questions.length ||
      declared.questions.some((q) => !questions.includes(q.question_id))
    )
      throw new Error('Assessment provenance binding refused');
    const required = [];
    if (control.sdf_only) required.push(provenance.applicability.sdf_self_attested.value);
    if (control.children_only) required.push(provenance.applicability.processes_children.value);
    const applicable = !required.length
      ? 'unconditional'
      : required.some((v) => v === false)
        ? 'caller_declared_not_applicable_unverified'
        : required.some((v) => v === null)
          ? 'unknown'
          : 'caller_declared_applicable_unverified';
    if (declared.applicability_state !== applicable)
      throw new Error('Assessment provenance binding refused');
  }
  return { status: 'available_unverified' as const, provenance };
}
