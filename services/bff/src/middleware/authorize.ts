import type { Context } from 'hono';
import { authorize as policyAuthorize, type Capability } from '@axiom/types';
import type { Variables } from '../types.js';
import { logger } from '../lib/logger.js';

/**
 * BFF authorisation helper (W1 · SEC-9).
 *
 * The BFF is the authoritative gate — the web app's render gating is a
 * usability nicety, not a security boundary. Every route that requires an
 * authority goes through here so there is exactly one place that decides, and
 * exactly one shape of refusal.
 *
 * Previously this was four inline string comparisons, each encoding its own
 * slightly different list, with no way to enumerate who could do what.
 */
export function requireCapability(
  c: Context<{ Variables: Variables }>,
  capability: Capability,
  options: { actionClass?: string; approvalScopes?: readonly string[] } = {},
): Response | null {
  const role = c.get('role');
  const result = policyAuthorize(capability, {
    role,
    approvalScopes: options.approvalScopes,
    actionClass: options.actionClass,
  });

  if (result.allowed) return null;

  logger.warn(
    {
      userId: c.get('user')?.id,
      tenantId: c.get('tenantId'),
      role,
      capability,
      reason: result.reason,
    },
    'authorization refused',
  );

  // `scope_forbidden` is a materially different thing to tell a user than
  // `role_forbidden`: one means "not you", the other means "not this action
  // class". Collapsing them makes a scoped approver's refusal unexplainable.
  return c.json({ error: { code: result.reason, message: result.message } }, 403);
}
