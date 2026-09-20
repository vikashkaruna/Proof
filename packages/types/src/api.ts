import { z } from 'zod';
import { ActionType, ActorType, LedgerResult } from './enums';

/**
 * REST API contract shared by the BFF and the Next.js apps.
 *
 * Every mutating endpoint requires:
 *   - An Idempotency-Key header (UUID v4)
 *   - A signed, tenant-scoped Authorization bearer (Supabase JWT)
 *
 * The execution-gate endpoint (`POST /v1/plans/:id/execute`) additionally
 * requires an ApprovalToken in the body — see the schema below.
 */

// ─── Common ──────────────────────────────────────────────────────────

export const PaginationSchema = z.object({
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(25),
});
export type Pagination = z.infer<typeof PaginationSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    traceId: z.string().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ─── Auth ────────────────────────────────────────────────────────────

export const SessionSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
  fullName: z.string().nullable(),
  isAxiomInternal: z.boolean(),
  tenants: z.array(
    z.object({
      tenantId: z.string().uuid(),
      slug: z.string(),
      name: z.string(),
      role: z.string(),
    }),
  ),
  activeTenantId: z.string().uuid().nullable(),
  expiresAt: z.string().datetime(),
});
export type Session = z.infer<typeof SessionSchema>;

// ─── Gap scan (public) ───────────────────────────────────────────────

export const GapScanSubmitSchema = z.object({
  sessionId: z.string().min(8).max(128),
  sector: z.string().max(100).optional(),
  employeeBand: z.enum(['1-50', '51-200', '201-500', '501-1000', '1001-5000', '5000+']).optional(),
  processesChildrenData: z.boolean().optional(),
  isSdf: z.boolean().optional(),
  answers: z.record(
    z.string(),
    z.union([z.boolean(), z.string(), z.number(), z.array(z.string())]),
  ),
  contactName: z.string().min(2).max(120).optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().max(40).optional(),
  contactCompany: z.string().max(200).optional(),
  followUpRequested: z.boolean().default(false),
  marketingConsent: z.boolean().default(false),
  source: z.string().max(100).optional(),
});
export type GapScanSubmit = z.infer<typeof GapScanSubmitSchema>;

export const ReadinessIndexSchema = z.object({
  sector: z.string(),
  companyScore: z.number(),
  sectorBenchmarkScore: z.number(),
  percentileRank: z.number(),
  status: z.enum(['leading', 'on_track', 'lagging']),
  exposureMultiplier: z.number(),
  sectorTopRisks: z.array(z.string()),
  quarterlyRoadmap: z.array(
    z.object({
      quarter: z.string(),
      targetScore: z.number(),
      milestone: z.string(),
      statutoryDeadline: z.string(),
    }),
  ),
  generatedAt: z.string(),
});
export type ReadinessIndex = z.infer<typeof ReadinessIndexSchema>;

export const GapScanReportSchema = z.object({
  postureScore: z.number().min(0).max(100),
  estimatedExposureInr: z.number().nonnegative(),
  findings: z.array(
    z.object({
      controlId: z.string(),
      title: z.string(),
      domain: z.string(),
      severity: z.enum(['critical', 'high', 'medium', 'low']),
      score: z.number().min(0).max(100),
      riskPoints: z.number().nonnegative(),
      rationale: z.string(),
    }),
  ),
  recommendations: z.array(
    z.object({
      priority: z.number().int().positive(),
      title: z.string(),
      effort: z.string(),
    }),
  ),
  libraryVersion: z.string(),
  readinessIndex: ReadinessIndexSchema.optional(),
});
export type GapScanReport = z.infer<typeof GapScanReportSchema>;

// ─── Contact inquiry (public) ────────────────────────────────────────

export const ContactSubmitSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
  email: z.string().trim().email('Please enter a valid email address'),
  company: z.string().trim().max(200).optional(),
  message: z.string().trim().min(10, 'Message must be at least 10 characters').max(5000),
});
export type ContactSubmit = z.infer<typeof ContactSubmitSchema>;

// ─── Engagements ─────────────────────────────────────────────────────

export const CreateEngagementSchema = z.object({
  tenantId: z.string().uuid(),
  libraryVersion: z.string(),
  title: z.string().min(3).max(200),
  leadReviewerId: z.string().uuid().optional(),
});
export type CreateEngagementRequest = z.infer<typeof CreateEngagementSchema>;

export const UpdateEngagementStatusSchema = z.object({
  status: z.enum([
    'intake',
    'discovery',
    'classification',
    'assessment',
    'planning',
    'review',
    'dry_run',
    'awaiting_approval',
    'executing',
    'verifying',
    'closure',
    'completed',
    'paused',
    'cancelled',
  ]),
  note: z.string().max(1000).optional(),
});
export type UpdateEngagementStatusRequest = z.infer<typeof UpdateEngagementStatusSchema>;

// ─── Evidence ────────────────────────────────────────────────────────

export const SealedEvidenceMetadataSchema = z.object({
  tenantId: z.string().uuid(),
  engagementId: z.string().uuid().optional(),
  evidenceType: z.enum([
    'document',
    'config',
    'screenshot',
    'log',
    'attestation',
    'interview',
    'inventory',
    'report',
  ]),
  description: z.string().max(2000).optional(),
  collectedByAgent: z.string(),
  demonstratesControlIds: z.array(z.string()).default([]),
  filename: z.string().max(512).optional(),
  mimeType: z.string().max(200).optional(),
  byteSize: z.number().int().nonnegative().optional(),
  wormLockUntil: z.string().datetime().optional(),
});
export type SealedEvidenceMetadata = z.infer<typeof SealedEvidenceMetadataSchema>;

// ─── Plans / Actions / Approvals (the execution gate) ───────────────

export const GeneratePlanRequestSchema = z.object({
  engagementId: z.string().uuid(),
  libraryVersion: z.string(),
  findingIds: z.array(z.string().uuid()).min(1).max(100),
  title: z.string().min(3).max(200),
  description: z.string().max(2000).optional(),
});
export type GeneratePlanRequest = z.infer<typeof GeneratePlanRequestSchema>;

export const RunDryRunRequestSchema = z.object({
  actionIds: z.array(z.string().uuid()).min(1).max(100),
  // The dry-run engine returns results async via the agent runtime;
  // the BFF returns a job ID and the result is published to the
  // ledger + WebSocket channel.
  waitForCompletion: z.boolean().default(false),
  waitTimeoutSeconds: z.number().int().positive().max(300).default(60),
});
export type RunDryRunRequest = z.infer<typeof RunDryRunRequestSchema>;

export const IssueApprovalRequestSchema = z
  .object({
    planId: z.string().uuid(),
    actionIds: z.array(z.string().uuid()).min(1).max(100),
    mode: z.enum(['batch', 'individual']).default('batch'),
    concurrency: z.number().int().positive().max(20).default(1),
    stopOnFailure: z.boolean().default(true),
    expiresInMinutes: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60)
      .default(60),
    reason: z.string().max(2000).nullish(),
    conditions: z.record(z.string(), z.unknown()).default({}),

    /**
     * The satisfied MFA challenge authorising this approval (W1 · SEC-8).
     *
     * Optional in the schema and mandatory at the route, deliberately: a
     * missing challenge has to produce `mfa_challenge_required` with the
     * binding the client should request, not a generic `validation_failed`
     * that tells an approver nothing about what to do next.
     *
     * The challenge is bound to this exact plan and action set, so one
     * satisfied step-up cannot be redirected at a different approval, and
     * it is spent once, so it cannot authorise two.
     */
    mfaChallengeId: z.string().uuid().nullish(),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.actionIds).size !== value.actionIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actionIds'],
        message: 'actionIds must not contain duplicates',
      });
    }
  });
export type IssueApprovalRequest = z.infer<typeof IssueApprovalRequestSchema>;

export const RevokeApprovalRequestSchema = z.object({
  reason: z.string().max(2000).nullish(),
});
export type RevokeApprovalRequest = z.infer<typeof RevokeApprovalRequestSchema>;

// ─── Multi-factor authentication (W1 · SEC-8) ─────────────────────────────

export const BeginMfaEnrolmentRequestSchema = z.object({
  /** Friendly device name, e.g. "iPhone Authenticator". Never the secret. */
  label: z.string().max(120).nullish(),
});
export type BeginMfaEnrolmentRequest = z.infer<typeof BeginMfaEnrolmentRequestSchema>;

export const ActivateMfaEnrolmentRequestSchema = z.object({
  code: z.string().min(6).max(12),
});
export type ActivateMfaEnrolmentRequest = z.infer<typeof ActivateMfaEnrolmentRequestSchema>;

export const MfaChallengePurposeSchema = z.enum([
  'login',
  'approval_issuance',
  'enrolment',
  'factor_revocation',
]);
export type MfaChallengePurpose = z.infer<typeof MfaChallengePurposeSchema>;

/**
 * Issuing a challenge for `approval_issuance` requires the thing being
 * approved, because the challenge is bound to it. Requiring the binding
 * inputs here rather than accepting a bare purpose is what stops a client
 * obtaining a general-purpose step-up and spending it on anything.
 */
export const IssueMfaChallengeRequestSchema = z
  .object({
    purpose: MfaChallengePurposeSchema,
    planId: z.string().uuid().nullish(),
    actionIds: z.array(z.string().uuid()).min(1).max(100).nullish(),
    mode: z.enum(['batch', 'individual']).default('batch'),
  })
  .superRefine((value, ctx) => {
    if (value.purpose !== 'approval_issuance') return;
    if (!value.planId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['planId'],
        message: 'planId is required for an approval_issuance challenge',
      });
    }
    if (!value.actionIds || value.actionIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actionIds'],
        message: 'actionIds is required for an approval_issuance challenge',
      });
    } else if (new Set(value.actionIds).size !== value.actionIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actionIds'],
        message: 'actionIds must not contain duplicates',
      });
    }
  });
export type IssueMfaChallengeRequest = z.infer<typeof IssueMfaChallengeRequestSchema>;

export const VerifyMfaChallengeRequestSchema = z.object({
  /**
   * A six-digit TOTP code, or a recovery code. The server decides which by
   * shape; the client does not get to declare it, because letting a caller
   * choose the verification path is how you end up with one that skips a
   * check the other performs.
   */
  code: z.string().min(6).max(32),
});
export type VerifyMfaChallengeRequest = z.infer<typeof VerifyMfaChallengeRequestSchema>;

// THE EXECUTION GATE — the single most security-critical contract in the system.
// Per ADR-2 / BR-1, the ApprovalToken in the body is the gate that makes
// unapproved execution architecturally impossible.
export const ExecutePlanRequestSchema = z
  .object({
    planId: z.string().uuid(),
    approvalToken: z.string(), // the signed token string
    mode: z.enum(['batch', 'individual']).default('batch'),
    actionIds: z.array(z.string().uuid()).min(1), // subset for partial approval
    concurrency: z.number().int().positive().max(20).default(1),
    stopOnFailure: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.actionIds).size !== value.actionIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actionIds'],
        message: 'actionIds must not contain duplicates',
      });
    }
  });
export type ExecutePlanRequest = z.infer<typeof ExecutePlanRequestSchema>;

export const ExecutePlanResponseSchema = z.object({
  executionId: z.string().uuid(),
  correlationId: z.string().uuid(),
  acceptedActionIds: z.array(z.string().uuid()),
  rejectedActionIds: z.array(
    z.object({
      actionId: z.string().uuid(),
      reason: z.string(),
    }),
  ),
  status: z.enum(['accepted', 'partial', 'rejected', 'dispatch_failed', 'dispatch_unknown']),
  startedAt: z.string().datetime(),
});
export type ExecutePlanResponse = z.infer<typeof ExecutePlanResponseSchema>;

// ─── Agent invocation (internal) ────────────────────────────────────

export const AgentInvocationRequestSchema = z.object({
  agent: z.string(),
  tenantId: z.string().uuid(),
  engagementId: z.string().uuid().optional(),
  planId: z.string().uuid().optional(),
  promptHandle: z.string(),
  inputs: z.record(z.string(), z.unknown()),
  // If the agent is structural-only (e.g. Drishti, Vibhaag), set this
  // true so the model gateway skips PII redaction of row values.
  structuralOnly: z.boolean().default(false),
});
export type AgentInvocationRequest = z.infer<typeof AgentInvocationRequestSchema>;

// ─── Ledger query ────────────────────────────────────────────────────

export const LedgerQuerySchema = z.object({
  tenantId: z.string().uuid(),
  fromSequence: z.number().int().positive().optional(),
  toSequence: z.number().int().positive().optional(),
  fromTime: z.string().datetime().optional(),
  toTime: z.string().datetime().optional(),
  actorType: z.nativeEnum(ActorType).optional(),
  actorId: z.string().optional(),
  actionType: z.string().optional(),
  correlationId: z.string().uuid().optional(),
  result: z.nativeEnum(LedgerResult).optional(),
  limit: z.number().int().positive().max(1000).default(100),
  offset: z.number().int().nonnegative().default(0),
});
export type LedgerQuery = z.infer<typeof LedgerQuerySchema>;

// ─── WebSocket events (server → client) ─────────────────────────────

export const AgentProgressEventSchema = z.object({
  type: z.literal('agent.progress'),
  agent: z.string(),
  correlationId: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  step: z.string(),
  progress: z.number().min(0).max(1),
  message: z.string().optional(),
  occurredAt: z.string().datetime(),
});
export type AgentProgressEvent = z.infer<typeof AgentProgressEventSchema>;

export const LedgerAppendedEventSchema = z.object({
  type: z.literal('ledger.appended'),
  tenantId: z.string().uuid(),
  sequenceNo: z.number().int().positive(),
  actionType: z.string(),
  correlationId: z.string().uuid(),
  occurredAt: z.string().datetime(),
});
export type LedgerAppendedEvent = z.infer<typeof LedgerAppendedEventSchema>;

export const ApprovalPendingEventSchema = z.object({
  type: z.literal('approval.pending'),
  planId: z.string().uuid(),
  actionIds: z.array(z.string().uuid()),
  correlationId: z.string().uuid(),
  occurredAt: z.string().datetime(),
});
export type ApprovalPendingEvent = z.infer<typeof ApprovalPendingEventSchema>;

export const ExecutionProgressEventSchema = z.object({
  type: z.literal('execution.progress'),
  executionId: z.string().uuid(),
  planId: z.string().uuid(),
  actionId: z.string().uuid(),
  status: z.string(),
  result: z.string().nullable(),
  occurredAt: z.string().datetime(),
});
export type ExecutionProgressEvent = z.infer<typeof ExecutionProgressEventSchema>;

export const RealtimeEventSchema = z.discriminatedUnion('type', [
  AgentProgressEventSchema,
  LedgerAppendedEventSchema,
  ApprovalPendingEventSchema,
  ExecutionProgressEventSchema,
]);
export type RealtimeEvent = z.infer<typeof RealtimeEventSchema>;
