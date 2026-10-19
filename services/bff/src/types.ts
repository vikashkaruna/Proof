import type { User } from '@supabase/supabase-js';
import type { UserRole } from '@axiom/types';

export type Variables = {
  user: User;
  token: string;
  tenantId: string;
  role: UserRole;
  /**
   * From `tenant_users.approval_scopes` — a column defined in migration 0001
   * and never read by any code until W1. An approver may be scoped to specific
   * action classes, so that authority to approve a data-deletion does not
   * imply authority to approve a cross-border transfer change.
   *
   * Empty means unrestricted, matching the column default.
   */
  approvalScopes: readonly string[];
  idempotencyKey: string;
  /** Verified 0017 claim metadata, assigned only after the claim RPC admits work. */
  /** New exact onboarding only: nonclaimed generic outcome permits SQL readback, never creation. */
  onboardingReadbackOnly?: true;
  requestClaim?: { id: string; key: string; requestSha256: string; authoritySha256: string };
  /**
   * GoTrue's `session_id` claim (W1 · SEC-8). What a login MFA attestation is
   * bound to — stable across access-token refresh, gone when the session ends.
   * Empty when it could not be read, which every consumer treats as
   * "not attested".
   */
  sessionId: string;
  /** Set by requireCurrentSession; absent only under the auth bypass. */
  sessionAccess?: import('./services/mfa.js').SessionAccess;
};
