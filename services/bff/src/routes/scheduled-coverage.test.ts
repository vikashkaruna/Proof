import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole, encodeCoverageScopeIntent } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';
import type { MfaService } from '../services/mfa.js';
const state = vi.hoisted(() => ({ db: null as FakeDb | null }));
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => state.db!.client,
  createHumanActionWriter: () => state.db!.client,
}));
import { scheduledCoverageRoutes } from './scheduled-coverage.js';
const id = (n: number) => `17320000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const t = id(1),
  a = id(2),
  s = id(3),
  op = id(4),
  challenge = id(5);
const intent = {
  phase: 'revoke' as const,
  request: {
    schemaVersion: 1 as const,
    operationKey: op,
    scopeId: id(6),
    requestSha256: 'a'.repeat(64),
    reason: 'Approve this exact reviewed scheduled coverage scope',
  },
};
const sha = (v: unknown) =>
  createHash('sha256')
    .update(encodeCoverageScopeIntent(v as typeof intent))
    .digest('hex');
let db: FakeDb;
const mfa = {
  issueChallenge: vi.fn<MfaService['issueChallenge']>(),
  verifyChallenge: vi.fn<MfaService['verifyChallenge']>(),
  consumeChallenge: vi.fn<MfaService['consumeChallenge']>(),
};
const write = vi.fn((args: Record<string, unknown>) => ({
  tenantId: t,
  actorId: a,
  phase: intent.phase,
  operationKey: op,
  recorded: true,
  requestSha256: createHash('sha256').update(String(args.p_intent_text)).digest('hex'),
  scopeId: id(6),
  revoked: true,
  receiptId: '40',
}));
beforeEach(() => {
  db = createFakeDb();
  state.db = db;
  write.mockClear();
  db.onRpc('read_scheduled_coverage_scope_operation', (args) => ({
    tenantId: t,
    actorId: a,
    phase: JSON.parse(String(args.p_intent_text)).phase,
    operationKey: op,
    recorded: false,
    requestSha256: createHash('sha256').update(String(args.p_intent_text)).digest('hex'),
    fenced: false,
    fenceReceiptId: null,
    challengeExpiresAt: null,
  }));
  db.onRpc('preflight_scheduled_coverage_scope', (args) => {
    const v = JSON.parse(String(args.p_intent_text));
    return {
      intent: v,
      tenantId: t,
      actorId: a,
      sessionId: s,
      phase: v.phase,
      requestSha256: createHash('sha256').update(String(args.p_intent_text)).digest('hex'),
    };
  });
  db.onRpc('record_scheduled_coverage_scope', write);
  mfa.issueChallenge.mockReset().mockResolvedValue({
    ok: true,
    challengeId: challenge,
    expiresAt: '2030-01-01T00:00:00Z',
    maxAttempts: 5,
  });
  mfa.verifyChallenge.mockReset().mockResolvedValue({
    ok: true,
    challengeId: challenge,
    purpose: 'scheduled_coverage',
    boundResourceRef: op,
    factorId: id(7),
    satisfiedWith: 'totp',
  });
  mfa.consumeChallenge
    .mockReset()
    .mockResolvedValue({ ok: true, challengeId: challenge, satisfiedAt: '2026-01-01T00:00:00Z' });
});
function fixture(role: UserRole = UserRole.OWNER, enabled = true) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', t);
    c.set('user', {
      id: a,
      app_metadata: {},
      user_metadata: {},
      aud: 'authenticated',
      created_at: '2026-01-01T00:00:00Z',
    });
    c.set('sessionId', s);
    c.set('role', role);
    await next();
  });
  app.route('/v1', scheduledCoverageRoutes({ mfa, enabled, available: () => true }));
  return app;
}
function send(
  step: string,
  body: unknown = { intent },
  role: UserRole = UserRole.OWNER,
  enabled = true,
  expected: string | null = a,
) {
  return fixture(role, enabled).request('/v1/scheduled-coverage/' + step, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(expected ? { 'X-Expected-Actor-Id': expected } : {}),
    },
    body: JSON.stringify(body),
  });
}
it('viewer/reviewer and actor-switch refusals precede challenges', async () => {
  for (const role of [UserRole.VIEWER, UserRole.REVIEWER])
    expect((await send('challenge', { intent }, role)).status).toBe(403);
  expect((await send('challenge', { intent }, UserRole.OWNER, true, id(90))).status).toBe(409);
  expect((await send('challenge', { intent }, UserRole.OWNER, true, null)).status).toBe(409);
  expect(mfa.issueChallenge).not.toHaveBeenCalled();
});
it('challenge is bound to exact exact revocation content/session/operation rather than human ID alone', async () => {
  expect((await send('challenge')).status).toBe(200);
  const first = mfa.issueChallenge.mock.calls[0]![0];
  expect(first).toMatchObject({
    purpose: 'scheduled_coverage',
    userId: a,
    sessionId: s,
    boundResourceRef: op,
    ttlMs: 300000,
  });
  expect(
    (
      await send('challenge', {
        intent: {
          ...intent,
          request: { ...intent.request, reason: 'A different exact original revocation reason' },
        },
      })
    ).status,
  ).toBe(200);
  expect(mfa.issueChallenge.mock.calls[1]![0].boundPayloadSha256).not.toBe(
    first.boundPayloadSha256,
  );
  expect(write).not.toHaveBeenCalled();
});
it('requires actual MFA purpose and exact operation before recording', async () => {
  mfa.verifyChallenge.mockResolvedValueOnce({
    ok: true,
    challengeId: challenge,
    purpose: 'approval_issuance',
    boundResourceRef: op,
    factorId: id(7),
    satisfiedWith: 'totp',
  });
  expect((await send('verify', { intent, challengeId: challenge, code: '123456' })).status).toBe(
    403,
  );
  expect((await send('record', { intent })).status).toBe(403);
  expect(write).not.toHaveBeenCalled();
});
it('records through human writer only after consumed exact challenge and returns original scope', async () => {
  const result = await send('record', { intent, challengeId: challenge });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    data: {
      tenantId: t,
      actorId: a,
      phase: intent.phase,
      operationKey: op,
      recorded: true,
      scopeId: id(6),
      requestSha256: sha(intent),
    },
  });
  expect(write).toHaveBeenCalledWith({
    p_tenant_id: t,
    p_actor_id: a,
    p_session_id: s,
    p_intent_text: encodeCoverageScopeIntent(intent),
    p_challenge_id: challenge,
  });
});
it('lost reply is unconfirmed; readback returns original receipt without another challenge or record', async () => {
  db.failNextRpc('record_scheduled_coverage_scope');
  expect((await send('record', { intent, challengeId: challenge })).status).toBe(503);
  db.onRpc('read_scheduled_coverage_scope_operation', () => ({
    tenantId: t,
    actorId: a,
    phase: intent.phase,
    operationKey: op,
    recorded: true,
    requestSha256: sha(intent),
    scopeId: id(6),
    revoked: true,
    receiptId: '40',
  }));
  const result = await send('recover');
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ data: { revoked: true, receiptId: '40' } });
  expect(write).not.toHaveBeenCalled();
  expect(mfa.issueChallenge).not.toHaveBeenCalled();
});
it('rejects mismatched readback hashes and malformed/extra secrets before authority', async () => {
  db.onRpc('read_scheduled_coverage_scope_operation', () => ({
    tenantId: t,
    actorId: a,
    phase: intent.phase,
    operationKey: op,
    recorded: true,
    requestSha256: '0'.repeat(64),
    scopeId: id(6),
    revoked: true,
    receiptId: '40',
  }));
  expect((await send('recover')).status).toBe(503);
  expect((await send('challenge', { intent, secret: 'wrong' })).status).toBe(400);
  expect(mfa.issueChallenge).not.toHaveBeenCalled();
});

it.each(['tenantId', 'actorId', 'phase', 'operationKey'] as const)(
  'refuses foreign %s recovery bindings',
  async (field) => {
    db.onRpc('read_scheduled_coverage_scope_operation', () => ({
      tenantId: t,
      actorId: a,
      phase: intent.phase,
      operationKey: op,
      recorded: true,
      requestSha256: sha(intent),
      scopeId: id(6),
      revoked: true,
      receiptId: '40',
      [field]: field === 'phase' ? 'authorize' : id(99),
    }));
    const result = await send('recover');
    expect(result.status).toBe(503);
    expect(write).not.toHaveBeenCalled();
  },
);

it('refuses a matching hash with a substituted recorded scope', async () => {
  db.onRpc('read_scheduled_coverage_scope_operation', () => ({
    tenantId: t,
    actorId: a,
    phase: intent.phase,
    operationKey: op,
    recorded: true,
    requestSha256: sha(intent),
    scopeId: id(99),
    revoked: true,
    receiptId: '40',
  }));
  expect((await send('recover')).status).toBe(503);
  expect(write).not.toHaveBeenCalled();
});
it('requires actual configured tenant producer availability before any approval reads', async () => {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', t);
    c.set('user', { id: a } as never);
    c.set('role', UserRole.OWNER);
    c.set('sessionId', s);
    await next();
  });
  app.route('/v1', scheduledCoverageRoutes({ mfa, enabled: true, available: () => false }));
  expect(
    (
      await app.request('/v1/scheduled-coverage/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Expected-Actor-Id': a },
        body: JSON.stringify({ intent: authorization() }),
      })
    ).status,
  ).toBe(503);
  expect(write).not.toHaveBeenCalled();
  expect(mfa.issueChallenge).not.toHaveBeenCalled();
});

function authorization() {
  const hash = 'a'.repeat(64);
  return {
    phase: 'authorize',
    request: {
      schemaVersion: 1,
      purpose: 'axiom.scheduled-coverage.authority.v1',
      operationKey: op,
      tenantId: t,
      ownerId: a,
      previousScopeId: null,
      source: {
        scheduleId: id(10),
        readScopeId: id(11),
        estateId: id(12),
        connectorId: id(13),
        grantId: id(14),
        configurationSha256: hash,
        cadence: '*/5 * * * *',
        workloadId: id(15),
        custodyPolicyId: id(16),
        custodyPolicySha256: hash,
        keyPolicySha256: hash,
        custodyActivationEventId: id(17),
        custodyEpoch: 1,
        deploymentBindingSha256: hash,
        baselineRunId: id(18),
        baselineResultSha256: hash,
        preflightFireId: id(19),
        preflightDiscoveryRequestId: id(20),
        preflightDiscoveryId: id(21),
        preflightResultSha256: hash,
        catalogue: {
          libraryVersion: '0.1.1',
          rowsSha256: hash,
          questionnaireDigest: hash,
          manifestSha256: hash,
          selectionOperationKey: null,
        },
      },
      expiresAt: '2030-01-01T00:00:00Z',
      maxFires: 1,
      taskScopes: ['control_library.read', 'findings.write'],
      declarationPolicy: 'all_business_facts_unknown',
      discoveryUse: 'technical_provenance_only',
      reason: 'Explicit new bounded unknown-only scope',
    },
  };
}
it('feature-off refuses every new authorization phase before any challenge or write', async () => {
  for (const step of ['challenge', 'verify', 'record'])
    expect(
      (
        await send(
          step,
          {
            intent: authorization(),
            challengeId: challenge,
            code: step === 'verify' ? '123456' : undefined,
          },
          UserRole.OWNER,
          false,
        )
      ).status,
    ).toBe(503);
  expect(mfa.issueChallenge).not.toHaveBeenCalled();
  expect(mfa.consumeChallenge).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
it('feature-off preserves current owner exact revocation and original recovery, never a new scope', async () => {
  expect(
    (await send('record', { intent, challengeId: challenge }, UserRole.OWNER, false)).status,
  ).toBe(200);
  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0]![0].p_intent_text).toBe(encodeCoverageScopeIntent(intent));
  write.mockClear();
  expect((await send('recover', { intent }, UserRole.OWNER, false)).status).toBe(200);
  expect(write).not.toHaveBeenCalled();
});
it('feature-off history contains no new authorization candidates and retains original history schema', async () => {
  db.onRpc('scheduled_coverage_scope_context', () => ({
    tenantId: t,
    actorId: a,
    checkedAt: '2026-10-19T00:00:00Z',
    candidates: [
      {
        source: authorization().request.source,
        previousScopeId: null,
        maxExpiresAt: '2030-01-01T00:00:00Z',
      },
    ],
    scopes: [],
    fires: [],
  }));
  const result = await fixture(UserRole.OWNER, false).request('/v1/scheduled-coverage', {
    headers: { 'X-Expected-Actor-Id': a },
  });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    data: { tenantId: t, actorId: a, candidates: [], scopes: [], fires: [] },
  });
  expect(mfa.issueChallenge).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
