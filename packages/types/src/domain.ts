import { z } from 'zod';
import {
  ActionRiskClass,
  ActionStatus,
  ActionType,
  AgentName,
  ApprovalStatus,
  ControlDomain,
  ControlSeverity,
  EngagementStatus,
  EvidenceType,
  FindingStatus,
  LedgerActionType,
  LedgerResult,
  PlanStatus,
  TenantTier,
  UserRole,
} from './enums';

// ─── Branded IDs ─────────────────────────────────────────────────────
// The BFF and apps work with opaque IDs. Branded types prevent
// accidentally passing a tenant_id where an engagement_id is expected.

export type TenantId = string & { readonly __brand: 'TenantId' };
export type UserId = string & { readonly __brand: 'UserId' };
export type EngagementId = string & { readonly __brand: 'EngagementId' };
export type FindingId = string & { readonly __brand: 'FindingId' };
export type EvidenceId = string & { readonly __brand: 'EvidenceId' };
export type PlanId = string & { readonly __brand: 'PlanId' };
export type ActionId = string & { readonly __brand: 'ActionId' };
export type ApprovalTokenId = string & { readonly __brand: 'ApprovalTokenId' };
export type ControlId = string & { readonly __brand: 'ControlId' };
export type LibraryVersion = string & { readonly __brand: 'LibraryVersion' };
export type CorrelationId = string & { readonly __brand: 'CorrelationId' };
export type AgentRunId = string & { readonly __brand: 'AgentRunId' };
export type BreachId = string & { readonly __brand: 'BreachId' };
export type DsarId = string & { readonly __brand: 'DsarId' };
export type ReportId = string & { readonly __brand: 'ReportId' };

// ─── Tenant ──────────────────────────────────────────────────────────

export const TenantSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1).max(64),
  name: z.string().min(1),
  tier: z.nativeEnum(TenantTier),
  dataResidencyRegion: z.string(),
  isSdf: z.boolean(),
  processesChildrenData: z.boolean(),
  processesHealthData: z.boolean(),
  createdAt: z.string().datetime(),
});
export type Tenant = z.infer<typeof TenantSchema>;

// ─── User ────────────────────────────────────────────────────────────

export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  fullName: z.string().nullable(),
  isAxiomInternal: z.boolean(),
  createdAt: z.string().datetime(),
});
export type User = z.infer<typeof UserSchema>;

export const TenantMembershipSchema = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  role: z.nativeEnum(UserRole),
  approvalScopes: z.array(z.string()),
});
export type TenantMembership = z.infer<typeof TenantMembershipSchema>;

// ─── Control ─────────────────────────────────────────────────────────

export const ControlCitationSchema = z.object({
  instrument: z.enum(['DPDPA-2023', 'DPDPR-2025', 'IT-Act-2000', 'CERT-In-2022', 'Other']),
  reference: z.string(),
  url: z.string().url().optional(),
});
export type ControlCitation = z.infer<typeof ControlCitationSchema>;

export const ControlEvidenceRequirementSchema = z.object({
  type: z.nativeEnum(EvidenceType),
  description: z.string(),
  retention: z.string().optional(),
});
export type ControlEvidenceRequirement = z.infer<typeof ControlEvidenceRequirementSchema>;

export const ControlScoringSchema = z.object({
  baseline: z.number().min(0).max(100),
  weight: z.number().min(0).max(1),
  penaltyPoints: z.number().min(0).max(100),
  maxPenaltyINR: z.number().int().nonnegative(),
});
export type ControlScoring = z.infer<typeof ControlScoringSchema>;

export const ControlQuestionSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  type: z.enum(['boolean', 'scale', 'text', 'multi', 'evidence']),
  scaleAnchors: z.array(z.string()).optional(),
  options: z.array(z.string()).optional(),
  evidenceTypes: z.array(z.nativeEnum(EvidenceType)).optional().default([]),
  dependsOn: z.array(z.string()).optional().default([]),
});
export type ControlQuestion = z.infer<typeof ControlQuestionSchema>;

export const ControlSchema = z.object({
  id: z.string(),
  libraryVersion: z.string(),
  title: z.string(),
  obligation: z.string(),
  domain: z.nativeEnum(ControlDomain),
  severity: z.nativeEnum(ControlSeverity),
  citations: z.array(ControlCitationSchema),
  evidenceRequired: z.array(ControlEvidenceRequirementSchema),
  assessmentQuestions: z.array(ControlQuestionSchema).min(1),
  scoring: ControlScoringSchema,
  remediationPatterns: z.array(z.string()),
  tags: z.array(z.string()),
  sdfOnly: z.boolean(),
  childrenOnly: z.boolean(),
  introducedInVersion: z.string(),
  revisedInVersion: z.string().optional(),
  notes: z.string().optional(),
});
export type Control = z.infer<typeof ControlSchema>;

// ─── Engagement / Finding ────────────────────────────────────────────

export const EngagementSchema = z.object({
  // Legacy assessments remain unassigned; never invent an estate from a tenant.
  estateId: z.string().uuid().nullable().default(null),
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  libraryVersion: z.string(),
  title: z.string(),
  status: z.nativeEnum(EngagementStatus),
  postureScore: z.number().min(0).max(100).nullable(),
  estimatedExposureInr: z.number().int().nonnegative().nullable(),
  leadReviewerId: z.string().uuid().nullable(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Engagement = z.infer<typeof EngagementSchema>;

export const FindingSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  engagementId: z.string().uuid(),
  controlId: z.string(),
  libraryVersion: z.string(),
  status: z.nativeEnum(FindingStatus),
  score: z.number().min(0).max(100),
  riskPoints: z.number().min(0),
  rationale: z.string(),
  evidenceIds: z.array(z.string().uuid()),
  answers: z.record(z.string(), z.unknown()),
  reviewedBy: z.string().uuid().nullable(),
  reviewedAt: z.string().datetime().nullable(),
  reviewNotes: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type Finding = z.infer<typeof FindingSchema>;

// ─── Evidence ────────────────────────────────────────────────────────

export const EvidenceSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  engagementId: z.string().uuid().nullable(),
  contentHash: z.string().length(64),
  storageUri: z.string(),
  filename: z.string().nullable(),
  mimeType: z.string().nullable(),
  byteSize: z.number().int().nonnegative().nullable(),
  evidenceType: z.nativeEnum(EvidenceType),
  description: z.string().nullable(),
  collectedByAgent: z.string(),
  collectedAt: z.string().datetime(),
  demonstratesControlIds: z.array(z.string()),
  wormLockUntil: z.string().datetime().nullable(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

// ─── Plan / Action ───────────────────────────────────────────────────

export const BlastRadiusSchema = z.object({
  recordsAffected: z.number().int().nonnegative(),
  systemsAffected: z.array(z.string()),
  usersAffected: z.number().int().nonnegative(),
  environment: z.enum(['production', 'staging', 'development', 'n/a']),
  notes: z.string().optional(),
});
export type BlastRadius = z.infer<typeof BlastRadiusSchema>;

export const RollbackDefinitionSchema = z.object({
  type: z.literal('typed'),
  // Reference to the action that undoes this one
  inverseActionType: z.nativeEnum(ActionType).optional(),
  // Or a free-form reversible definition (validated as executable)
  steps: z.array(
    z.object({
      description: z.string(),
      action: z.string(), // a callable name in the executor
      parameters: z.record(z.string(), z.unknown()).default({}),
    }),
  ),
  estimatedRollbackTimeSeconds: z.number().int().nonnegative(),
  // Pre-conditions for the rollback to be valid
  preconditions: z.array(z.string()).default([]),
  // Whether the rollback has been validated as executable in dry-run
  validatedExecutable: z.boolean().default(false),
});
export type RollbackDefinition = z.infer<typeof RollbackDefinitionSchema>;

export const RemediationActionSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  planId: z.string().uuid(),
  sequence: z.number().int().positive(),
  actionType: z.nativeEnum(ActionType),
  parameters: z.record(z.string(), z.unknown()),
  description: z.string(),
  closesFindingIds: z.array(z.string().uuid()),
  riskClass: z.nativeEnum(ActionRiskClass),
  riskScore: z.number().min(0).max(100),
  blastRadius: BlastRadiusSchema,
  rollbackDefinition: RollbackDefinitionSchema,
  rollbackValidated: z.boolean(),
  dryRunStatus: z.nativeEnum(ActionStatus),
  dryRunResult: z.record(z.string(), z.unknown()).nullable(),
  dryRunCompletedAt: z.string().datetime().nullable(),
  dryRunExpiresAt: z.string().datetime().nullable(),
  approvalStatus: z.nativeEnum(ActionStatus),
  approvalTokenId: z.string().uuid().nullable(),
  approvedBy: z.string().uuid().nullable(),
  approvedAt: z.string().datetime().nullable(),
  executionStatus: z.nativeEnum(ActionStatus),
  executedByAgent: z.string().nullable(),
  executedAt: z.string().datetime().nullable(),
  preStateUri: z.string().nullable(),
  postStateUri: z.string().nullable(),
  verificationStatus: z.nativeEnum(ActionStatus).nullable(),
  verificationResult: z.record(z.string(), z.unknown()).nullable(),
  verifiedAt: z.string().datetime().nullable(),
  finalOutcome: z.enum(['succeeded', 'failed', 'rolled_back', 'skipped']).nullable(),
});
export type RemediationAction = z.infer<typeof RemediationActionSchema>;

export const RemediationPlanSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  engagementId: z.string().uuid(),
  libraryVersion: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.nativeEnum(PlanStatus),
  version: z.number().int().positive(),
  dependsOn: z.string().uuid().nullable(),
  generatedByAgent: z.string(),
  planApprovalTokenId: z.string().uuid().nullable(),
  aggregateBlastRadius: BlastRadiusSchema,
  actions: z.array(RemediationActionSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type RemediationPlan = z.infer<typeof RemediationPlanSchema>;

// ─── Approval Token ──────────────────────────────────────────────────

export const ApprovalTokenSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  planId: z.string().uuid(),
  actionIds: z.array(z.string().uuid()),
  approverId: z.string().uuid(),
  mode: z.enum(['batch', 'individual']),
  concurrency: z.number().int().positive(),
  stopOnFailure: z.boolean(),
  signature: z.string(),
  signedPayload: z.record(z.string(), z.unknown()),
  nonce: z.string(),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  consumedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  status: z.nativeEnum(ApprovalStatus),
  reason: z.string().nullable(),
  conditions: z.record(z.string(), z.unknown()),
});
export type ApprovalToken = z.infer<typeof ApprovalTokenSchema>;

// ─── Audit Ledger ────────────────────────────────────────────────────

export const AuditLedgerEntrySchema = z.object({
  id: z.string(),
  tenantId: z.string().uuid(),
  sequenceNo: z.number().int().positive(),
  correlationId: z.string().uuid(),
  actorType: z.enum(['agent', 'human', 'system']),
  actorId: z.string(),
  agentVersion: z.string().nullable(),
  modelId: z.string().nullable(),
  promptHash: z.string().nullable(),
  actionType: z.nativeEnum(LedgerActionType),
  targetRef: z.string().nullable(),
  inputHash: z.string().nullable(),
  outputHash: z.string().nullable(),
  approvalTokenId: z.string().uuid().nullable(),
  approverId: z.string().uuid().nullable(),
  preStateRef: z.string().nullable(),
  postStateRef: z.string().nullable(),
  result: z.nativeEnum(LedgerResult),
  detail: z.record(z.string(), z.unknown()),
  occurredAt: z.string().datetime(),
  prevEntryHash: z.string().nullable(),
  entryHash: z.string(),
});
export type AuditLedgerEntry = z.infer<typeof AuditLedgerEntrySchema>;

// ─── Agent Run ───────────────────────────────────────────────────────

export const AgentRunSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  agent: z.nativeEnum(AgentName),
  engagementId: z.string().uuid().nullable(),
  planId: z.string().uuid().nullable(),
  promptId: z.string().uuid().nullable(),
  modelId: z.string().nullable(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out']),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  totalTokens: z.number().int().nullable(),
  costUsd: z.number().nullable(),
  latencyMs: z.number().int().nullable(),
  error: z.string().nullable(),
  correlationId: z.string().uuid(),
  piiRedacted: z.boolean(),
  metadata: z.record(z.string(), z.unknown()),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

// ─── Gap scan ────────────────────────────────────────────────────────

export const GapScanResponseSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string(),
  sector: z.string().nullable(),
  employeeBand: z.enum(['1-50', '51-200', '201-500', '501-1000', '1001-5000', '5000+']).nullable(),
  processesChildrenData: z.boolean().nullable(),
  isSdf: z.boolean().nullable(),
  answers: z.record(z.string(), z.unknown()),
  reportSnapshot: z.record(z.string(), z.unknown()).nullable(),
  libraryVersion: z.string(),
  postureScore: z.number().min(0).max(100).nullable(),
  estimatedExposureInr: z.number().int().nonnegative().nullable(),
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactCompany: z.string().nullable(),
  followUpRequested: z.boolean(),
  marketingConsent: z.boolean(),
  createdAt: z.string().datetime(),
});
export type GapScanResponse = z.infer<typeof GapScanResponseSchema>;

// ─── DSAR ────────────────────────────────────────────────────────────

export const DsarSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  kind: z.enum(['access', 'correction', 'erasure', 'nominate', 'portability']),
  status: z.enum([
    'received',
    'identity_verification',
    'in_fulfilment',
    'completed',
    'rejected',
    'escalated',
  ]),
  dataPrincipalName: z.string().nullable(),
  dataPrincipalEmail: z.string().nullable(),
  dataPrincipalPhone: z.string().nullable(),
  identityVerified: z.boolean(),
  identityVerificationMethod: z.string().nullable(),
  dueBy: z.string().datetime(),
  receivedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  rejectionReason: z.string().nullable(),
  assignedTo: z.string().uuid().nullable(),
  notes: z.string().nullable(),
});
export type Dsar = z.infer<typeof DsarSchema>;

// ─── Breach ──────────────────────────────────────────────────────────

export const BreachSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  status: z.enum([
    'detected',
    'triaging',
    'contained',
    'notifying_dpb',
    'notifying_principals',
    'post_mortem',
    'closed',
  ]),
  occurredAt: z.string().datetime().nullable(),
  detectedAt: z.string().datetime(),
  dpbNotificationDueBy: z.string().datetime(),
  affectedCount: z.number().int().nonnegative().nullable(),
  dataCategories: z.array(z.string()),
  dpbNotifiedAt: z.string().datetime().nullable(),
  dpbReference: z.string().nullable(),
  principalsNotifiedAt: z.string().datetime().nullable(),
  ownerId: z.string().uuid().nullable(),
  postMortem: z.string().nullable(),
  lessonsLearned: z.string().nullable(),
});
export type Breach = z.infer<typeof BreachSchema>;

// ─── Report ──────────────────────────────────────────────────────────

export const ReportSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  engagementId: z.string().uuid().nullable(),
  kind: z.enum(['board', 'auditor', 'dpb', 'technical', 'gap_scan', 'evidence_pack', 'custom']),
  title: z.string(),
  storageUri: z.string(),
  content: z.record(z.string(), z.unknown()),
  libraryVersion: z.string(),
  generatedByAgent: z.string(),
  generatedAt: z.string().datetime(),
  reviewedBy: z.string().uuid().nullable(),
  reviewedAt: z.string().datetime().nullable(),
  reviewNotes: z.string().nullable(),
  status: z.enum(['draft', 'approved', 'published', 'archived']),
  approvedAt: z.string().datetime().nullable(),
  publishedAt: z.string().datetime().nullable(),
});
export type Report = z.infer<typeof ReportSchema>;
