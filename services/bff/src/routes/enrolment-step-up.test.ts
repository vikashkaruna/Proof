import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { generateTotp } from '@axiom/mfa';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';

/**
 * W1 · SEC-8 — replacing a live authenticator requires holding the live one.
 *
 * `POST /v1/mfa/enrol` has carried this gate since the route was written, and
 * until now nothing exercised it through the route: the service suite proves
 * the challenge machinery and the approval suite proves the approval gate, but
 * no test asked what the enrolment endpoint does when a factor already exists.
 *
 * That gap is exactly where the defect lived. The gate was right; the web app
 * never opened the challenge, so every press of Replace was refused and the
 * refusal looked like the control working. These tests pin both halves — the
 * refusal AND the success — so a client that stops sending the challenge id
 * fails here rather than in a browser journey nobody reruns.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '00000000-0000-4000-8000-0000000000aa';

const db = vi.hoisted(() => ({ current: null as FakeDb | null }));

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://local.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'a'.repeat(40);
  process.env.SUPABASE_SERVICE_KEY = 'b'.repeat(40);
  process.env.APPROVAL_SIGNING_KEY = 'k'.repeat(48);
});

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => {
    if (!db.current) throw new Error('fake db not installed');
    return db.current.client;
  },
}));

const KEY = 'route-test-encryption-key-at-least-32-chars';
const T0 = Date.UTC(2026, 8, 21, 12, 0, 0);
const STEP = 30_000;

let fake: FakeDb;
let mfa: Awaited<ReturnType<typeof buildMfa>>;

async function buildMfa() {
  const { createMfaService } = await import('../services/mfa.js');
  return createMfaService(() => fake.client as never, { encryptionKey: KEY });
}

async function buildApp(role: UserRole = UserRole.APPROVER) {
  const { v1Routes } = await import('./v1.js');
  const routes = v1Routes({
    approvalEngine: {
      verify: async () => ({ valid: true }),
      isActionCovered: () => true,
      markNonceUsed: vi.fn(),
      issue: async () => ({ signature: 'sig', spec: {} }),
    } as never,
    killSwitch: { isActive: async () => false } as never,
    ledger: { append: vi.fn(async () => ({ sequenceNo: 1, entryHash: 'hash' })) } as never,
    mfa: mfa as never,
    realtime: { broadcast: vi.fn() } as never,
  });

  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: USER, email: 'approver@example.com' } as never);
    c.set('tenantId', TENANT as never);
    c.set('role', role);
    c.set('approvalScopes', [] as never);
    c.set('idempotencyKey', 'idem-1' as never);
    await next();
  });
  app.route('/v1', routes);
  return app;
}

const post = (app: Hono<{ Variables: Variables }>, path: string, body: string) =>
  app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

/** Enrol and activate a first factor, returning its TOTP secret. */
async function enrolFirstFactor(): Promise<string> {
  const begun = await mfa.beginTotpEnrolment({ userId: USER, accountName: 'a@example.com' });
  const activated = await mfa.activateTotpEnrolment({
    userId: USER,
    code: generateTotp(begun.secret, T0),
    atMs: T0,
  });
  if (!activated.ok) throw new Error('first enrolment failed');
  return begun.secret;
}

/** Open an `enrolment` challenge through the route and satisfy it. */
async function satisfiedEnrolmentChallenge(
  app: Hono<{ Variables: Variables }>,
  secret: string,
  atMs = T0 + STEP,
): Promise<string> {
  const res = await post(app, '/v1/mfa/challenge', JSON.stringify({ purpose: 'enrolment' }));
  expect(res.status).toBe(201);
  const { challengeId } = (await res.json()) as { challengeId: string };
  const verified = await mfa.verifyChallenge({
    challengeId,
    userId: USER,
    code: generateTotp(secret, atMs),
    atMs,
  });
  expect(verified.ok).toBe(true);
  return challengeId;
}

beforeEach(async () => {
  vi.resetModules();
  fake = createFakeDb({});
  db.current = fake;
  mfa = await buildMfa();
});

describe('POST /v1/mfa/enrol — first enrolment', () => {
  it('needs no step-up when there is no factor to protect', async () => {
    const app = await buildApp();
    const res = await post(app, '/v1/mfa/enrol', JSON.stringify({ label: 'Authenticator' }));

    expect(res.status).toBe(201);
    const body = (await res.json()) as { secret: string; provisioningUri: string };
    expect(body.secret).toBeTruthy();
    expect(body.provisioningUri).toContain('otpauth://');
  });
});

describe('POST /v1/mfa/enrol — replacing a live factor', () => {
  it('refuses when no challenge is presented', async () => {
    const app = await buildApp();
    await enrolFirstFactor();

    const res = await post(app, '/v1/mfa/enrol', JSON.stringify({ label: 'Replacement' }));

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; details: { purpose: string } } };
    expect(body.error.code).toBe('mfa_challenge_required');
    // The refusal names the way forward, which is what the UI reads.
    expect(body.error.details.purpose).toBe('enrolment');
  });

  it('refuses a challenge that was opened but never satisfied', async () => {
    const app = await buildApp();
    await enrolFirstFactor();

    const opened = await post(app, '/v1/mfa/challenge', JSON.stringify({ purpose: 'enrolment' }));
    const { challengeId } = (await opened.json()) as { challengeId: string };

    const res = await post(
      app,
      '/v1/mfa/enrol',
      JSON.stringify({ label: 'Replacement', mfaChallengeId: challengeId }),
    );

    expect(res.status).toBe(401);
    // Opening a challenge is not authenticating. If this ever returns 201 the
    // gate is decorative: anyone with a stolen session can open one.
    expect(((await res.json()) as { error: { code: string } }).error.code).not.toBe('ok');
  });

  it('issues a replacement secret once the challenge is satisfied', async () => {
    const app = await buildApp();
    const secret = await enrolFirstFactor();
    const challengeId = await satisfiedEnrolmentChallenge(app, secret);

    const res = await post(
      app,
      '/v1/mfa/enrol',
      JSON.stringify({ label: 'Replacement', mfaChallengeId: challengeId }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { secret: string; factorId: string };
    expect(body.secret).toBeTruthy();
    // A genuinely new secret, not the one being replaced.
    expect(body.secret).not.toBe(secret);

    // And the challenge is spent, so the same one cannot open a second.
    const challenge = fake.rows('mfa_challenges').find((r) => r.id === challengeId);
    expect(challenge?.consumed_at).toBeTruthy();
  });

  it('will not let one satisfied challenge enrol twice', async () => {
    const app = await buildApp();
    const secret = await enrolFirstFactor();
    const challengeId = await satisfiedEnrolmentChallenge(app, secret);

    const first = await post(
      app,
      '/v1/mfa/enrol',
      JSON.stringify({ label: 'Replacement', mfaChallengeId: challengeId }),
    );
    expect(first.status).toBe(201);

    // Replay. Without single-use consumption a stolen session could enrol a
    // device of its own alongside the one the challenge actually paid for.
    const second = await post(
      app,
      '/v1/mfa/enrol',
      JSON.stringify({ label: 'Attacker', mfaChallengeId: challengeId }),
    );
    expect(second.status).toBe(401);
  });

  it('activating the replacement retires the factor it replaced', async () => {
    const app = await buildApp();
    const oldSecret = await enrolFirstFactor();
    const oldFactorId = await mfa.activeFactorId(USER);
    const challengeId = await satisfiedEnrolmentChallenge(app, oldSecret);

    const begun = await post(
      app,
      '/v1/mfa/enrol',
      JSON.stringify({ label: 'Replacement', mfaChallengeId: challengeId }),
    );
    const { secret: newSecret, factorId: newFactorId } = (await begun.json()) as {
      secret: string;
      factorId: string;
    };

    const activate = await post(
      app,
      '/v1/mfa/enrol/activate',
      // The route activates without an `atMs`, so the service verifies against
      // the real clock. A code minted for T0 would be tens of thousands of
      // steps stale and would fail for a reason that has nothing to do with
      // what this test is about.
      JSON.stringify({ code: generateTotp(newSecret) }),
    );

    // Before migration 0030 this was 409 `no_pending_factor`: the promotion
    // hit `user_mfa_factors_one_active_totp` while the old row was still
    // active, and the unique violation was reported as a missing enrolment.
    expect(activate.status).toBe(200);

    const rows = fake.rows('user_mfa_factors');
    const oldRow = rows.find((r) => r.id === oldFactorId);
    const newRow = rows.find((r) => r.id === newFactorId);
    expect(newRow?.status).toBe('active');
    // The replaced authenticator must stop working. Leaving it active would
    // make "replace" mean "add a second device", and a user who replaced a
    // lost phone would still be protected by the phone they lost.
    expect(oldRow?.status).toBe('revoked');
    expect(rows.filter((r) => r.factor_type === 'totp' && r.status === 'active')).toHaveLength(1);
  });

  it('rejects a malformed challenge id as a bad request, not a failed step-up', async () => {
    const app = await buildApp();
    await enrolFirstFactor();

    const res = await post(
      app,
      '/v1/mfa/enrol',
      JSON.stringify({ label: 'Replacement', mfaChallengeId: 'not-a-uuid' }),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'validation_failed',
    );
  });
});

describe('POST /v1/mfa/factors/:id/revoke', () => {
  it('refuses absent and wrong-purpose proofs without removing the factor', async () => {
    const app = await buildApp();
    const secret = await enrolFirstFactor();
    const factorId = (await mfa.activeFactorId(USER))!;
    expect((await post(app, `/v1/mfa/factors/${factorId}/revoke`, '{}')).status).toBe(401);
    const challengeId = await satisfiedEnrolmentChallenge(app, secret);
    expect(
      (
        await post(
          app,
          `/v1/mfa/factors/${factorId}/revoke`,
          JSON.stringify({ mfaChallengeId: challengeId }),
        )
      ).status,
    ).toBe(401);
    expect(await mfa.isEnrolled(USER)).toBe(true);
  });

  it('spends one bound proof once and cannot revoke a different factor', async () => {
    const app = await buildApp();
    const secret = await enrolFirstFactor();
    const factorId = (await mfa.activeFactorId(USER))!;
    const opened = await post(
      app,
      '/v1/mfa/challenge',
      JSON.stringify({ purpose: 'factor_revocation' }),
    );
    expect(opened.status).toBe(201);
    const { challengeId } = (await opened.json()) as { challengeId: string };
    expect(
      await mfa.verifyChallenge({
        userId: USER,
        challengeId,
        code: generateTotp(secret, T0 + STEP),
        atMs: T0 + STEP,
      }),
    ).toMatchObject({ ok: true });
    const body = JSON.stringify({ mfaChallengeId: challengeId });
    expect(
      (await post(app, '/v1/mfa/factors/00000000-0000-4000-8000-0000000000bb/revoke', body)).status,
    ).toBe(401);
    expect((await post(app, `/v1/mfa/factors/${factorId}/revoke`, body)).status).toBe(200);
    expect((await post(app, `/v1/mfa/factors/${factorId}/revoke`, body)).status).toBe(401);
    expect(await mfa.isEnrolled(USER)).toBe(false);
  });
});

describe('activation persistence errors', () => {
  it('reports activation persistence failure as 503, without blaming the submitted code', async () => {
    const app = await buildApp();
    const pending = await mfa.beginTotpEnrolment({ userId: USER, accountName: 'first' });
    fake.failNextRpc('finalize_totp_enrolment');
    const response = await post(
      app,
      '/v1/mfa/enrol/activate',
      JSON.stringify({ code: generateTotp(pending.secret) }),
    );
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'activation_failed',
    );
    expect(await mfa.isEnrolled(USER)).toBe(false);
  });
});
