import { UserRole } from './enums';

/**
 * Axiom Proof — central authorisation policy (W1).
 *
 * Before this module, RBAC was four inline string comparisons in
 * `services/bff/src/routes/v1.ts` and **zero** checks anywhere in `apps/web`:
 * every page rendered for every authenticated user, and
 * `tenant_users.approval_scopes` — a column defined in the very first
 * migration — was never read by any code.
 *
 * Scattered comparisons fail in a particular way: each site encodes a slightly
 * different opinion, nobody can enumerate who can do what, and the answer to
 * "can a viewer approve?" depends on which of four lists you happen to read.
 * This module is the single answer, and it is data rather than control flow so
 * the whole matrix can be tested exhaustively and rendered in the UI.
 *
 * Enforced in three places (W1):
 *   1. BFF middleware — the authoritative gate
 *   2. Web server components — render gating, so a user is not shown a button
 *      that will 403 (a UI concern, never the security boundary)
 *   3. RLS — already partly present in the database policies
 */

/** Every distinct thing a principal can attempt. */
export const Capability = {
  // Posture and reporting
  POSTURE_READ: 'posture.read',
  REPORT_READ: 'report.read',
  REPORT_GENERATE: 'report.generate',
  EVIDENCE_READ: 'evidence.read',
  EVIDENCE_EXPORT: 'evidence.export',
  LEDGER_READ: 'ledger.read',
  LEDGER_VERIFY: 'ledger.verify',

  // Assessment and planning
  ASSESSMENT_RUN: 'assessment.run',
  AGENT_INVOKE: 'agent.invoke',
  PLAN_READ: 'plan.read',
  PLAN_COMMENT: 'plan.comment',
  PLAN_CREATE: 'plan.create',

  // The approval chain — the capabilities that actually matter
  PLAN_APPROVE: 'plan.approve',
  PLAN_REJECT: 'plan.reject',
  PLAN_EXECUTE: 'plan.execute',

  /**
   * Decide what happens to a dispatch that was promised and never confirmed
   * (W5). The actions may be running on a client's estate, so releasing them
   * is an assertion that they are not — the same weight as releasing the
   * emergency stop, and held by the same roles.
   */
  EXECUTION_RECONCILE: 'execution.reconcile',

  // Emergency stop
  KILL_SWITCH_ENGAGE_TENANT: 'kill_switch.engage.tenant',
  KILL_SWITCH_ENGAGE_GLOBAL: 'kill_switch.engage.global',
  KILL_SWITCH_RELEASE_TENANT: 'kill_switch.release.tenant',
  KILL_SWITCH_RELEASE_GLOBAL: 'kill_switch.release.global',

  // Tenant administration
  ENGAGEMENT_CREATE: 'engagement.create',
  ESTATE_MANAGE: 'estate.manage',
  ONBOARDING_PREPARE: 'onboarding.prepare',
  ONBOARDING_REVIEW: 'onboarding.review',
  TENANT_CREATE: 'tenant.create',
  TENANT_SETTINGS_WRITE: 'tenant.settings.write',
  USER_MANAGE: 'user.manage',
  BILLING_MANAGE: 'billing.manage',

  // Cross-tenant surfaces
  MULTI_TENANT_READ: 'multi_tenant.read',
  WORKBENCH_ACCESS: 'workbench.access',
  PARTNER_PORTAL_ACCESS: 'partner_portal.access',
} as const;
export type Capability = (typeof Capability)[keyof typeof Capability];

/**
 * The capability matrix.
 *
 * Deliberately exhaustive and explicit: every role lists what it can do, and
 * nothing is inherited. Role hierarchies look economical and then quietly grant
 * something nobody intended three levels down — which is the same failure
 * shape as the environment OR-chains in W0.0.
 */
const MATRIX: Record<UserRole, readonly Capability[]> = {
  /**
   * Internal Axiom Minds operator. The only role that can stop the platform
   * for every tenant at once, because that authority is not a tenant's to hold
   * (SEC-4).
   */
  [UserRole.FOUNDER]: [
    Capability.POSTURE_READ,
    Capability.REPORT_READ,
    Capability.REPORT_GENERATE,
    Capability.EVIDENCE_READ,
    Capability.EVIDENCE_EXPORT,
    Capability.LEDGER_READ,
    Capability.LEDGER_VERIFY,
    Capability.ASSESSMENT_RUN,
    Capability.AGENT_INVOKE,
    Capability.PLAN_READ,
    Capability.PLAN_COMMENT,
    Capability.PLAN_CREATE,
    Capability.PLAN_APPROVE,
    Capability.PLAN_REJECT,
    Capability.PLAN_EXECUTE,
    Capability.KILL_SWITCH_ENGAGE_TENANT,
    Capability.KILL_SWITCH_ENGAGE_GLOBAL,
    Capability.KILL_SWITCH_RELEASE_TENANT,
    Capability.EXECUTION_RECONCILE,
    Capability.KILL_SWITCH_RELEASE_GLOBAL,
    Capability.ENGAGEMENT_CREATE,
    Capability.TENANT_CREATE,
    Capability.TENANT_SETTINGS_WRITE,
    Capability.ESTATE_MANAGE,
    Capability.USER_MANAGE,
    Capability.BILLING_MANAGE,
    Capability.MULTI_TENANT_READ,
    Capability.WORKBENCH_ACCESS,
    Capability.ONBOARDING_PREPARE,
  ],

  /**
   * Axiom Minds analyst: runs the agents and reviews what they produce, across
   * the client tenants they are assigned to.
   *
   * Everything here is about *producing* the work — running assessments,
   * invoking agents, drafting plans. Nothing here approves it. That omission
   * is the entire proposition: Axiom prepares the change and a human at the
   * client authorises it, so an analyst who could approve their own plan would
   * collapse the maker-checker property (BR-1) into a single party, and it
   * would be Axiom.
   *
   * Deliberately NOT `MULTI_TENANT_READ`. An analyst reaches several clients by
   * holding a `tenant_users` row in each one — ordinary membership, several
   * times over — and migration 0016 removed the blanket `is_axiom_internal`
   * bypass that used to make the employee flag itself a cross-client key.
   * `MULTI_TENANT_READ` is for surfaces that aggregate ACROSS tenants without
   * per-tenant membership, which is the founder's and the partner's position,
   * not an analyst's. The role says what they may do; membership says where.
   */
  [UserRole.AXIOM_ANALYST]: [
    Capability.POSTURE_READ,
    Capability.REPORT_READ,
    Capability.REPORT_GENERATE,
    Capability.EVIDENCE_READ,
    Capability.EVIDENCE_EXPORT,
    Capability.LEDGER_READ,
    Capability.LEDGER_VERIFY,
    Capability.ASSESSMENT_RUN,
    Capability.AGENT_INVOKE,
    Capability.PLAN_READ,
    Capability.PLAN_COMMENT,
    Capability.PLAN_CREATE,
    Capability.ENGAGEMENT_CREATE,
    // Stopping is safe and must never need an escalation: an analyst who set
    // an agent running has to be able to halt it. Releasing is NOT here —
    // resuming execution against a client estate is the tenant's decision or
    // the founder's, and the asymmetry is deliberate.
    Capability.KILL_SWITCH_ENGAGE_TENANT,
    Capability.WORKBENCH_ACCESS,
    Capability.ONBOARDING_PREPARE,
  ],

  /** Tenant owner: signed the contract. Full authority within their tenant. */
  [UserRole.OWNER]: [
    Capability.POSTURE_READ,
    Capability.REPORT_READ,
    Capability.REPORT_GENERATE,
    Capability.EVIDENCE_READ,
    Capability.EVIDENCE_EXPORT,
    Capability.LEDGER_READ,
    Capability.LEDGER_VERIFY,
    Capability.ASSESSMENT_RUN,
    Capability.AGENT_INVOKE,
    Capability.PLAN_READ,
    Capability.PLAN_COMMENT,
    Capability.PLAN_CREATE,
    Capability.PLAN_APPROVE,
    Capability.PLAN_REJECT,
    Capability.PLAN_EXECUTE,
    Capability.KILL_SWITCH_ENGAGE_TENANT,
    Capability.KILL_SWITCH_RELEASE_TENANT,
    Capability.EXECUTION_RECONCILE,
    Capability.ENGAGEMENT_CREATE,
    Capability.TENANT_CREATE,
    Capability.TENANT_SETTINGS_WRITE,
    Capability.ESTATE_MANAGE,
    Capability.USER_MANAGE,
    Capability.BILLING_MANAGE,
    Capability.ONBOARDING_REVIEW,
  ],

  /** Tenant admin: operations, but not commercial control. */
  [UserRole.ADMIN]: [
    Capability.POSTURE_READ,
    Capability.REPORT_READ,
    Capability.REPORT_GENERATE,
    Capability.EVIDENCE_READ,
    Capability.EVIDENCE_EXPORT,
    Capability.LEDGER_READ,
    Capability.LEDGER_VERIFY,
    Capability.ASSESSMENT_RUN,
    Capability.AGENT_INVOKE,
    Capability.PLAN_READ,
    Capability.PLAN_COMMENT,
    Capability.PLAN_CREATE,
    Capability.PLAN_APPROVE,
    Capability.PLAN_REJECT,
    Capability.PLAN_EXECUTE,
    Capability.KILL_SWITCH_ENGAGE_TENANT,
    Capability.ENGAGEMENT_CREATE,
    Capability.TENANT_SETTINGS_WRITE,
    Capability.ESTATE_MANAGE,
    Capability.USER_MANAGE,
    Capability.ONBOARDING_REVIEW,
  ],

  /**
   * Approver: exists to approve, and to do so within `approval_scopes`.
   * Cannot create the plan they approve — that separation is BR-1's
   * maker-checker property expressed in roles rather than in prose.
   */
  [UserRole.APPROVER]: [
    Capability.POSTURE_READ,
    Capability.REPORT_READ,
    Capability.EVIDENCE_READ,
    Capability.LEDGER_READ,
    Capability.LEDGER_VERIFY,
    Capability.PLAN_READ,
    Capability.PLAN_COMMENT,
    Capability.PLAN_APPROVE,
    Capability.PLAN_REJECT,
    Capability.KILL_SWITCH_ENGAGE_TENANT,
  ],

  /** Reviewer: reads and comments on agent output. Cannot approve. */
  [UserRole.REVIEWER]: [
    Capability.POSTURE_READ,
    Capability.REPORT_READ,
    Capability.EVIDENCE_READ,
    Capability.LEDGER_READ,
    Capability.LEDGER_VERIFY,
    Capability.ASSESSMENT_RUN,
    Capability.PLAN_READ,
    Capability.PLAN_COMMENT,
    Capability.ENGAGEMENT_CREATE,
  ],

  /** Viewer: read-only posture, reports, evidence. */
  [UserRole.VIEWER]: [
    Capability.POSTURE_READ,
    Capability.REPORT_READ,
    Capability.EVIDENCE_READ,
    Capability.LEDGER_READ,
    Capability.PLAN_READ,
  ],

  /** Channel partner: multi-client read plus branded export. */
  [UserRole.PARTNER]: [
    Capability.POSTURE_READ,
    Capability.REPORT_READ,
    Capability.REPORT_GENERATE,
    Capability.EVIDENCE_READ,
    Capability.EVIDENCE_EXPORT,
    Capability.PLAN_READ,
    Capability.MULTI_TENANT_READ,
    Capability.PARTNER_PORTAL_ACCESS,
  ],

  /**
   * Machine identity. Deliberately empty: an agent's authority comes from its
   * approval token and its workload identity, never from a seat in this
   * matrix. Karya executing is gated by the token, not by a role.
   */
  [UserRole.AGENT]: [],
};

/**
 * Capabilities that may be narrowed further by `tenant_users.approval_scopes`.
 *
 * The column has existed since migration 0001 and was never read. An approver
 * scoped to `data-deletion` should not be able to approve a cross-border
 * transfer change; that distinction is also what makes W6's standing approval
 * policies safe to build later.
 */
const SCOPE_NARROWED: ReadonlySet<Capability> = new Set([
  Capability.PLAN_APPROVE,
  Capability.PLAN_EXECUTE,
]);

export interface AuthorizationContext {
  role: UserRole;
  /** From `tenant_users.approval_scopes`. Empty means "not narrowed". */
  approvalScopes?: readonly string[];
  /**
   * The action class being approved, e.g. 'data-deletion'. Required when the
   * capability is scope-narrowed and the principal carries scopes.
   */
  actionClass?: string;
}

export type AuthorizationResult =
  | { allowed: true }
  | { allowed: false; reason: 'role_forbidden' | 'scope_forbidden'; message: string };

/**
 * The single authorisation decision point.
 *
 * Returns a structured refusal rather than a boolean so callers can render an
 * accurate message — "your approval scope does not cover this action class" is
 * a materially different thing to tell a user than "you cannot approve".
 */
export function authorize(capability: Capability, ctx: AuthorizationContext): AuthorizationResult {
  const granted = MATRIX[ctx.role];
  if (!granted) {
    return {
      allowed: false,
      reason: 'role_forbidden',
      message: `Unknown role '${ctx.role}'`,
    };
  }

  if (!granted.includes(capability)) {
    return {
      allowed: false,
      reason: 'role_forbidden',
      message: `Role '${ctx.role}' cannot ${capability}`,
    };
  }

  // An empty scope list means unrestricted, matching the column's default.
  const scopes = ctx.approvalScopes ?? [];
  if (SCOPE_NARROWED.has(capability) && scopes.length > 0) {
    if (!ctx.actionClass) {
      return {
        allowed: false,
        reason: 'scope_forbidden',
        message: `An action class is required to ${capability} under a scoped approval authority`,
      };
    }
    if (!scopes.includes(ctx.actionClass)) {
      return {
        allowed: false,
        reason: 'scope_forbidden',
        message: `Approval scope does not cover action class '${ctx.actionClass}'`,
      };
    }
  }

  return { allowed: true };
}

/** Boolean convenience for render gating, where the reason is not shown. */
export function can(capability: Capability, ctx: AuthorizationContext): boolean {
  return authorize(capability, ctx).allowed;
}

/** Everything a role can do. For UI rendering and for tests. */
export function capabilitiesFor(role: UserRole): readonly Capability[] {
  return MATRIX[role] ?? [];
}

/** Every role that holds a capability. Used to document the matrix. */
export function rolesWith(capability: Capability): UserRole[] {
  return (Object.keys(MATRIX) as UserRole[]).filter((r) => MATRIX[r].includes(capability));
}
