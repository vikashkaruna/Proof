/**
 * Enums shared between the database, the BFF, the agent runtime, and
 * the Next.js apps. These match the Postgres ENUM types declared in
 * infra/supabase/migrations/*.sql.
 */

export const UserRole = {
  OWNER: 'owner',
  ADMIN: 'admin',
  APPROVER: 'approver',
  REVIEWER: 'reviewer',
  VIEWER: 'viewer',
  AGENT: 'agent',
  PARTNER: 'partner',
  FOUNDER: 'founder',
  /**
   * Axiom Minds operator working across assigned client tenants: runs the
   * agents, reviews what they produce, and prepares plans. Deliberately
   * cannot approve on the client's behalf — the whole proposition is that a
   * human at the *client* authorises the change.
   */
  AXIOM_ANALYST: 'axiom_analyst',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const TenantTier = {
  FREE: 'free',
  ESSENTIAL: 'essential',
  GROWTH: 'growth',
  ENTERPRISE: 'enterprise',
} as const;
export type TenantTier = (typeof TenantTier)[keyof typeof TenantTier];

export const EngagementStatus = {
  INTAKE: 'intake',
  DISCOVERY: 'discovery',
  CLASSIFICATION: 'classification',
  ASSESSMENT: 'assessment',
  PLANNING: 'planning',
  REVIEW: 'review',
  DRY_RUN: 'dry_run',
  AWAITING_APPROVAL: 'awaiting_approval',
  EXECUTING: 'executing',
  VERIFYING: 'verifying',
  CLOSURE: 'closure',
  COMPLETED: 'completed',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
} as const;
export type EngagementStatus = (typeof EngagementStatus)[keyof typeof EngagementStatus];

export const FindingStatus = {
  OPEN: 'open',
  PLANNED: 'planned',
  IN_REMEDIATION: 'in_remediation',
  CLOSED: 'closed',
  ACCEPTED_RISK: 'accepted_risk',
} as const;
export type FindingStatus = (typeof FindingStatus)[keyof typeof FindingStatus];

export const ActionType = {
  POLICY_PUBLISH: 'policy.publish',
  POLICY_UPDATE: 'policy.update',
  NOTICE_UPDATE: 'notice.update',
  CONSENT_UPDATE: 'consent.update',
  DATA_MASK: 'data.mask',
  DATA_DELETE: 'data.delete',
  DATA_PORTABILITY_EXPORT: 'data.portability_export',
  DATA_RETENTION_PURGE: 'data.retention_purge',
  CONFIG_RBAC_UPDATE: 'config.rbac_update',
  CONFIG_MFA_ENFORCE: 'config.mfa_enforce',
  CONFIG_BACKUP_ENCRYPT: 'config.backup_encrypt',
  CONFIG_AUDIT_LOG_ENABLE: 'config.audit_log_enable',
  CONFIG_CONSENT_UI_UPDATE: 'config.consent_ui_update',
  DPO_APPOINT: 'dpo.appoint',
  DPA_EXECUTE: 'dpa.execute',
  DPO_CONTACT_PUBLISH: 'dpo.contact_publish',
  BREACH_PLAYBOOK_PUBLISH: 'breach.playbook_publish',
  TRAINING_RUN: 'training.run',
  REVIEW_ACCEPT_RISK: 'review.accept_risk',
  CONNECTOR_SCAN: 'connector.scan',
  CONNECTOR_CLASSIFY: 'connector.classify',
  CUSTOM: 'custom',
} as const;
export type ActionType = (typeof ActionType)[keyof typeof ActionType];

export const ActionRiskClass = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
} as const;
export type ActionRiskClass = (typeof ActionRiskClass)[keyof typeof ActionRiskClass];

export const ActionStatus = {
  DRAFT: 'draft',
  AWAITING_DRY_RUN: 'awaiting_dry_run',
  DRY_RUN_COMPLETE: 'dry_run_complete',
  AWAITING_APPROVAL: 'awaiting_approval',
  APPROVED: 'approved',
  EXECUTING: 'executing',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  ROLLED_BACK: 'rolled_back',
  SKIPPED: 'skipped',
} as const;
export type ActionStatus = (typeof ActionStatus)[keyof typeof ActionStatus];

export const PlanStatus = {
  DRAFT: 'draft',
  REVIEW: 'review',
  APPROVED: 'approved',
  EXECUTING: 'executing',
  COMPLETED: 'completed',
  PARTIAL_FAILURE: 'partial_failure',
  ROLLED_BACK: 'rolled_back',
  CANCELLED: 'cancelled',
} as const;
export type PlanStatus = (typeof PlanStatus)[keyof typeof PlanStatus];

export const ApprovalStatus = {
  ISSUED: 'issued',
  CONSUMED: 'consumed',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
  INVALID: 'invalid',
} as const;
export type ApprovalStatus = (typeof ApprovalStatus)[keyof typeof ApprovalStatus];

export const ActorType = {
  AGENT: 'agent',
  HUMAN: 'human',
  SYSTEM: 'system',
} as const;
export type ActorType = (typeof ActorType)[keyof typeof ActorType];

export const LedgerResult = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  ROLLED_BACK: 'rolled_back',
  SKIPPED: 'skipped',
  PENDING: 'pending',
} as const;
export type LedgerResult = (typeof LedgerResult)[keyof typeof LedgerResult];

export const LedgerActionType = {
  DISCOVERY_STARTED: 'discovery.started',
  DISCOVERY_BATCH_COMPLETED: 'discovery.batch.completed',
  DISCOVERY_TARGETED_COMPLETED: 'discovery.targeted.completed',
  DISCOVERY_DRIFT_DETECTED: 'discovery.drift_detected',
  CLASSIFICATION_STARTED: 'classification.started',
  CLASSIFICATION_BATCH_COMPLETED: 'classification.batch.completed',
  CLASSIFICATION_REVIEW_QUEUED: 'classification.review_queued',
  ASSESSMENT_STARTED: 'assessment.started',
  ASSESSMENT_SCORED: 'assessment.scored',
  ASSESSMENT_REPORT_GENERATED: 'assessment.report.generated',
  EVIDENCE_COLLECTED: 'evidence.collected',
  EVIDENCE_SEALED: 'evidence.sealed',
  EVIDENCE_LINKED: 'evidence.linked',
  PLAN_GENERATED: 'plan.generated',
  PLAN_DRY_RUN_COMPLETED: 'plan.dry_run.completed',
  PLAN_APPROVAL_REQUESTED: 'plan.approval_requested',
  APPROVAL_TOKEN_ISSUED: 'approval.token.issued',
  APPROVAL_TOKEN_USED: 'approval.token.used',
  APPROVAL_TOKEN_REVOKED: 'approval.token.revoked',
  APPROVAL_TOKEN_EXPIRED: 'approval.token.expired',
  APPROVAL_TOKEN_INVALID: 'approval.token.invalid',
  EXECUTION_STARTED: 'execution.started',
  EXECUTION_ACTION_STARTED: 'execution.action.started',
  EXECUTION_ACTION_SUCCEEDED: 'execution.action.succeeded',
  EXECUTION_ACTION_FAILED: 'execution.action.failed',
  EXECUTION_BATCH_COMPLETED: 'execution.batch.completed',
  EXECUTION_ROLLBACK_STARTED: 'execution.rollback.started',
  EXECUTION_ROLLBACK_COMPLETED: 'execution.rollback.completed',
  EXECUTION_KILL_SWITCH_ENGAGED: 'execution.kill_switch.engaged',
  // A release was previously recorded as an 'engaged' entry, so the audit
  // trail said the opposite of what happened. On a product whose proposition
  // is a tamper-evident ledger, that is not a cosmetic defect.
  EXECUTION_KILL_SWITCH_RELEASED: 'execution.kill_switch.released',
  EXECUTION_DISPATCH_RECONCILED: 'execution.dispatch.reconciled',
  VERIFICATION_STARTED: 'verification.started',
  VERIFICATION_PASSED: 'verification.passed',
  VERIFICATION_FAILED: 'verification.failed',
  ESTATE_CREATED: 'estate.created',
  ESTATE_UPDATED: 'estate.updated',
  ESTATE_SYSTEM_CREATED: 'estate.system.created',
  ESTATE_SYSTEM_UPDATED: 'estate.system.updated',
  ENGAGEMENT_ESTATE_ASSIGNED: 'engagement.estate.assigned',
  USER_LOGIN: 'user.login',
  USER_LOGOUT: 'user.logout',
  USER_ROLE_CHANGED: 'user.role.changed',
  // MFA (W1 · SEC-8). Enrolment and every challenge outcome are ledgered,
  // not merely logged: FR-7.3 requires "approver identity, timestamp, scope
  // recorded", and the step-up that binds a fresh authentication to a specific
  // approval is part of that identity claim. A reviewer must be able to see
  // that the approver re-authenticated, and see it in the same tamper-evident
  // chain as the approval itself.
  MFA_FACTOR_ENROLLED: 'mfa.factor.enrolled',
  MFA_FACTOR_ACTIVATED: 'mfa.factor.activated',
  MFA_FACTOR_REVOKED: 'mfa.factor.revoked',
  MFA_CHALLENGE_ISSUED: 'mfa.challenge.issued',
  MFA_CHALLENGE_SATISFIED: 'mfa.challenge.satisfied',
  // Failures are recorded too. A burst of them against one approver is the
  // signal that someone holds their password and is working on the factor.
  MFA_CHALLENGE_FAILED: 'mfa.challenge.failed',
  MFA_RECOVERY_CODE_CONSUMED: 'mfa.recovery_code.consumed',
  TENANT_CREATED: 'tenant.created',
  TENANT_UPDATED: 'tenant.updated',
  PLAN_PUBLISHED: 'plan.published',
  CONTROL_PUBLISHED: 'control.published',
  DSAR_RECEIVED: 'dsar.received',
  DSAR_VERIFIED: 'dsar.verified',
  DSAR_FULFILLED: 'dsar.fulfilled',
  DSAR_REJECTED: 'dsar.rejected',
  BREACH_DETECTED: 'breach.detected',
  BREACH_NOTIFIED_DPB: 'breach.notified.dpb',
  BREACH_NOTIFIED_PRINCIPALS: 'breach.notified.principals',
  REPORT_GENERATED: 'report.generated',
  REPORT_EXPORTED: 'report.exported',
  EVIDENCE_PACK_EXPORTED: 'evidence_pack.exported',
} as const;
export type LedgerActionType = (typeof LedgerActionType)[keyof typeof LedgerActionType];

export const EvidenceType = {
  DOCUMENT: 'document',
  CONFIG: 'config',
  SCREENSHOT: 'screenshot',
  LOG: 'log',
  ATTESTATION: 'attestation',
  INTERVIEW: 'interview',
  INVENTORY: 'inventory',
  REPORT: 'report',
} as const;
export type EvidenceType = (typeof EvidenceType)[keyof typeof EvidenceType];

export const ControlDomain = {
  GOV: 'GOV',
  CNS: 'CNS',
  DAT: 'DAT',
  RCD: 'RCD',
  BRCH: 'BRCH',
  XBR: 'XBR',
  CHD: 'CHD',
  SDF: 'SDF',
  SEC: 'SEC',
  RTN: 'RTN',
  DPF: 'DPF',
  AUD: 'AUD',
  DPIA: 'DPIA',
} as const;
export type ControlDomain = (typeof ControlDomain)[keyof typeof ControlDomain];

export const ControlSeverity = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
} as const;
export type ControlSeverity = (typeof ControlSeverity)[keyof typeof ControlSeverity];

export const AgentName = {
  DRISHTI: 'drishti',
  VIBHAAG: 'vibhaag',
  PARIKSHAN: 'parikshan',
  SAAKSHI: 'saakshi',
  SUDHAAR: 'sudhaar',
  KARYA: 'karya',
  LEKHA: 'lekha',
  NAZAR: 'nazar',
  PRATIVEDAN: 'prativedan',
  SANKET: 'sanket',
} as const;
export type AgentName = (typeof AgentName)[keyof typeof AgentName];

export const ALL_AGENTS: AgentName[] = [
  'drishti',
  'vibhaag',
  'parikshan',
  'saakshi',
  'sudhaar',
  'karya',
  'lekha',
  'nazar',
  'prativedan',
  'sanket',
];
