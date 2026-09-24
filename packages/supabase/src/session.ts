/**
 * Reading the GoTrue session identifier out of an access token.
 *
 * `session_id` is a REQUIRED claim in a Supabase auth JWT, and it is the only
 * identifier available to us with the right lifetime: the access token itself
 * rotates roughly hourly, while the session id is stable for the life of the
 * session and disappears when it ends.
 *
 * That distinction matters for MFA (W1 · SEC-8). An attestation keyed on the
 * access token would silently evaporate at the first refresh, which presents
 * as "users are asked for a code every hour" — and the usual fix for that
 * symptom is to weaken the check rather than to key it correctly.
 *
 * The payload is decoded WITHOUT verifying the signature, so this must only
 * ever be called on a token that has already been validated — in the BFF,
 * after `auth.getUser()` has accepted it; in the web app, on the session the
 * SSR client itself established. It reads an identifier out of a token we have
 * already decided to trust; it does not decide to trust it.
 */
export function sessionIdFromAccessToken(accessToken: string): string | null {
  const segments = accessToken.split('.');
  if (segments.length !== 3) return null;

  const payload = segments[1];
  if (!payload) return null;

  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const claims = JSON.parse(json) as { session_id?: unknown };
    return typeof claims.session_id === 'string' && claims.session_id.length > 0
      ? claims.session_id
      : null;
  } catch {
    // A token we cannot parse yields no session id, and every caller treats a
    // null as "not attested" — so a malformed token fails closed.
    return null;
  }
}
