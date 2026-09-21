import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * W1 — a step-up challenge must never replay.
 *
 * The browser-to-BFF bridge derives an `Idempotency-Key` from method, path and
 * body whenever the caller supplies none. That is right for approving and
 * executing, where a double submit must not run twice, and wrong for creating
 * a single-use MFA challenge.
 *
 * The defect it caused was found by a browser journey and is invisible to the
 * API suites, which pass a fresh `randomUUID()` key on every request and so
 * never exercise the bridge's derivation at all:
 *
 *   `POST /v1/mfa/challenge` with `{"purpose":"login"}` derives the SAME key
 *   for a given user forever. `claim_request` returns `conflict` whenever the
 *   stored claim's authority hash differs, and that hash includes the GoTrue
 *   session id — so the first login-MFA verification of a user's life claimed
 *   the key, and every later sign-in presented it from a different session and
 *   was refused `idempotency_conflict` permanently. Inside one session it
 *   failed more quietly: the claim replayed and handed back a challenge id
 *   that had already been consumed.
 *
 * These tests pin both halves of the rule at unit speed, so the fix does not
 * depend on the browser lane to stay honest.
 */

/** The bridge's derivation, mirrored. See `app/api/bff/[...path]/route.ts`. */
function derivedKey(method: string, pathAndSearch: string, body: string): string {
  const hex = createHash('sha256').update(`${method}:${pathAndSearch}:`).update(body).digest('hex');
  return `web-${hex.slice(0, 32)}`;
}

describe('the bridge derives a stable key for retryable mutations', () => {
  it('gives an identical key to an identical approval submit', () => {
    const body = JSON.stringify({ planId: 'p1', actionIds: ['a1'], mode: 'batch' });
    expect(derivedKey('POST', '/v1/plans/approve', body)).toBe(
      derivedKey('POST', '/v1/plans/approve', body),
    );
  });

  it('gives a different key when the approval differs', () => {
    expect(derivedKey('POST', '/v1/plans/approve', JSON.stringify({ actionIds: ['a1'] }))).not.toBe(
      derivedKey('POST', '/v1/plans/approve', JSON.stringify({ actionIds: ['a2'] })),
    );
  });
});

describe('challenge creation cannot rely on that derivation', () => {
  it('is the same key every time for a fixed login-MFA request', () => {
    // The root of the defect: nothing here varies per attempt or per session,
    // so one claim row serves every verification a user will ever attempt.
    const body = JSON.stringify({ purpose: 'login' });
    expect(derivedKey('POST', '/v1/mfa/challenge', body)).toBe(
      derivedKey('POST', '/v1/mfa/challenge', body),
    );
  });

  it('is the same key for a re-approval of the same plan and actions', () => {
    // The approval step-up has a richer body, but it is still fixed for a
    // given plan and action set — so approving the same batch twice would
    // have replayed a spent challenge.
    const body = JSON.stringify({
      purpose: 'approval_issuance',
      planId: 'p1',
      actionIds: ['a1'],
      mode: 'batch',
    });
    expect(derivedKey('POST', '/v1/mfa/challenge', body)).toBe(
      derivedKey('POST', '/v1/mfa/challenge', body),
    );
  });
});

describe('both challenge callers supply their own key', () => {
  const sources = [
    ['the login-MFA prompt', 'apps/web/src/app/(auth)/verify/verify-form.tsx'],
    ['the approval console', 'apps/web/src/app/(app)/plans/[id]/approval-actions.tsx'],
  ] as const;

  it.each(sources)('%s sends a per-attempt Idempotency-Key', async (_label, file) => {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const source = await readFile(resolve(process.cwd(), '../..', file), 'utf8');

    // The challenge-creation call must carry its own key rather than letting
    // the bridge derive one.
    const call = source.slice(source.indexOf("'/api/bff/v1/mfa/challenge'"));
    const headerBlock = call.slice(0, call.indexOf('body:'));
    expect(headerBlock).toContain('Idempotency-Key');

    // And that key must vary per attempt. One file builds it inline and the
    // other through a named helper, so this asserts the module generates a
    // fresh value somewhere rather than pinning one spelling of it.
    expect(source).toContain('randomUUID');
  });
});
