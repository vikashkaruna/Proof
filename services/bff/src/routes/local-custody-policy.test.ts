import { it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { encodeLocalCustodyPolicy, encodeLocalCustodyEvent } from '@axiom/types';
import { localCustodyPolicyRoutes } from './local-custody-policy.js';
import { LocalKeyPolicy } from '../workloads/local-key-policy.js';
import type { MfaService } from '../services/mfa.js';
import type { LocalCustodyReadRpc } from '../workloads/local-key-admission.js';
import type { Variables } from '../types.js';
vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    SUPABASE_URL: 'https://local.supabase.co',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
    APPROVAL_SIGNING_KEY: 'k'.repeat(48),
    AGENT_RUNTIME_INTERNAL_TOKEN: 't'.repeat(32),
    AGENT_RUNTIME_URL: 'https://agent-runtime.internal',
    MODEL_GATEWAY_API_KEY: 'm'.repeat(32),
    AXIOM_MFA_ENCRYPTION_KEY: 'f'.repeat(48),
  });
});
const t = '11111111-1111-4111-8111-111111111111',
  a = '22222222-2222-4222-8222-222222222222',
  op = '33333333-3333-4333-8333-333333333333',
  s = '44444444-4444-4444-8444-444444444444',
  event = '55555555-5555-4555-8555-555555555555';
const ref = `axiom-local-dispatch://${t}/${op}/versions/1`,
  sha = (text: string) => createHash('sha256').update(text).digest('hex');
const p = {
  version: 1,
  policyId: op,
  tenantId: t,
  mode: 'operator_managed' as const,
  nominatedOperatorId: a,
  targetWorkloadId: '66666666-6666-4666-8666-666666666666',
  servicePrincipals: {
    producer: 'spiffe://local.axiom/service/assessment-dispatch-producer',
    controller: 'spiffe://local.axiom/controller/assessment',
  },
  validity: { kind: 'until_revoked' as const, reviewDueAt: 1 },
  actionClass: 'assessment_dispatch_key_custody',
  keyPolicy: { primary: ref, readable: [ref] },
  keyPolicySha256: new LocalKeyPolicy({
    tenantId: t,
    revision: op,
    mode: 'operator_managed',
    validity: { kind: 'until_revoked', reviewDueAt: 1 },
    primary: ref,
    readable: [ref],
  }).fingerprint,
  deploymentBindingSha256: 'b'.repeat(64),
  reason: 'Custody exception',
  acceptedLimitations: ['hardware_backing_unverified'],
  statutoryComplianceAsserted: false,
  ownershipVerified: false,
};
const policyText = encodeLocalCustodyPolicy(p),
  r = {
    version: 1,
    operationKey: op,
    transition: 'request',
    policyText,
    policySha256: sha(policyText),
    previousEventId: null,
    nextReviewDueAt: null,
    reason: 'Request',
    confirmed: true,
  };
function setup(role = 'owner', session = s) {
  let saved: unknown = { state: 'not_found' };
  const read = vi.fn(async (name: string, args: Record<string, unknown>) => ({
    data:
      name === 'read_local_custody_policy_event'
        ? saved
        : {
            authorized: true,
            tenantId: t,
            actorId: a,
            sessionId: s,
            operationKey: op,
            requestSha256: sha(String(args.p_request_text)),
          },
    error: null,
  }));
  const write = vi.fn<LocalCustodyReadRpc>(async (_name: string, args: Record<string, unknown>) => {
    const request = JSON.parse(String(args.p_request_text));
    saved = {
      state: 'recorded',
      tenantId: t,
      actorId: a,
      operationKey: op,
      policyId: op,
      transition: request.transition,
      eventId: event,
      activationEpoch: 0,
      reviewDueAt: 1,
      previousEventId: request.previousEventId,
      requestText: args.p_request_text,
      requestSha256: sha(String(args.p_request_text)),
      policySha256: r.policySha256,
      keyPolicySha256: p.keyPolicySha256,
      receipt: { id: '1', entryHash: 'c'.repeat(64) },
      replayed: false,
    };
    return { data: saved, error: null };
  });
  const mfa = {
    issueChallenge: vi.fn(async () => ({
      ok: true,
      challengeId: event,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      maxAttempts: 5,
    })),
    verifyChallenge: vi.fn(async () => ({
      ok: true,
      challengeId: event,
      purpose: 'local_custody_policy',
      boundResourceRef: op,
      factorId: a,
      satisfiedWith: 'totp',
    })),
    consumeChallenge: vi.fn(async () => ({
      ok: true,
      challengeId: event,
      satisfiedAt: new Date().toISOString(),
    })),
  };
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', t);
    c.set('user', { id: a } as never);
    c.set('sessionId', session);
    c.set('role', role as never);
    await next();
  });
  app.route('/v1', localCustodyPolicyRoutes({ mfa: mfa as unknown as MfaService, read, write }));
  const send = (
    step: string,
    body: unknown = { request: r },
    headers: Record<string, string> = {},
  ) =>
    app.request('/v1/local-custody-policy/' + step, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': op,
        'X-Expected-Actor-Id': a,
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return {
    send,
    read,
    write,
    mfa,
    setSaved: (v: unknown) => {
      saved = v;
    },
    getSaved: () => saved,
  };
}
it('binds the dedicated challenge to exact authenticated actor/session/request and validates persisted receipt', async () => {
  const f = setup();
  expect((await f.send('challenge')).status).toBe(200);
  expect(f.mfa.issueChallenge).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: a,
      tenantId: t,
      purpose: 'local_custody_policy',
      sessionId: s,
      boundResourceRef: op,
      ttlMs: 300000,
    }),
  );
  expect((await f.send('verify', { request: r, challengeId: event, code: '123456' })).status).toBe(
    200,
  );
  expect(f.mfa.verifyChallenge).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: t,
      sessionId: s,
      boundPayloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }),
  );
  expect((await f.send('record', { request: r, challengeId: event })).status).toBe(201);
  expect(f.write).toHaveBeenCalledTimes(1);
  expect((await f.send('record', { request: r })).status).toBe(200);
  expect(f.mfa.consumeChallenge).toHaveBeenCalledTimes(1);
  expect(f.write).toHaveBeenCalledTimes(1);
});
it('preserves uncertain committed outcome and only recovers exact positive readback', async () => {
  const f = setup(),
    original = f.write.getMockImplementation()!;
  f.write.mockImplementationOnce(async (...args) => {
    await original(...args);
    return { data: null, error: new Error('lost response') };
  });
  expect((await f.send('record', { request: r, challengeId: event })).status).toBe(503);
  expect((await f.send('recover')).status).toBe(200);
  expect(f.write).toHaveBeenCalledTimes(1);
  const changed = { ...r, reason: 'Different reason' };
  expect((await f.send('recover', { request: changed })).status).toBe(503);
  expect(f.write).toHaveBeenCalledTimes(1);
  f.setSaved({ state: 'not_found' });
  const response = await f.send('recover');
  expect(await response.json()).toEqual({ data: { state: 'not_found' } });
  expect(f.write).toHaveBeenCalledTimes(1);
});
it.each(['viewer', 'reviewer', 'approver', 'admin', 'agent'])(
  'does not expand %s role authority',
  async (role) => {
    const f = setup(role);
    expect((await f.send('record', { request: r, challengeId: event })).status).toBe(403);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  },
);
it('rejects stale actor/session, malformed/duplicate requests before writer', async () => {
  const f = setup();
  expect(
    (await f.send('record', { request: r, challengeId: event }, { 'X-Expected-Actor-Id': t }))
      .status,
  ).toBe(409);
  expect((await setup('owner', '').send('challenge')).status).toBe(401);
  expect((await f.send('challenge', '{"request":null,"re\\u0071uest":{}}')).status).toBe(400);
  expect((await f.send('challenge', { request: { ...r, confirmed: false } })).status).toBe(400);
  expect(f.write).not.toHaveBeenCalled();
});
it('rejects false preflight authority and mismatched factor/consumption before writer', async () => {
  const f = setup();
  f.read
    .mockResolvedValueOnce({ data: { state: 'not_found' }, error: null })
    .mockResolvedValueOnce({ data: { authorized: true }, error: null });
  expect((await f.send('record', { request: r, challengeId: event })).status).toBe(503);
  expect(f.mfa.consumeChallenge).not.toHaveBeenCalled();
  f.mfa.consumeChallenge.mockResolvedValueOnce({ ok: false } as never);
  expect((await f.send('record', { request: r, challengeId: event })).status).toBe(403);
  expect(f.write).not.toHaveBeenCalled();
});
it('does not accept a coherent forged receipt for a different request', async () => {
  const f = setup();
  await f.send('record', { request: r, challengeId: event });
  const saved = f.getSaved() as Record<string, unknown>;
  f.setSaved({ ...saved, actorId: t });
  expect((await f.send('recover')).status).toBe(503);
  f.setSaved({ ...saved, keyPolicySha256: 'f'.repeat(64) });
  expect((await f.send('recover')).status).toBe(503);
  expect(encodeLocalCustodyEvent(r)).toBe(saved.requestText);
});
it('refuses malformed transport and invalid stage combinations without writer', async () => {
  const f = setup();
  expect((await f.send('unsupported')).status).toBe(400);
  expect((await f.send('challenge', { request: r }, { 'Idempotency-Key': t })).status).toBe(400);
  expect((await f.send('challenge', { request: r }, { 'X-Expected-Actor-Id': 'bad' })).status).toBe(
    400,
  );
  expect((await f.send('challenge', { request: r, code: '123456' })).status).toBe(400);
  expect((await f.send('verify', { request: r, challengeId: event })).status).toBe(403);
  expect((await f.send('record', { request: r })).status).toBe(403);
  expect((await f.send('record', { request: r, challengeId: event, code: '123456' })).status).toBe(
    400,
  );
  f.mfa.issueChallenge.mockResolvedValueOnce({ ok: false } as never);
  expect((await f.send('challenge')).status).toBe(403);
  f.mfa.verifyChallenge.mockResolvedValueOnce({
    ok: true,
    purpose: 'approval_issuance',
    boundResourceRef: op,
  } as never);
  expect((await f.send('verify', { request: r, challengeId: event, code: '123456' })).status).toBe(
    403,
  );
  expect(f.write).not.toHaveBeenCalled();
  expect(f.mfa.consumeChallenge).not.toHaveBeenCalled();
});
