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

  it('rejects a retired-factor challenge without changing previously signed approval validity', async () => {
    const issued = await satisfied();
    const { ApprovalEngine, generateTestSecret } = await import('@axiom/approval-engine');
    const engine = new ApprovalEngine(generateTestSecret());
    const token = await engine.issue(TENANT, {
      planId: PLAN,
      actionIds: [ACTION_A],
      approverId: USER,
      mode: 'batch',
      concurrency: 1,
      stopOnFailure: true,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    for (const factor of db.rows('user_mfa_factors'))
      if (factor['factor_type'] === 'totp') factor['status'] = 'revoked';
    db.seed('user_mfa_factors', {
      id: OTHER_USER,
      user_id: USER,
      factor_type: 'totp',
      status: 'active',
    });
    expect(await mfa.isEnrolled(USER)).toBe(true);
    expect(await consume(issued.challengeId)).toMatchObject({
      ok: false,
      reason: 'factor_changed',
    });
    expect(await engine.verify(TENANT, token)).toMatchObject({ valid: true });
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
    const issued = await mfa.issueChallenge({
      userId: USER,
      tenantId: TENANT,
      purpose: 'enrolment',
      boundResourceRef: old.factorId,
      boundPayloadSha256: factorBindingSha256('enrolment', old.factorId),
    });
    if (!issued.ok) throw new Error('challenge not issued');
    expect(
      await mfa.verifyChallenge({
        userId: USER,
        challengeId: issued.challengeId,
        code: old.recoveryCodes[2]!,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await mfa.consumeChallenge({
        userId: USER,
        challengeId: issued.challengeId,
        purpose: 'enrolment',
        boundResourceRef: old.factorId,
        boundPayloadSha256: factorBindingSha256('enrolment', old.factorId),
      }),
    ).toMatchObject({ ok: true });
    const next = await mfa.beginTotpEnrolment({
      userId: USER,
      accountName: 'replacement',
      replacement: { factorId: old.factorId, challengeId: issued.challengeId },
    });
    db.failNextRpc('finalize_totp_enrolment');
    const input = { userId: USER, code: generateTotp(next.secret, T0 + STEP), atMs: T0 + STEP };
    expect(await mfa.activateTotpEnrolment(input)).toMatchObject({
      ok: false,
      reason: 'activation_failed',
    });
    expect(await mfa.activeFactorId(USER)).toBe(old.factorId);
    // The replacement proof already spent one code; the failed transaction spends no more.
    expect((await mfa.status(USER)).recoveryCodesRemaining).toBe(9);
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

describe.each([
  { purpose: 'local_custody_policy', suffix: 'local_custody' },
  { purpose: 'owned_synthetic_enrollment', suffix: 'owned_deployment' },
  { purpose: 'monitoring_read_scope', suffix: 'monitoring_read' },
  { purpose: 'owned_synthetic_revocation', suffix: 'owned_deployment_revocation' },
  { purpose: 'standing_policy_revision', suffix: 'standing_policy' },
] as const)('$purpose dedicated step-up', ({ purpose, suffix }) => {
  const binding = 'e'.repeat(64);
  let custodyDbNow: number | null;
  let custodyRpcCalls: { name: string; args: Record<string, unknown> }[];
  const scopeKeys = [
    'p_tenant_id',
    'p_actor_id',
    'p_session_id',
    'p_factor_id',
    'p_operation_key',
    'p_bound_payload_sha256',
  ];
  beforeEach(() => {
    custodyDbNow = null;
    custodyRpcCalls = [];
    const clock = () => custodyDbNow ?? Date.now();
    // Clock/CAS fixture only: session/role/lock authority requires native SQL qualification.
    const scope = (name: string, args: Record<string, unknown>, extra: string[]) => {
      custodyRpcCalls.push({ name, args });
      expect(Object.keys(args).sort()).toEqual([...scopeKeys, ...extra].sort());
      expect(args).toMatchObject({
        p_tenant_id: TENANT,
        p_actor_id: USER,
        p_session_id: PLAN,
        p_operation_key: ACTION_A,
        p_bound_payload_sha256: binding,
      });
      expect(args.p_factor_id).toBe(
        db
          .rows('user_mfa_factors')
          .find(
            (row) => row.user_id === USER && row.status === 'active' && row.factor_type === 'totp',
          )?.id,
      );
    };
    db.onRpc(`issue_${suffix}_mfa_challenge`, (args) => {
      scope('issue', args, ['p_ttl_ms']);
      const row = db.seed('mfa_challenges', {
        user_id: args.p_actor_id,
        tenant_id: args.p_tenant_id,
        factor_id: args.p_factor_id,
        purpose,
        bound_resource_ref: args.p_operation_key,
        bound_payload_sha256: args.p_bound_payload_sha256,
        created_at: new Date(clock()).toISOString(),
        expires_at: new Date(clock() + Number(args.p_ttl_ms)).toISOString(),
        attempts: 0,
        max_attempts: 5,
      });
      return { id: row.id, expires_at: row.expires_at, max_attempts: row.max_attempts };
    });
    db.onRpc(`satisfy_${suffix}_mfa_challenge`, (args) => {
      scope('satisfy', args, ['p_challenge_id', 'p_expected_attempts', 'p_satisfied_with']);
      const row = db.rows('mfa_challenges').find((r) => r.id === args.p_challenge_id)!;
      if (
        row.satisfied_at ||
        row.attempts !== args.p_expected_attempts ||
        Date.parse(String(row.expires_at)) <= clock()
      )
        throw Object.assign(new Error('refused'), { code: 'PT409' });
      row.satisfied_at = new Date(clock()).toISOString();
      row.satisfied_with = args.p_satisfied_with;
      return { id: row.id, satisfied_at: row.satisfied_at, satisfied_with: row.satisfied_with };
    });
    db.onRpc(`consume_${suffix}_mfa_challenge`, (args) => {
      scope('consume', args, ['p_challenge_id', 'p_expected_attempts', 'p_consumed_for']);
      const row = db.rows('mfa_challenges').find((r) => r.id === args.p_challenge_id)!;
      if (
        !row.satisfied_at ||
        row.consumed_at ||
        row.attempts !== args.p_expected_attempts ||
        Date.parse(String(row.expires_at)) <= clock()
      )
        throw Object.assign(new Error('refused'), { code: 'PT409' });
      row.consumed_at = new Date(clock()).toISOString();
      row.consumed_for = args.p_consumed_for;
      return {
        id: row.id,
        satisfied_at: row.satisfied_at,
        expires_at: row.expires_at,
        factor_id: row.factor_id,
      };
    });
  });
  const issue = () =>
    mfa.issueChallenge({
      userId: USER,
      tenantId: TENANT,
      purpose,
      sessionId: PLAN,
      boundResourceRef: ACTION_A,
      boundPayloadSha256: binding,
      ttlMs: 60000,
    });
  const consume = (challengeId: string, tenantId = TENANT) =>
    mfa.consumeChallenge({
      userId: USER,
      tenantId,
      purpose,
      sessionId: PLAN,
      challengeId,
      boundResourceRef: ACTION_A,
      boundPayloadSha256: binding,
    });
  for (const phase of ['issue', 'satisfy', 'consume'] as const) {
    it(`uses database time for custody ${phase} despite an ahead host clock`, async () => {
      // Model the independent DB clock explicitly. Real Postgres supplies created_at;
      // the legacy service supplies the other three instants from the host clock.
      const databaseNow = T0 + STEP;
      custodyDbNow = databaseNow;
      vi.useFakeTimers();
      vi.setSystemTime(databaseNow + 2000);
      try {
        const { secret } = await enrol();
        const issued = await mfa.issueChallenge({
          userId: USER,
          tenantId: TENANT,
          sessionId: PLAN,
          purpose,
          boundResourceRef: ACTION_A,
          boundPayloadSha256: binding,
          ttlMs: 300000,
        });
        if (!issued.ok) throw new Error('fixture');
        const row = db.rows('mfa_challenges').find((r) => r.id === issued.challengeId)!;
        row.created_at = new Date(databaseNow).toISOString();
        if (phase === 'issue') {
          expect(Date.parse(String(row.expires_at)) - databaseNow).toBe(300000);
          return;
        }
        expect(
          await mfa.verifyChallenge({
            challengeId: issued.challengeId,
            userId: USER,
            tenantId: TENANT,
            sessionId: PLAN,
            boundResourceRef: ACTION_A,
            boundPayloadSha256: binding,
            code: generateTotp(secret, databaseNow),
            atMs: databaseNow,
          }),
        ).toMatchObject({ ok: true });
        if (phase === 'satisfy') {
          expect(Date.parse(String(row.satisfied_at))).toBe(databaseNow);
          return;
        }
        // Isolate consumption from the separately tested satisfaction defect.
        row.satisfied_at = new Date(databaseNow).toISOString();
        expect(await consume(issued.challengeId)).toMatchObject({ ok: true });
        expect(Date.parse(String(row.consumed_at))).toBe(databaseNow);
      } finally {
        vi.useRealTimers();
      }
    });
  }
  it('requires a trusted live-session input for custody consumption only', async () => {
    const { secret } = await enrol();
    const issued = await issue();
    if (!issued.ok) throw new Error('fixture');
    await mfa.verifyChallenge({
      challengeId: issued.challengeId,
      userId: USER,
      tenantId: TENANT,
      sessionId: PLAN,
      boundResourceRef: ACTION_A,
      boundPayloadSha256: binding,
      code: generateTotp(secret, T0 + STEP),
      atMs: T0 + STEP,
    });
    const calls = custodyRpcCalls.length;
    expect(
      await mfa.consumeChallenge({
        userId: USER,
        tenantId: TENANT,
        purpose,
        challengeId: issued.challengeId,
        boundResourceRef: ACTION_A,
        boundPayloadSha256: binding,
      }),
    ).toMatchObject({ ok: false, reason: 'binding_mismatch' });
    expect(custodyRpcCalls).toHaveLength(calls);
    expect(db.rows('mfa_challenges')[0]?.consumed_at).toBeUndefined();
  });
  it('never falls back to host writes when custody database-clock RPCs fail', async () => {
    const { secret } = await enrol();
    db.failNextRpc(`issue_${suffix}_mfa_challenge`);
    await expect(issue()).rejects.toThrow('Could not issue custody MFA challenge');
    expect(db.rows('mfa_challenges')).toHaveLength(0);
    const issued = await issue();
    if (!issued.ok) throw new Error('fixture');
    db.failNextRpc(`satisfy_${suffix}_mfa_challenge`);
    expect(
      await mfa.verifyChallenge({
        challengeId: issued.challengeId,
        userId: USER,
        tenantId: TENANT,
        sessionId: PLAN,
        boundResourceRef: ACTION_A,
        boundPayloadSha256: binding,
        code: generateTotp(secret, T0 + STEP),
        atMs: T0 + STEP,
      }),
    ).toMatchObject({ ok: false });
    const row = db.rows('mfa_challenges')[0]!;
    expect(row.attempts).toBe(1);
    expect(row.satisfied_at).toBeUndefined();
    // Independent fixture satisfaction isolates consume failure from verification.
    row.satisfied_at = new Date().toISOString();
    row.satisfied_with = 'totp';
    db.failNextRpc(`consume_${suffix}_mfa_challenge`);
    expect(await consume(issued.challengeId)).toMatchObject({ ok: false });
    expect(row.consumed_at).toBeUndefined();
  });
  it('refuses malformed or expanded custody issue responses', async () => {
    await enrol();
    for (const response of [
      { id: ACTION_A, expires_at: '2026-10-16T10:00:00', max_attempts: 5 },
      { id: ACTION_A, expires_at: '2026-10-16T10:00:00Z', max_attempts: 0 },
      {
        id: ACTION_A,
        expires_at: '2026-10-16T10:00:00Z',
        max_attempts: 5,
        created_at: 'untrusted',
      },
    ]) {
      db.onRpc(`issue_${suffix}_mfa_challenge`, () => response);
      await expect(issue()).rejects.toThrow();
    }
    expect(db.rows('mfa_challenges')).toHaveLength(0);
  });
  for (const mismatch of ['id', 'satisfied_with'] as const) {
    it(`refuses a custody satisfaction response with different ${mismatch}`, async () => {
      const { secret } = await enrol();
      const issued = await issue();
      if (!issued.ok) throw new Error('fixture');
      db.onRpc(`satisfy_${suffix}_mfa_challenge`, () => ({
        id: issued.challengeId,
        satisfied_at: new Date().toISOString(),
        satisfied_with: 'totp',
        [mismatch]: mismatch === 'id' ? ACTION_B : 'recovery_code',
      }));
      await expect(
        mfa.verifyChallenge({
          challengeId: issued.challengeId,
          userId: USER,
          tenantId: TENANT,
          sessionId: PLAN,
          boundResourceRef: ACTION_A,
          boundPayloadSha256: binding,
          code: generateTotp(secret, T0 + STEP),
          atMs: T0 + STEP,
        }),
      ).rejects.toThrow();
      expect(db.rows('mfa_challenges')[0]?.satisfied_at).toBeUndefined();
    });
  }
  for (const mismatch of ['id', 'factor_id'] as const) {
    it(`refuses a custody consumption response with different ${mismatch}`, async () => {
      await enrol();
      const issued = await issue();
      if (!issued.ok) throw new Error('fixture');
      const row = db.rows('mfa_challenges')[0]!;
      row.satisfied_at = new Date().toISOString();
      row.attempts = 1;
      db.onRpc(`consume_${suffix}_mfa_challenge`, () => ({
        id: issued.challengeId,
        satisfied_at: row.satisfied_at,
        expires_at: row.expires_at,
        factor_id: row.factor_id,
        [mismatch]: ACTION_B,
      }));
      await expect(consume(issued.challengeId)).rejects.toThrow();
      expect(row.consumed_at).toBeUndefined();
    });
  }
  it('consumes custody authority once under concurrent attempts', async () => {
    await enrol();
    const issued = await issue();
    if (!issued.ok) throw new Error('fixture');
    const row = db.rows('mfa_challenges')[0]!;
    row.satisfied_at = new Date().toISOString();
    row.attempts = 1;
    const results = await Promise.all([consume(issued.challengeId), consume(issued.challengeId)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(row.consumed_for).toBe(ACTION_A);
  });
  it('requires bounded session-bound source before creating the challenge', async () => {
    await expect(mfa.issueChallenge({ userId: USER, tenantId: TENANT, purpose })).rejects.toThrow();
    expect(db.rows('mfa_challenges')).toEqual([]);
  });
  it('refuses a foreign-session/content binding before satisfying the challenge', async () => {
    const { secret } = await enrol();
    const issued = await issue();
    if (!issued.ok) throw new Error('fixture');
    expect(
      await mfa.verifyChallenge({
        challengeId: issued.challengeId,
        userId: USER,
        sessionId: PLAN,
        tenantId: TENANT,
        boundResourceRef: ACTION_A,
        boundPayloadSha256: 'f'.repeat(64),
        code: generateTotp(secret, T0 + STEP),
        atMs: T0 + STEP,
      }),
    ).toMatchObject({ ok: false, reason: 'challenge_not_found' });
    expect(
      db.rows('mfa_challenges').find((r) => r.id === issued.challengeId)?.satisfied_at,
    ).toBeFalsy();
    expect(
      await mfa.verifyChallenge({
        challengeId: issued.challengeId,
        userId: USER,
        sessionId: PLAN,
        tenantId: PLAN,
        boundResourceRef: ACTION_A,
        boundPayloadSha256: binding,
        code: generateTotp(secret, T0 + STEP),
        atMs: T0 + STEP,
      }),
    ).toMatchObject({ ok: false, reason: 'challenge_not_found' });
    expect(
      db.rows('mfa_challenges').find((r) => r.id === issued.challengeId)?.satisfied_at,
    ).toBeFalsy();
  });
  it('pins tenant and active factor, consumes once and returns original expiry', async () => {
    const { secret } = await enrol();
    const issued = await issue();
    if (!issued.ok) throw new Error('fixture');
    expect(
      await mfa.verifyChallenge({
        challengeId: issued.challengeId,
        userId: USER,
        code: generateTotp(secret, T0 + STEP),
        atMs: T0 + STEP,
        sessionId: PLAN,
        tenantId: TENANT,
        boundResourceRef: ACTION_A,
        boundPayloadSha256: binding,
      }),
    ).toMatchObject({ ok: true });
    expect(await consume(issued.challengeId, PLAN)).toMatchObject({
      ok: false,
      reason: 'binding_mismatch',
    });
    const result = await consume(issued.challengeId);
    expect(result).toMatchObject({ ok: true, expiresAt: issued.expiresAt });
    expect(result.ok && result.factorId).toBeTruthy();
    expect(await consume(issued.challengeId)).toMatchObject({
      ok: false,
      reason: 'challenge_already_consumed',
    });
  });
  it('does not satisfy a retired-factor challenge with a replacement factor', async () => {
    const { secret } = await enrol();
    const issued = await issue();
    if (!issued.ok) throw new Error('fixture');
    const old = db
      .rows('user_mfa_factors')
      .find((r) => r.factor_type === 'totp' && r.status === 'active')!;
    old.status = 'revoked';
    db.seed('user_mfa_factors', {
      id: OTHER_USER,
      user_id: USER,
      factor_type: 'totp',
      status: 'active',
      secret_encrypted: old.secret_encrypted,
    });
    expect(
      await mfa.verifyChallenge({
        challengeId: issued.challengeId,
        userId: USER,
        sessionId: PLAN,
        tenantId: TENANT,
        boundResourceRef: ACTION_A,
        boundPayloadSha256: binding,
        code: generateTotp(secret, T0 + STEP),
        atMs: T0 + STEP,
      }),
    ).toMatchObject({ ok: false, reason: 'challenge_not_found' });
    expect(
      db.rows('mfa_challenges').find((r) => r.id === issued.challengeId)?.satisfied_at,
    ).toBeFalsy();
  });
  it('refuses a satisfied challenge after active factor replacement', async () => {
    const { secret } = await enrol();
    const issued = await issue();
    if (!issued.ok) throw new Error('fixture');
    await mfa.verifyChallenge({
      challengeId: issued.challengeId,
      userId: USER,
      code: generateTotp(secret, T0 + STEP),
      atMs: T0 + STEP,
      sessionId: PLAN,
      tenantId: TENANT,
      boundResourceRef: ACTION_A,
      boundPayloadSha256: binding,
    });
    for (const row of db.rows('user_mfa_factors'))
      if (row.factor_type === 'totp') row.status = 'revoked';
    db.seed('user_mfa_factors', {
      id: OTHER_USER,
      user_id: USER,
      factor_type: 'totp',
      status: 'active',
    });
    expect(await consume(issued.challengeId)).toMatchObject({
      ok: false,
      reason: 'binding_mismatch',
    });
    expect(
      db.rows('mfa_challenges').find((r) => r.id === issued.challengeId)?.consumed_at,
    ).toBeFalsy();
  });
});
