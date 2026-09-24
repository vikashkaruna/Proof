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

/** C-W3-6: a human decision on an agent's connector grant. */
export const AttestConnectorGrantRequestSchema = z
  .object({ decision: z.enum(['keep', 'revoke']) })
  .strict();
export type AttestConnectorGrantRequest = z.infer<typeof AttestConnectorGrantRequestSchema>;

const driftItem = z.object({ id: z.uuid(), name: z.string() });
export const EstateDriftSchema = z.object({
  status: z.enum(['not_onboarded', 'no_baseline', 'current', 'drifted']),
  baselineWizardId: z.uuid().optional(),
  completedAt: z.string().optional(),
  added: z.array(driftItem).optional(),
  removed: z.array(driftItem).optional(),
  changed: z.array(driftItem).optional(),
  connectionLost: z.array(driftItem).optional(),
});
export type EstateDrift = z.infer<typeof EstateDriftSchema>;

export const GrantReviewItemSchema = z.object({
  id: z.uuid(),
  connectorId: z.uuid(),
  connectorName: z.string(),
  agentName: z.string(),
  scope: z.enum(['connector.read', 'connector.write']),
  targetScopes: z.array(z.string()),
  expiresAt: z.string(),
  lastAttestedAt: z.string().nullable(),
  dueAt: z.string(),
  overdue: z.boolean(),
});
export type GrantReviewItem = z.infer<typeof GrantReviewItemSchema>;

/** W4.4: human issuance of an agent connector grant (Drishti read, Karya write). */
export const IssueConnectorGrantRequestSchema = z
  .object({
    connectorId: z.uuid(),
    workloadIdentityId: z.uuid(),
    scope: z.enum(['connector.read', 'connector.write']),
    targetScopes: z
      .array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/))
      .min(1)
      .max(100)
      .refine((v) => new Set(v).size === v.length, 'Target scopes must be distinct'),
    ttlDays: z.number().int().min(1).max(90),
  })
  .strict();
export type IssueConnectorGrantRequest = z.infer<typeof IssueConnectorGrantRequestSchema>;

/** W4.5: register a classified, hash-pinned tool on a connector. */
export const RegisterConnectorToolRequestSchema = z
  .object({
    toolName: z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/),
    toolVersion: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
    operationClass: z.enum(['read', 'write']),
    description: z.string().trim().min(1).max(4000),
    inputSchema: z.object({ type: z.literal('object') }).passthrough(),
  })
  .strict();
export type RegisterConnectorToolRequest = z.infer<typeof RegisterConnectorToolRequestSchema>;
