import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { generateTotp } from '@axiom/mfa';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';

/**
 * W1 · SEC-8 — MFA required at login for founder / owner / approver.
 *
 * Supabase issues a session the instant a password is accepted, so "required
 * at login" is a claim about every subsequent request, not about the sign-in
 * call. These tests are written from the position of someone who has the
 * password and nothing else: they get a valid session, and they must still be
 * unable to reach anything.
 *
 *   · a required role with no factor is quarantined, and told to enrol
 *   · a required role with a factor is quarantined until it is used
 *   · an attestation is bound to ONE session id
 *   · an expired or revoked attestation is not an attestation
 *   · an unreadable tenant policy fails closed
 *   · the MFA endpoints stay reachable, or the quarantine is inescapable
 */

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://local.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'a'.repeat(40);
  process.env.SUPABASE_SERVICE_KEY = 'b'.repeat(40);
  process.env.APPROVAL_SIGNING_KEY = 'k'.repeat(48);
});

const KEY = 'gate-test-encryption-key-at-least-32-chars';
const USER = '00000000-0000-4000-8000-0000000000aa';
const TENANT = '11111111-1111-4111-8111-111111111111';
const SESSION = 'session-abc';
const OTHER_SESSION = 'session-xyz';
const T0 = Date.UTC(2026, 8, 20, 12, 0, 0);

let fake: FakeDb;
let mfa: Awaited<ReturnType<typeof buildMfa>>;

async function buildMfa() {
  const { createMfaService } = await import('../services/mfa.js');
  return createMfaService(() => fake.client as never, { encryptionKey: KEY });
}

async function buildApp(ctx: {
  role?: string | null;
  tenantId?: string | null;
  sessionId?: string;
}) {
  const { requireSessionMfa } = await import('./session-mfa.js');
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: USER, email: 'owner@example.com' } as never);
    c.set('tenantId', (ctx.tenantId === undefined ? TENANT : ctx.tenantId) as never);
    c.set('role', (ctx.role === undefined ? 'owner' : ctx.role) as never);
    c.set('sessionId', (ctx.sessionId ?? SESSION) as never);
    await next();
  });
  app.use('/v1/*', requireSessionMfa(mfa));
  app.get('/v1/plans/:id', (c) => c.json({ ok: true }));
  app.get('/v1/mfa/status', (c) => c.json({ reachable: true }));
  return app;
}

/** Enrol a TOTP factor and return its id. */
async function enrol() {
  const begun = await mfa.beginTotpEnrolment({ userId: USER, accountName: 'owner@example.com' });
  const activated = await mfa.activateTotpEnrolment({
    userId: USER,
    code: generateTotp(begun.secret, T0),
    atMs: T0,
  });
  if (!activated.ok) throw new Error('enrolment failed');
  return activated.factorId;
}

beforeEach(async () => {
  vi.resetModules();
  fake = createFakeDb({});
  fake.seed('tenants', {
    id: TENANT,
    mfa_required_roles: ['owner', 'approver'],
  });
  mfa = await buildMfa();
});

const get = (app: Hono<{ Variables: Variables }>, path: string) => app.request(path);

describe('requireSessionMfa — who it applies to', () => {
  it('lets a role outside the tenant policy through without a factor', async () => {
    const app = await buildApp({ role: 'viewer' });
    expect((await get(app, '/v1/plans/p1')).status).toBe(200);
  });

  it('requires the founder regardless of what the tenant policy says', async () => {
    // A tenant cannot exempt the only role that can globally kill-switch.
    fake.rows('tenants')[0]!.mfa_required_roles = [];
    const app = await buildApp({ role: 'founder' });
    const res = await get(app, '/v1/plans/p1');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'mfa_enrolment_required',
    );
  });

  it('fails closed when the tenant policy cannot be read', async () => {
    fake.failNext('tenants');
    const app = await buildApp({ role: 'viewer' });
    // A policy we cannot read is not a policy that exempts anyone.
    expect((await get(app, '/v1/plans/p1')).status).toBe(403);
  });

  it('lets tenantless routes past, since there is no policy to apply', async () => {
    const app = await buildApp({ role: null, tenantId: null });
    expect((await get(app, '/v1/plans/p1')).status).toBe(200);
  });
});

describe('requireSessionMfa — quarantine', () => {
  it('refuses a required role that has no factor, and says to enrol', async () => {
    const app = await buildApp({});
    const res = await get(app, '/v1/plans/p1');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('mfa_enrolment_required');
  });

  it('refuses an enrolled user who has not used the factor on this session', async () => {
    await enrol();
    const app = await buildApp({});
    const res = await get(app, '/v1/plans/p1');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    // Distinct from `mfa_enrolment_required` — this one a code can fix.
    expect(body.error.code).toBe('mfa_verification_required');
  });

  it('keeps the MFA endpoints reachable while quarantined', async () => {
    const app = await buildApp({});
    // Otherwise the quarantine has no exit and the product is bricked for
    // every owner the moment this ships.
    expect((await get(app, '/v1/mfa/status')).status).toBe(200);
  });
});

describe('requireSessionMfa — attestation', () => {
  it('admits a session that has used its factor', async () => {
    const factorId = await enrol();
    await mfa.attestSession({ userId: USER, sessionId: SESSION, factorId });
    const app = await buildApp({});
    expect((await get(app, '/v1/plans/p1')).status).toBe(200);
  });

  it('will not accept an attestation raised for a different session', async () => {
    const factorId = await enrol();
    await mfa.attestSession({ userId: USER, sessionId: OTHER_SESSION, factorId });
    // The position of someone who stole a password: they have their own
    // session, and someone else's verified one is no use to them.
    const app = await buildApp({ sessionId: SESSION });
    expect((await get(app, '/v1/plans/p1')).status).toBe(401);
  });

  it('refuses a session whose attestation window has lapsed', async () => {
    const factorId = await enrol();
    await mfa.attestSession({ userId: USER, sessionId: SESSION, factorId, ttlMs: 60_000 });
    fake.rows('mfa_session_attestations')[0]!.expires_at = new Date(
      Date.now() - 1000,
    ).toISOString();

    const app = await buildApp({});
    expect((await get(app, '/v1/plans/p1')).status).toBe(401);
  });

  it('ends live attestations when the factor behind them is revoked', async () => {
    // Replacing an authenticator, which is the case that isolates this: the
    // user stays enrolled throughout, so the gate cannot pass or fail on
    // enrolment state — only on whether the old factor's attestation survived.
    const oldFactor = await enrol();
    await mfa.attestSession({ userId: USER, sessionId: SESSION, factorId: oldFactor });
    expect((await get(await buildApp({}), '/v1/plans/p1')).status).toBe(200);

    await mfa.revokeFactor({ userId: USER, factorId: oldFactor });
    await enrol(); // a new authenticator, so `isEnrolled` is true again

    // A revoked authenticator that leaves its sessions running has not been
    // revoked in any sense that matters: whoever holds the old device would
    // keep the session they opened with it.
    const res = await get(await buildApp({}), '/v1/plans/p1');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'mfa_verification_required',
    );
  });

  it('treats a session with no readable identifier as unattested', async () => {
    const factorId = await enrol();
    await mfa.attestSession({ userId: USER, sessionId: SESSION, factorId });
    const app = await buildApp({ sessionId: '' });
    expect((await get(app, '/v1/plans/p1')).status).toBe(401);
  });

  it('defaults the attestation window to 12 hours', async () => {
    const factorId = await enrol();
    const attestation = await mfa.attestSession({ userId: USER, sessionId: SESSION, factorId });
    const hours =
      (new Date(attestation.expiresAt).getTime() - new Date(attestation.satisfiedAt).getTime()) /
      3_600_000;
    expect(hours).toBeCloseTo(12, 5);
  });
});
