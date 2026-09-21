import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateTotp } from '@axiom/mfa';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import { BASE_ENV } from '../test/harness.js';
import {
  approvalBindingSha256,
  createMfaService,
  factorBindingSha256,
  type MfaService,
} from './mfa.js';

/**
 * W1 · SEC-8 — adversarial suite for MFA.
 *
 * `@axiom/mfa` already proves the cryptography against RFC 6238's own test
 * vectors. Nothing here re-tests that. These are the questions the RFC does
 * not answer, and where implementations usually fail:
 *
 *   · can a code be presented twice?
 *   · can a challenge satisfied for one approval authorise another?
 *   · can one satisfied challenge authorise two approvals?
 *   · can one user satisfy another's challenge?
 *   · can a caller spend more guesses than the challenge allows?
 *   · can an attacker with a session shed MFA by revoking and re-enrolling?
 *
 * Every case is written against the behaviour we want, so each one goes red if
 * the corresponding defence is removed.
 */

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));

// `mfa.ts` calls `loadEnv()` at module scope, so the environment has to exist
// before the import is evaluated.
vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://local.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'a'.repeat(40);
  process.env.SUPABASE_SERVICE_KEY = 'b'.repeat(40);
  process.env.APPROVAL_SIGNING_KEY = 'k'.repeat(48);
});

const KEY = 'unit-test-encryption-key-at-least-32-chars';
const USER = '00000000-0000-4000-8000-0000000000aa';
const OTHER_USER = '00000000-0000-4000-8000-0000000000bb';
const TENANT = '11111111-1111-4111-8111-111111111111';
const PLAN = '22222222-2222-4222-8222-222222222222';
const ACTION_A = '33333333-3333-4333-8333-33333333000a';
const ACTION_B = '33333333-3333-4333-8333-33333333000b';

/** A fixed instant, so a generated code and its verification share a step. */
const T0 = Date.UTC(2026, 8, 20, 12, 0, 0);
const STEP = 30_000;

let db: FakeDb;
let mfa: MfaService;

beforeEach(() => {
  db = createFakeDb({ user_mfa_factors: [], mfa_challenges: [] });
  mfa = createMfaService(() => db.client as never, { encryptionKey: KEY });
});

/** Enrol and activate, returning the secret so a test can mint valid codes. */
async function enrol(userId = USER, atMs = T0) {
  const begun = await mfa.beginTotpEnrolment({ userId, accountName: 'approver@example.com' });
  const result = await mfa.activateTotpEnrolment({
    userId,
    code: generateTotp(begun.secret, atMs),
    atMs,
  });
  if (!result.ok) throw new Error(`enrolment failed: ${result.reason}`);
  return { ...begun, recoveryCodes: result.recoveryCodes };
}

const approvalBinding = (actionIds: string[] = [ACTION_A, ACTION_B], mode = 'batch') =>
  approvalBindingSha256({ planId: PLAN, actionIds, mode });

async function satisfiedApprovalChallenge(
  opts: {
    userId?: string;
    actionIds?: string[];
    atMs?: number;
  } = {},
) {
  const userId = opts.userId ?? USER;
  const atMs = opts.atMs ?? T0;
  const issued = await mfa.issueChallenge({
    userId,
    tenantId: TENANT,
    purpose: 'approval_issuance',
    boundResourceRef: PLAN,
    boundPayloadSha256: approvalBinding(opts.actionIds),
  });
  if (!issued.ok) throw new Error('challenge not issued');
  return issued;
}

// ─── The binding ──────────────────────────────────────────────────────────

describe('approvalBindingSha256', () => {
  it('is independent of action order — approving {A,B} is approving {B,A}', () => {
    expect(approvalBinding([ACTION_A, ACTION_B])).toBe(approvalBinding([ACTION_B, ACTION_A]));
  });

  it('changes when the action set changes', () => {
    expect(approvalBinding([ACTION_A])).not.toBe(approvalBinding([ACTION_A, ACTION_B]));
  });

  it('changes when the plan is revised under it', () => {
    // R-08: the binding said "this plan, these actions" and said nothing about
    // WHICH revision. A plan edited between satisfying the challenge and
    // issuing the approval still matched, so the human approved version 1 and
    // version 2 executed.
    const v1 = approvalBindingSha256({
      planId: PLAN,
      actionIds: [ACTION_A],
      mode: 'batch',
      planVersion: 1,
    });
    const v2 = approvalBindingSha256({
      planId: PLAN,
      actionIds: [ACTION_A],
      mode: 'batch',
      planVersion: 2,
    });
    expect(v1).not.toBe(v2);
  });

  it('changes when the mode changes — batch and individual are different consents', () => {
    expect(approvalBinding([ACTION_A], 'batch')).not.toBe(
      approvalBinding([ACTION_A], 'individual'),
    );
  });
});

// ─── Enrolment ────────────────────────────────────────────────────────────

describe('enrolment', () => {
  it('activates on a valid code and issues recovery codes', async () => {
    const { recoveryCodes } = await enrol();
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    expect(await mfa.isEnrolled(USER)).toBe(true);
  });

  it('never stores the TOTP secret in the clear', async () => {
    const { secret } = await enrol();
    const stored = db.rows('user_mfa_factors').find((r) => r.factor_type === 'totp');
    expect(stored?.secret_encrypted).toBeTruthy();
    expect(String(stored?.secret_encrypted)).not.toContain(secret);
  });

  it('refuses a wrong code and leaves the factor pending', async () => {
    const begun = await mfa.beginTotpEnrolment({ userId: USER, accountName: 'a@example.com' });
    const wrong = generateTotp(begun.secret, T0 + 10 * STEP);
    const result = await mfa.activateTotpEnrolment({ userId: USER, code: wrong, atMs: T0 });
    expect(result).toMatchObject({ ok: false, reason: 'code_rejected' });
    expect(await mfa.isEnrolled(USER)).toBe(false);
  });

  it('burns the activation counter, so the enrolment code is not replayable', async () => {
    const { secret } = await enrol();
    const issued = await satisfiedApprovalChallenge();
    // The very code that completed enrolment, presented again in the same step.
    const result = await mfa.verifyChallenge({
      challengeId: issued.challengeId,
      userId: USER,
      code: generateTotp(secret, T0),
      atMs: T0,
    });
    expect(result).toMatchObject({ ok: false, reason: 'code_rejected', detail: 'replayed' });
  });

  it('discards an abandoned enrolment rather than leaving two live secrets', async () => {
    const first = await mfa.beginTotpEnrolment({ userId: USER, accountName: 'a@example.com' });
    await mfa.beginTotpEnrolment({ userId: USER, accountName: 'a@example.com' });
    const result = await mfa.activateTotpEnrolment({
      userId: USER,
      code: generateTotp(first.secret, T0),
      atMs: T0,
    });
    expect(result.ok).toBe(false);
    expect(db.rows('user_mfa_factors').filter((r) => r.status === 'pending')).toHaveLength(1);
  });
});

// ─── Challenge verification ───────────────────────────────────────────────

describe('verifyChallenge', () => {
  it('accepts a valid TOTP code', async () => {
    const { secret } = await enrol();
    const issued = await satisfiedApprovalChallenge();
    const result = await mfa.verifyChallenge({
      challengeId: issued.challengeId,
      userId: USER,
      code: generateTotp(secret, T0 + STEP),
      atMs: T0 + STEP,
    });
    expect(result).toMatchObject({ ok: true, satisfiedWith: 'totp' });
  });

  it('refuses a code replayed against a second challenge in the same step', async () => {
    const { secret } = await enrol();
    const code = generateTotp(secret, T0 + STEP);

    const first = await satisfiedApprovalChallenge();
    expect(
      await mfa.verifyChallenge({
        challengeId: first.challengeId,
        userId: USER,
        code,
        atMs: T0 + STEP,
      }),
    ).toMatchObject({ ok: true });

    // Same code, fresh challenge — the attacker who observed it in transit.
    const second = await satisfiedApprovalChallenge();
    expect(
      await mfa.verifyChallenge({
        challengeId: second.challengeId,
        userId: USER,
        code,
        atMs: T0 + STEP,
      }),
    ).toMatchObject({ ok: false, reason: 'code_rejected', detail: 'replayed' });
  });

  it('lets only one of two simultaneous presentations of the same code succeed', async () => {
    // The sequential replay above is caught by the library's own counter
    // check, because by then the factor row already carries the used counter.
    // This is the case only the conditional claim catches: two requests that
    // both read the counter before either writes it — an attacker replaying an
    // intercepted code in parallel with the legitimate user's own submission.
    const { secret } = await enrol();
    const code = generateTotp(secret, T0 + STEP);
    const first = await satisfiedApprovalChallenge();
    const second = await satisfiedApprovalChallenge();

    const results = await Promise.all([
      mfa.verifyChallenge({
        challengeId: first.challengeId,
        userId: USER,
        code,
        atMs: T0 + STEP,
      }),
      mfa.verifyChallenge({
        challengeId: second.challengeId,
        userId: USER,
        code,
        atMs: T0 + STEP,
      }),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("will not let one user satisfy another user's challenge", async () => {
    await enrol(USER);
    const victim = await satisfiedApprovalChallenge({ userId: USER });
    const attacker = await enrol(OTHER_USER, T0 + 5 * STEP);

    const result = await mfa.verifyChallenge({
      challengeId: victim.challengeId,
      userId: OTHER_USER,
      code: generateTotp(attacker.secret, T0 + 6 * STEP),
      atMs: T0 + 6 * STEP,
    });
    expect(result).toMatchObject({ ok: false, reason: 'challenge_not_found' });
  });

  it('stops accepting guesses once max_attempts is spent', async () => {
    const { secret } = await enrol();
    const issued = await satisfiedApprovalChallenge();

    for (let i = 0; i < issued.maxAttempts; i++) {
      const result = await mfa.verifyChallenge({
        challengeId: issued.challengeId,
        userId: USER,
        code: '000000',
        atMs: T0 + STEP,
      });
      expect(result.ok).toBe(false);
    }

    // The correct code, after the budget is gone.
    const result = await mfa.verifyChallenge({
      challengeId: issued.challengeId,
      userId: USER,
      code: generateTotp(secret, T0 + STEP),
      atMs: T0 + STEP,
    });
    expect(result).toMatchObject({ ok: false, reason: 'attempts_exhausted' });
  });

  it('charges an attempt even when the code is wrong, so parallel guessing cannot be free', async () => {
    await enrol();
    const issued = await satisfiedApprovalChallenge();
    await mfa.verifyChallenge({
      challengeId: issued.challengeId,
      userId: USER,
      code: '000000',
      atMs: T0,
    });
    const row = db.rows('mfa_challenges').find((r) => r.id === issued.challengeId);
    expect(row?.attempts).toBe(1);
  });

  it('refuses an expired challenge', async () => {
    const { secret } = await enrol();
    const issued = await satisfiedApprovalChallenge();
    const row = db.rows('mfa_challenges').find((r) => r.id === issued.challengeId)!;
    row.expires_at = new Date(Date.now() - 1000).toISOString();

    const result = await mfa.verifyChallenge({
      challengeId: issued.challengeId,
      userId: USER,
      code: generateTotp(secret, T0),
      atMs: T0,
    });
    expect(result).toMatchObject({ ok: false, reason: 'challenge_expired' });
  });

  it('accepts a recovery code once and never again', async () => {
    const { recoveryCodes } = await enrol();
    const code = recoveryCodes[0]!;

    const first = await satisfiedApprovalChallenge();
    expect(
      await mfa.verifyChallenge({ challengeId: first.challengeId, userId: USER, code }),
    ).toMatchObject({ ok: true, satisfiedWith: 'recovery_code' });

    const second = await satisfiedApprovalChallenge();
    expect(
      await mfa.verifyChallenge({ challengeId: second.challengeId, userId: USER, code }),
    ).toMatchObject({ ok: false, reason: 'code_rejected' });

    expect((await mfa.status(USER)).recoveryCodesRemaining).toBe(9);
  });
});

// ─── The step-up itself ───────────────────────────────────────────────────

describe('consumeChallenge — the approval step-up', () => {
  async function satisfied(actionIds?: string[]) {
    const { secret } = await enrol();
    const issued = await satisfiedApprovalChallenge({ actionIds });
    await mfa.verifyChallenge({
      challengeId: issued.challengeId,
      userId: USER,
      code: generateTotp(secret, T0 + STEP),
      atMs: T0 + STEP,
    });
    return issued;
  }

  const consume = (challengeId: string | null | undefined, actionIds?: string[]) =>
    mfa.consumeChallenge({
      challengeId,
      userId: USER,
      purpose: 'approval_issuance',
      boundResourceRef: PLAN,
      boundPayloadSha256: approvalBinding(actionIds),
    });

  it('spends a satisfied, correctly bound challenge', async () => {
    const issued = await satisfied();
    expect(await consume(issued.challengeId)).toMatchObject({ ok: true });
  });

  it('refuses a missing challenge id rather than defaulting to permitted', async () => {
    expect(await consume(undefined)).toMatchObject({ ok: false, reason: 'challenge_required' });
    expect(await consume(null)).toMatchObject({ ok: false, reason: 'challenge_required' });
  });

  it('authorises exactly one approval — a second attempt is refused', async () => {
    const issued = await satisfied();
    expect(await consume(issued.challengeId)).toMatchObject({ ok: true });
    expect(await consume(issued.challengeId)).toMatchObject({
      ok: false,
      reason: 'challenge_already_consumed',
    });
  });

  it('lets exactly one of two concurrent approvals win the race', async () => {
    const issued = await satisfied();
    const [a, b] = await Promise.all([consume(issued.challengeId), consume(issued.challengeId)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('refuses a challenge satisfied for a different action set', async () => {
    // Satisfied for {A, B}; presented against {A} alone.
    const issued = await satisfied([ACTION_A, ACTION_B]);
    expect(await consume(issued.challengeId, [ACTION_A])).toMatchObject({
      ok: false,
      reason: 'binding_mismatch',
    });
  });

  it('refuses a challenge that was never satisfied', async () => {
    await enrol();
    const issued = await satisfiedApprovalChallenge();
    expect(await consume(issued.challengeId)).toMatchObject({
      ok: false,
      reason: 'challenge_not_satisfied',
    });
  });

  it('refuses a challenge raised for a different purpose', async () => {
    const { secret } = await enrol();
    const issued = await mfa.issueChallenge({
      userId: USER,
      tenantId: TENANT,
      purpose: 'login',
      boundResourceRef: PLAN,
      boundPayloadSha256: approvalBinding(),
    });
    if (!issued.ok) throw new Error('not issued');
    await mfa.verifyChallenge({
      challengeId: issued.challengeId,
      userId: USER,
      code: generateTotp(secret, T0 + STEP),
      atMs: T0 + STEP,
    });
    expect(await consume(issued.challengeId)).toMatchObject({
      ok: false,
      reason: 'challenge_not_found',
    });
  });

  it("refuses another user's satisfied challenge", async () => {
    const other = await enrol(OTHER_USER);
    const issued = await satisfiedApprovalChallenge({ userId: OTHER_USER });
    await mfa.verifyChallenge({
      challengeId: issued.challengeId,
      userId: OTHER_USER,
      code: generateTotp(other.secret, T0 + STEP),
      atMs: T0 + STEP,
    });
    // `consume` asserts USER, not OTHER_USER.
    expect(await consume(issued.challengeId)).toMatchObject({
      ok: false,
      reason: 'challenge_not_found',
    });
  });

  it('refuses a satisfied challenge that has since expired', async () => {
    const issued = await satisfied();
    const row = db.rows('mfa_challenges').find((r) => r.id === issued.challengeId)!;
    row.expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await consume(issued.challengeId)).toMatchObject({
      ok: false,
      reason: 'challenge_expired',
    });
  });
});

// ─── Factor lifecycle ─────────────────────────────────────────────────────

describe('revokeFactor', () => {
  it("will not revoke another user's factor", async () => {
    await enrol(USER);
    const victimFactorId = await mfa.activeFactorId(USER);
    expect(victimFactorId).toBeTruthy();

    const result = await mfa.revokeFactor({
      userId: OTHER_USER,
      factorId: victimFactorId!,
    });
    expect(result).toMatchObject({ ok: false, reason: 'factor_not_found' });
    expect(await mfa.isEnrolled(USER)).toBe(true);
  });

  it('revokes the caller’s own factor', async () => {
    await enrol(USER);
    const factorId = (await mfa.activeFactorId(USER))!;
    expect(await mfa.revokeFactor({ userId: USER, factorId })).toMatchObject({ ok: true });
    expect(await mfa.isEnrolled(USER)).toBe(false);
  });

  it('ends every verified session and recovery code when the factor is revoked', async () => {
    const { factorId } = await enrol(USER);
    const pending = await mfa.beginTotpEnrolment({ userId: USER, accountName: 'replacement' });
    const attestation = await mfa.attestSession({ userId: USER, sessionId: 'session', factorId });
    db.seed('mfa_session_attestations', { user_id: OTHER_USER, revoked_at: null });
    expect(await mfa.revokeFactor({ userId: USER, factorId })).toMatchObject({ ok: true });
    expect(await mfa.sessionAttestation({ userId: USER, sessionId: 'session' })).toBeNull();
    expect(
      db.rows('mfa_session_attestations').find((r) => r.id === attestation.id)?.revoked_at,
    ).toBeTruthy();
    expect(
      db.rows('mfa_session_attestations').find((r) => r.user_id === OTHER_USER)?.revoked_at,
    ).toBeNull();
    expect(db.rows('user_mfa_factors').find((r) => r.id === pending.factorId)?.status).toBe(
      'revoked',
    );
    expect((await mfa.status(USER)).recoveryCodesRemaining).toBe(0);
    expect(await mfa.revokeFactor({ userId: USER, factorId })).toMatchObject({ ok: false });
  });

  it('refuses an unused recovery code on a challenge opened before revocation', async () => {
    const enrolled = await enrol(USER);
    const challenge = await satisfiedApprovalChallenge();
    await mfa.revokeFactor({ userId: USER, factorId: enrolled.factorId });
    expect(
      await mfa.verifyChallenge({
        userId: USER,
        challengeId: challenge.challengeId,
        code: enrolled.recoveryCodes[0]!,
      }),
    ).toMatchObject({ ok: false, reason: 'code_rejected' });
  });

  it('does not report success or change credentials when the transaction fails', async () => {
    const { factorId } = await enrol(USER);
    db.failNextRpc('revoke_totp_factor');
    await expect(mfa.revokeFactor({ userId: USER, factorId })).rejects.toThrow('Could not revoke');
    expect(await mfa.isEnrolled(USER)).toBe(true);
    expect((await mfa.status(USER)).recoveryCodesRemaining).toBe(10);
  });

  it('binds enrolment and revocation challenges to different digests', () => {
    // A step-up obtained to revoke must not double as permission to enrol.
    expect(factorBindingSha256('enrolment', 'factor-1')).not.toBe(
      factorBindingSha256('factor_revocation', 'factor-1'),
    );
  });
});

describe('status', () => {
  it('reports enrolment without ever listing recovery codes', async () => {
    await enrol();
    const status = await mfa.status(USER);
    expect(status.enrolled).toBe(true);
    expect(status.recoveryCodesRemaining).toBe(10);
    expect(status.factors.every((f) => f.factorType !== 'recovery_code')).toBe(true);
    expect(JSON.stringify(status)).not.toContain('code_hash');
  });

  it('reports an unenrolled user as unenrolled', async () => {
    expect(await mfa.status(OTHER_USER)).toMatchObject({
      enrolled: false,
      recoveryCodesRemaining: 0,
    });
  });
});

describe('encryption key', () => {
  it('refuses to handle secrets when no key is configured', async () => {
    const keyless = createMfaService(() => db.client as never, { encryptionKey: '' });
    await expect(
      keyless.beginTotpEnrolment({ userId: USER, accountName: 'a@example.com' }),
    ).rejects.toThrow(/AXIOM_MFA_ENCRYPTION_KEY/);
  });

  it('keeps the harness environment shape in step with config', () => {
    // If this drifts, every BFF suite fails at `loadEnv()` rather than here.
    expect(BASE_ENV.AXIOM_MFA_ENCRYPTION_KEY.length).toBeGreaterThanOrEqual(32);
  });
});

describe('atomic activation and recovery set', () => {
  it('keeps the old credentials on persistence failure and permits a later retry', async () => {
    const old = await enrol();
    const next = await mfa.beginTotpEnrolment({ userId: USER, accountName: 'replacement' });
    db.failNextRpc('finalize_totp_enrolment');
    const input = { userId: USER, code: generateTotp(next.secret, T0 + STEP), atMs: T0 + STEP };
    expect(await mfa.activateTotpEnrolment(input)).toMatchObject({
      ok: false,
      reason: 'activation_failed',
    });
    expect(await mfa.activeFactorId(USER)).toBe(old.factorId);
    expect((await mfa.status(USER)).recoveryCodesRemaining).toBe(10);
    const challenge = await satisfiedApprovalChallenge();
    expect(
      await mfa.verifyChallenge({
        userId: USER,
        challengeId: challenge.challengeId,
        code: old.recoveryCodes[0]!,
      }),
    ).toMatchObject({ ok: true });
    expect(await mfa.activateTotpEnrolment(input)).toMatchObject({ ok: true });
    expect(await mfa.activeFactorId(USER)).toBe(next.factorId);
    expect((await mfa.status(USER)).recoveryCodesRemaining).toBe(10);
    const after = await satisfiedApprovalChallenge();
    expect(
      await mfa.verifyChallenge({
        userId: USER,
        challengeId: after.challengeId,
        code: old.recoveryCodes[1]!,
      }),
    ).toMatchObject({ ok: false });
  });
});
