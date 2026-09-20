import { describe, it, expect } from 'vitest';
import { sessionIdFromAccessToken } from './session';

/**
 * W1 · SEC-8 — reading the GoTrue session id out of an access token.
 *
 * Every caller treats a null as "not attested", so each malformed case here is
 * a fail-closed path: a token we cannot parse must not silently resolve to
 * some other session's attestation, and must not throw into a handler that
 * would then 500 on an otherwise valid request.
 *
 * Added under R-11: `@axiom/supabase` ran `--passWithNoTests` and had none, so
 * this module shipped with no coverage at all.
 */

function token(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.signature-not-verified`;
}

describe('sessionIdFromAccessToken', () => {
  it('reads the session_id claim', () => {
    expect(sessionIdFromAccessToken(token({ sub: 'u1', session_id: 'sess-abc' }))).toBe('sess-abc');
  });

  it('survives payloads carrying non-ASCII, which base64url must round-trip', () => {
    expect(sessionIdFromAccessToken(token({ session_id: 'sess-abc', name: 'अक्षय' }))).toBe(
      'sess-abc',
    );
  });

  it.each([
    ['an empty string', ''],
    ['a token with too few segments', 'header.payload'],
    ['a token with too many segments', 'a.b.c.d'],
    ['an unparseable payload', 'aGVhZGVy.bm90LWpzb24.sig'],
  ])('returns null for %s', (_label, value) => {
    expect(sessionIdFromAccessToken(value)).toBeNull();
  });

  it.each([
    ['a missing claim', {}],
    ['a non-string claim', { session_id: 12345 }],
    ['an empty claim', { session_id: '' }],
    ['a null claim', { session_id: null }],
  ])('returns null for %s rather than a falsy id', (_label, payload) => {
    // An empty string would compare equal to the empty sessionId the BFF sets
    // under the E2E bypass, so "absent" has to be null and not ''.
    expect(sessionIdFromAccessToken(token(payload))).toBeNull();
  });

  it('never throws, whatever it is handed', () => {
    for (const value of ['...', 'a'.repeat(5000), '..', 'x.y.z']) {
      expect(() => sessionIdFromAccessToken(value)).not.toThrow();
    }
  });
});
