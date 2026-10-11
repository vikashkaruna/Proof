import { z } from 'zod';

const identifier = z.string().min(1).max(200);
export const AssessmentQuestionnaireSchema = z
  .object({
    tenantId: z.uuid(),
    engagementId: z.uuid(),
    libraryVersion: identifier,
    questionnaireDigest: z.string().regex(/^[a-f0-9]{64}$/),
    digestScope: z.literal('ordered_questionnaire_projection_v1'),
    controls: z
      .array(
        z
          .object({
            id: identifier,
            title: z.string().min(1).max(2000),
            questions: z
              .array(
                z
                  .object({
                    id: identifier,
                    prompt: z.string().min(1).max(10000),
                    type: z.enum(['boolean', 'scale', 'text', 'multi', 'evidence']),
                  })
                  .strict(),
              )
              .max(5000),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    declarationsVerified: z.literal(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.controls.map((c) => c.id)).size !== value.controls.length ||
      value.controls.some(
        (c) => new Set(c.questions.map((q) => q.id)).size !== c.questions.length,
      ) ||
      value.controls.reduce((total, c) => total + c.questions.length, 0) > 5000
    )
      context.addIssue({ code: 'custom', message: 'Questionnaire is incomplete or ambiguous' });
  });
export type AssessmentQuestionnaire = z.infer<typeof AssessmentQuestionnaireSchema>;
