import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateTotp } from '@axiom/mfa';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import { createMfaService, type MfaService } from './mfa.js';

/**
 * W1 · R-08 — account-wide MFA budgets.
 *
 * `mfa_challenges.max_attempts` bounds guesses against ONE challenge, and the
 * review found the way around it: open another. Five guesses per challenge
 * with unlimited challenges is unlimited guesses, and a six-digit code does
 * not survive that.
 *
 * These budgets are per account and survive opening a fresh challenge.
 */

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://local.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'a'.repeat(40);
  process.env.SUPABASE_SERVICE_KEY = 'b'.repeat(40);
  process.env.APPROVAL_SIGNING_KEY = 'k'.repeat(48);
});

const KEY = 'budget-test-encryption-key-at-least-32-chars';
const USER = '00000000-0000-4000-8000-0000000000aa';
const OTHER_USER = '00000000-0000-4000-8000-0000000000bb';
const TENANT = '11111111-1111-4111-8111-111111111111';
const T0 = Date.UTC(2026, 8, 20, 12, 0, 0);

let db: FakeDb;
let mfa: MfaService;

beforeEach(() => {
  db = createFakeDb({});
  mfa = createMfaService(() => db.client as never, { encryptionKey: KEY });
});

async function enrol(userId = USER) {
  const begun = await mfa.beginTotpEnrolment({ userId, accountName: 'a@example.com' });
  const activated = await mfa.activateTotpEnrolment({
    userId,
    code: generateTotp(begun.secret, T0),
    atMs: T0,
  });
  if (!activated.ok) throw new Error('enrolment failed');
  return begun;
}

const openChallenge = (userId = USER) =>
  mfa.issueChallenge({ userId, tenantId: TENANT, purpose: 'login' });

describe('challenge issuance budget', () => {
  it('stops an account opening challenges without limit', async () => {
    await enrol();
    let refusal: Awaited<ReturnType<typeof openChallenge>> | null = null;
    for (let i = 0; i < 40; i++) {
      const issued = await openChallenge();
      if (!issued.ok && issued.reason === 'rate_limited') {
        refusal = issued;
        break;
      }
    }
    expect(refusal, 'issuance should eventually be refused').toBeTruthy();
    expect(refusal).toMatchObject({ ok: false, reason: 'rate_limited' });
  });

  it('tells the caller when to come back', async () => {
    await enrol();
    for (let i = 0; i < 40; i++) {
      const issued = await openChallenge();
      if (!issued.ok && issued.reason === 'rate_limited') {
        expect(issued.retryAfterSeconds).toBeGreaterThan(0);
        return;
      }
    }
    throw new Error('never hit the budget');
  });

  it('budgets each account separately', async () => {
    await enrol(USER);
    await enrol(OTHER_USER);
    for (let i = 0; i < 40; i++) await openChallenge(USER);

    // One account exhausting its budget must not lock everybody out.
    const other = await openChallenge(OTHER_USER);
    expect(other.ok).toBe(true);
  });

  it('refuses when the budget cannot be read', async () => {
    await enrol();
    db.failNextRpc('take_rate_limit');
    const issued = await openChallenge();
    // Fail closed: a limiter we cannot read is not permission to keep going.
    expect(issued).toMatchObject({ ok: false, reason: 'rate_limited' });
  });
});

describe('verification budget', () => {
  it('survives opening a fresh challenge — the escape the review found', async () => {
    await enrol();
    let refused = false;

    // Burn guesses across MANY challenges, one wrong guess each, so the
    // per-challenge counter never comes close to its limit.
    for (let round = 0; round < 40 && !refused; round++) {
      const issued = await openChallenge();
      if (!issued.ok) {
        // Issuance budget bit first; that also closes the hole.
        refused = issued.reason === 'rate_limited';
        break;
      }
      const result = await mfa.verifyChallenge({
        challengeId: issued.challengeId,
        userId: USER,
        code: '000000',
        atMs: T0,
      });
      if (!result.ok && result.reason === 'rate_limited') refused = true;
    }

    expect(refused, 'a fresh challenge must not reset the account guess budget').toBe(true);
  });

  it('refuses a verification when the budget cannot be read', async () => {
    await enrol();
    const issued = await openChallenge();
    if (!issued.ok) throw new Error('challenge not issued');

    db.failNextRpc('take_rate_limit');
    const result = await mfa.verifyChallenge({
      challengeId: issued.challengeId,
      userId: USER,
      code: '000000',
      atMs: T0,
    });
    expect(result).toMatchObject({ ok: false, reason: 'rate_limited' });
  });

  it('charges the budget before the challenge is even looked up', async () => {
    // Otherwise guessing against a non-existent challenge id is free, and the
    // attacker simply never names a real one.
    await enrol();
    db.failNextRpc('take_rate_limit');
    const result = await mfa.verifyChallenge({
      challengeId: '00000000-0000-4000-8000-00000000dead',
      userId: USER,
      code: '000000',
      atMs: T0,
    });
    expect(result).toMatchObject({ ok: false, reason: 'rate_limited' });
  });
});
