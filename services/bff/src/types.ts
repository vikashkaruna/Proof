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
};
