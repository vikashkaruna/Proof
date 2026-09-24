import { createMiddleware } from 'hono/factory';
import { isAuthBypassEnabled } from '@axiom/config';
import type { MfaService } from '../services/mfa.js';
import type { Variables } from '../types.js';
import { logger } from '../lib/logger.js';

/**
 * Login-time MFA enforcement (W1 · SEC-8).
 *
 * The plan requires MFA "at login for founder / owner / approver". Supabase
 * issues a session the moment a password is accepted, so "at login" cannot be
 * a property of the session — it has to be a separate fact, checked on every
 * request, that the second factor was actually seen.
 *
 * This middleware is that check, and it lives in the BFF because the BFF is
 * the authoritative gate. The web app's equivalent redirect is a usability
 * nicety: a caller holding a stolen password can skip the browser entirely and
 * call these endpoints directly, and must still be refused.
 *
 * Two refusals, deliberately distinct:
 *
 *   `mfa_enrolment_required`  you hold a role that needs a factor and have
 *                             none. Nothing but enrolment will fix it.
 *   `mfa_verification_required` you have a factor and have not used it on this
 *                             session, or the window has lapsed.
 *
 * Collapsing them would leave a user who has never enrolled staring at a code
 * prompt they cannot possibly satisfy.
 */

/**
 * Routes that stay reachable while quarantined.
 *
 * Only the MFA endpoints. Everything a quarantined user can legitimately do is
 * enrol a factor or satisfy a challenge, and both live under `/mfa`. Widening
 * this list is how a quarantine quietly stops being one, so it is deliberately
 * the smallest set that leaves the state escapable.
 */
const QUARANTINE_EXEMPT_PREFIXES = ['/v1/mfa/', '/v1/mfa'];

/**
 * Resolved once at module load from the single sanctioned switch, exactly as
 * `authMiddleware` does. Under the bypass the identity itself is synthetic and
 * has no factor to present, so enforcing MFA on it would only mean local E2E
 * runs cannot start.
 */
const authBypass = isAuthBypassEnabled();

export function requireSessionMfa(mfa: MfaService) {
  return createMiddleware<{ Variables: Variables }>(async (c, next) => {
    if (authBypass) return next();

    const path = c.req.path;
    if (QUARANTINE_EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) return next();

    const role = c.get('role');
    const tenantId = c.get('tenantId');

    // Tenantless routes (`/organizations/onboard`, `/user/tenants`) are exempt
    // from tenant resolution and so carry no role. There is no tenant policy to
    // read and no privileged tenant action to protect, so they pass — the same
    // reasoning that makes them exempt upstream.
    if (!role || !tenantId) return next();

    const required = await mfa.requiresLoginMfa({ tenantId, role });
    if (!required) return next();

    const user = c.get('user');

    if (!(await mfa.isEnrolled(user.id))) {
      logger.warn({ userId: user.id, tenantId, role }, 'MFA required but no factor enrolled');
      return c.json(
        {
          error: {
            code: 'mfa_enrolment_required',
            message:
              'Your role requires a second factor. Enrol an authenticator before continuing.',
            details: { enrolEndpoint: '/v1/mfa/enrol', role },
          },
        },
        403,
      );
    }

    const attestation = await mfa.sessionAttestation({
      userId: user.id,
      sessionId: c.get('sessionId'),
    });

    if (!attestation) {
      return c.json(
        {
          error: {
            code: 'mfa_verification_required',
            message: 'This session has not been verified with your second factor.',
            details: { challengeEndpoint: '/v1/mfa/challenge', purpose: 'login' },
          },
        },
        401,
      );
    }

    return next();
  });
}
