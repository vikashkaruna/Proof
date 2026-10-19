import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole, encodeDataFlowIntent } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';
import type { MfaService } from '../services/mfa.js';
const state = vi.hoisted(() => ({ db: null as FakeDb | null }));
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => state.db!.client,
  createHumanActionWriter: () => state.db!.client,
}));
import { dataFlowDeclarationRoutes } from './data-flow-declarations.js';
const id = (n: number) => `17320000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const t = id(1),
  a = id(2),
  s = id(3),
  op = id(4),
  challenge = id(5);
const intent = {
  phase: 'approve' as const,
  request: {
    schemaVersion: 1 as const,
    operationKey: op,
    revisionId: id(6),
    expectedContentSha256: 'a'.repeat(64),
    reason: 'Approve this exact reviewed synthetic standing revision',
  },
};
const sha = (v: unknown) =>
  createHash('sha256')
    .update(encodeDataFlowIntent(v as typeof intent))
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
  revisionId: id(6),
  state: 'approved',
  receiptId: '40',
}));
beforeEach(() => {
  db = createFakeDb();
  state.db = db;
  write.mockClear();
  db.onRpc('read_data_flow_declaration_operation', (args) => ({
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
  db.onRpc('preflight_data_flow_declaration', (args) => {
    const v = JSON.parse(String(args.p_intent_text));
    return {
      intent: v,
      tenantId: t,
      actorId: a,
      sessionId: s,
      phase: v.phase,
      requestSha256: createHash('sha256').update(String(args.p_intent_text)).digest('hex'),
      source: {
        origin: { systemId: id(20), estateId: id(21), version: 1, contentSha256: 'b'.repeat(64) },
        destination: { kind: 'unknown' },
        ropa: null,
      },
      sourceSha256: 'c'.repeat(64),
    };
  });
  db.onRpc('record_data_flow_declaration', write);
  mfa.issueChallenge.mockReset().mockResolvedValue({
    ok: true,
    challengeId: challenge,
    expiresAt: '2030-01-01T00:00:00Z',
    maxAttempts: 5,
  });
  mfa.verifyChallenge.mockReset().mockResolvedValue({
    ok: true,
    challengeId: challenge,
    purpose: 'data_flow_declaration',
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
  app.route('/v1', dataFlowDeclarationRoutes({ mfa, enabled }));
  return app;
}
function send(
  step: string,
  body: unknown = { intent },
  role: UserRole = UserRole.OWNER,
  enabled = true,
  expected: string | null = a,
) {
  return fixture(role, enabled).request('/v1/data-flows/' + step, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(expected ? { 'X-Expected-Actor-Id': expected } : {}),
    },
    body: JSON.stringify(body),
  });
}
it('default-off, viewer/reviewer and actor-switch refusals precede challenges', async () => {
  expect((await send('challenge', { intent }, UserRole.OWNER, false)).status).toBe(503);
  for (const role of [UserRole.VIEWER, UserRole.REVIEWER])
    expect((await send('challenge', { intent }, role)).status).toBe(403);
  expect((await send('challenge', { intent }, UserRole.OWNER, true, id(90))).status).toBe(409);
  expect((await send('challenge', { intent }, UserRole.OWNER, true, null)).status).toBe(409);
  expect(mfa.issueChallenge).not.toHaveBeenCalled();
});
it('challenge is bound to exact approval phase/session/operation rather than human ID alone', async () => {
  expect((await send('challenge')).status).toBe(200);
  const first = mfa.issueChallenge.mock.calls[0]![0];
  expect(first).toMatchObject({
    purpose: 'data_flow_declaration',
    userId: a,
    sessionId: s,
    boundResourceRef: op,
    ttlMs: 300000,
  });
  expect((await send('challenge', { intent: { ...intent, phase: 'withdraw' } })).status).toBe(200);
  expect(mfa.issueChallenge.mock.calls[1]![0].boundPayloadSha256).not.toBe(
    first.boundPayloadSha256,
  );
  expect(write).not.toHaveBeenCalled();
});
it('requires actual MFA purpose and exact operation before recording', async () => {
  mfa.verifyChallenge.mockResolvedValueOnce({
    ok: true,
    challengeId: challenge,
    purpose: 'plan_approve',
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
it('records through human writer only after consumed exact challenge and returns original revision', async () => {
  const result = await send('record', { intent, challengeId: challenge });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    data: {
      tenantId: t,
      actorId: a,
      phase: intent.phase,
      operationKey: op,
      recorded: true,
      revisionId: id(6),
      requestSha256: sha(intent),
    },
  });
  expect(write).toHaveBeenCalledWith({
    p_tenant_id: t,
    p_actor_id: a,
    p_session_id: s,
    p_intent_text: encodeDataFlowIntent(intent),
    p_challenge_id: challenge,
  });
});
it('lost reply is unconfirmed; readback returns original receipt without another challenge or record', async () => {
  db.failNextRpc('record_data_flow_declaration');
  expect((await send('record', { intent, challengeId: challenge })).status).toBe(503);
  db.onRpc('read_data_flow_declaration_operation', () => ({
    tenantId: t,
    actorId: a,
    phase: intent.phase,
    operationKey: op,
    recorded: true,
    requestSha256: sha(intent),
    revisionId: id(6),
    state: 'withdrawn',
    receiptId: '40',
  }));
  const result = await send('recover');
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ data: { state: 'withdrawn', receiptId: '40' } });
  expect(write).not.toHaveBeenCalled();
  expect(mfa.issueChallenge).not.toHaveBeenCalled();
});
it('rejects mismatched readback hashes and malformed/extra secrets before authority', async () => {
  db.onRpc('read_data_flow_declaration_operation', () => ({
    tenantId: t,
    actorId: a,
    phase: intent.phase,
    operationKey: op,
    recorded: true,
    requestSha256: '0'.repeat(64),
    revisionId: id(6),
    state: 'approved',
    receiptId: '40',
  }));
  expect((await send('recover')).status).toBe(503);
  expect((await send('challenge', { intent, secret: 'wrong' })).status).toBe(400);
  expect(mfa.issueChallenge).not.toHaveBeenCalled();
});

it.each(['tenantId', 'actorId', 'phase', 'operationKey'] as const)(
  'refuses foreign %s recovery bindings',
  async (field) => {
    db.onRpc('read_data_flow_declaration_operation', () => ({
      tenantId: t,
      actorId: a,
      phase: intent.phase,
      operationKey: op,
      recorded: true,
      requestSha256: sha(intent),
      revisionId: id(6),
      state: 'approved',
      receiptId: '40',
      [field]: field === 'phase' ? 'withdraw' : id(99),
    }));
    const result = await send('recover');
    expect(result.status).toBe(503);
    expect(write).not.toHaveBeenCalled();
  },
);

it('lets current read-only users inspect truthful empty history but not mutate', async () => {
  db.onRpc('data_flow_declaration_context', () => ({
    tenantId: t,
    actorId: a,
    checkedAt: '2030-01-01T00:00:00Z',
    canPrepare: false,
    canReview: false,
    systems: [],
    parties: [],
    revisions: [],
    historyHasMore: false,
  }));
  const result = await fixture(UserRole.VIEWER).request('/v1/data-flows', {
    headers: { 'X-Expected-Actor-Id': a },
  });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ data: { canPrepare: false, revisions: [] } });
  expect((await send('record', { intent, challengeId: challenge }, UserRole.VIEWER)).status).toBe(
    403,
  );
  expect(write).not.toHaveBeenCalled();
});
it('rejects foreign context and exact historical lookup that did not return its revision', async () => {
  const context = {
    tenantId: t,
    actorId: a,
    checkedAt: '2030-01-01T00:00:00Z',
    canPrepare: true,
    canReview: true,
    systems: [],
    parties: [],
    revisions: [],
    historyHasMore: false,
  };
  db.onRpc('data_flow_declaration_context', () => ({ ...context, tenantId: id(99) }));
  expect(
    (await fixture().request('/v1/data-flows', { headers: { 'X-Expected-Actor-Id': a } })).status,
  ).toBe(503);
  db.onRpc('data_flow_declaration_context', () => context);
  expect(
    (await fixture().request('/v1/data-flows/' + id(8), { headers: { 'X-Expected-Actor-Id': a } }))
      .status,
  ).toBe(404);
  expect((await send('recover', { intent, code: '123456' })).status).toBe(400);
});
it('reports the actual default-off flag without SQL or source acceptance claims', async () => {
  const result = await fixture(UserRole.VIEWER, false).request('/v1/data-flows/configuration', {
    headers: { 'X-Expected-Actor-Id': a },
  });
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({
    data: { tenantId: t, actorId: a, enabled: false, metadataOnly: true },
  });
  expect(mfa.issueChallenge).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
