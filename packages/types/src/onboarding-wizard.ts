import { z } from 'zod';

/** C-W3-5 resumable onboarding wizard steps, in order. */
export const OnboardingWizardStepSchema = z.enum([
  'company',
  'estate',
  'inventory',
  'connectors',
  'grants',
  'readiness',
]);
export type OnboardingWizardStep = z.infer<typeof OnboardingWizardStepSchema>;

const version = z.number().int().positive();

/** Each step carries only its own fields; the database repeats every check. */
export const AdvanceOnboardingWizardRequestSchema = z.discriminatedUnion('step', [
  z
    .object({
      step: z.literal('company'),
      expectedVersion: version,
      isSdf: z.boolean(),
      processesChildrenData: z.boolean(),
      processesHealthData: z.boolean(),
      dpoName: z.string().trim().min(1).max(200),
      dpoEmail: z.string().trim().toLowerCase().email().max(320),
    })
    .strict(),
  z.object({ step: z.literal('estate'), expectedVersion: version, estateId: z.uuid() }).strict(),
  z.object({ step: z.literal('inventory'), expectedVersion: version }).strict(),
  z
    .object({
      step: z.literal('connectors'),
      expectedVersion: version,
      manualSystemIds: z.array(z.uuid()).max(500),
    })
    .strict(),
  z
    .object({ step: z.literal('grants'), expectedVersion: version, acknowledged: z.literal(true) })
    .strict(),
  z
    .object({ step: z.literal('readiness'), expectedVersion: version, confirmed: z.literal(true) })
    .strict(),
]);
export type AdvanceOnboardingWizardRequest = z.infer<typeof AdvanceOnboardingWizardRequestSchema>;

export const OnboardingReadinessSchema = z.object({
  ready: z.boolean(),
  checks: z.array(
    z.object({
      key: z.string(),
      ok: z.boolean(),
      count: z.number().optional(),
      missing: z.number().optional(),
    }),
  ),
  counts: z.object({
    systems: z.number(),
    registeredConnectors: z.number(),
    manualSystems: z.number(),
    activeReadGrants: z.number(),
    activeWriteGrants: z.number(),
  }),
});
export type OnboardingReadiness = z.infer<typeof OnboardingReadinessSchema>;

export const OnboardingWizardSchema = z.object({
  id: z.uuid(),
  tenant_id: z.uuid(),
  estate_id: z.uuid().nullable(),
  status: z.enum(['in_progress', 'completed']),
  completed_steps: z.array(OnboardingWizardStepSchema),
  manual_system_ids: z.array(z.uuid()),
  version: z.number().int(),
  started_by: z.uuid(),
  completed_by: z.uuid().nullable(),
  completed_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type OnboardingWizard = z.infer<typeof OnboardingWizardSchema>;
