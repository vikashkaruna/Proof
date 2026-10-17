import { verifyLocalCustodyCancellation } from '../workloads/local-key-admission.js';
import { bindingSha256 } from '../services/mfa.js';
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import {
  encodeLocalCustodyPolicy,
  encodeLocalCustodyEvent,
  encodeLocalCustodyCancellation,
} from '@axiom/types';
import { localCustodyPolicyRoutes, readStagedCustodyManifest } from './local-custody-policy.js';
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
      name === 'read_local_custody_policy_outcome'
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
    context: (query = '') =>
      app.request('/v1/local-custody-policy/context' + query, {
        headers: { 'X-Expected-Actor-Id': a },
      }),
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
  expect(f.mfa.consumeChallenge).toHaveBeenCalledWith(expect.objectContaining({ sessionId: s }));
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

it('reads current scoped policy/head/history without creating MFA or a write', async () => {
  const f = setup();
  await f.send('record', { request: r, challengeId: event });
  const saved = f.getSaved();
  f.write.mockClear();
  f.mfa.consumeChallenge.mockClear();
  const row = {
    policyId: op,
    policyText,
    policySha256: sha(policyText),
    keyPolicySha256: p.keyPolicySha256,
    head: { eventId: event, state: 'requested', activationEpoch: 0, reviewDueAt: 1 },
    reviewOverdue: true,
    actions: ['revoke'],
  };
  const result = {
    version: 1,
    tenantId: t,
    actorId: a,
    isDemo: false,
    canRequest: true,
    requestModes: ['operator_managed'],
    selectedPolicyId: op,
    rows: [row],
    nextCursor: null,
    history: [saved],
    nextHistoryCursor: null,
  };
  f.read.mockResolvedValue({ data: result, error: null });
  const response = await f.context('?policyId=' + op);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ data: result });
  expect(f.read).toHaveBeenLastCalledWith(
    'read_local_custody_operator_context',
    expect.objectContaining({ p_tenant_id: t, p_actor_id: a, p_session_id: s, p_policy_id: op }),
    expect.any(AbortSignal),
  );
  expect(f.write).not.toHaveBeenCalled();
  expect(f.mfa.consumeChallenge).not.toHaveBeenCalled();
  for (const wrong of [
    { tenantId: event },
    { actorId: event },
    { selectedPolicyId: event },
    { rows: [{ ...row, policySha256: 'f'.repeat(64) }] },
    { rows: [{ ...row, head: { ...row.head, state: 'active' } }] },
    { history: [] },
  ]) {
    f.read.mockResolvedValueOnce({ data: { ...result, ...wrong }, error: null });
    expect((await f.context('?policyId=' + op)).status).toBe(503);
  }
});
it('refuses malformed context pagination before RPC and supports explicit bounded cursors', async () => {
  const f = setup();
  for (const query of [
    '?policyId=bad',
    '?policyId=' + op + '&after=' + op,
    '?beforeReceiptId=1',
    '?after=' + op + '&after=' + op,
    '?unknown=x',
  ])
    expect((await f.context(query)).status).toBe(400);
  expect(f.read).not.toHaveBeenCalled();
  f.read.mockResolvedValue({
    data: {
      version: 1,
      tenantId: t,
      actorId: a,
      isDemo: false,
      canRequest: true,
      requestModes: ['operator_managed'],
      selectedPolicyId: null,
      rows: [],
      nextCursor: null,
      history: [],
      nextHistoryCursor: null,
    },
    error: null,
  });
  expect((await f.context('?after=' + op)).status).toBe(200);
  expect(f.read).toHaveBeenLastCalledWith(
    'read_local_custody_operator_context',
    expect.objectContaining({ p_after_policy_id: op }),
    expect.any(AbortSignal),
  );
});

it.each(['viewer', 'admin', 'approver'])(
  'denies known %s role before context RPC',
  async (role) => {
    const f = setup(role);
    const response = await f.context();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: 'custody_forbidden' } });
    expect(f.read).not.toHaveBeenCalled();
  },
);
it('checks a cancelled original before every MFA step and never calls a late writer', async () => {
  const f = setup(),
    c = {
      version: 1,
      operationKey: event,
      originalRequestText: encodeLocalCustodyEvent(r),
      reason: 'Stale exact intent',
      confirmed: true,
    };
  const cancellationText = encodeLocalCustodyCancellation(c);
  f.setSaved({
    state: 'cancelled',
    tenantId: t,
    actorId: a,
    operationKey: event,
    originalOperationKey: op,
    originalRequestText: c.originalRequestText,
    originalRequestSha256: sha(c.originalRequestText),
    cancellationText,
    cancellationSha256: sha(cancellationText),
    cancellationId: s,
    receipt: { id: '2', entryHash: 'c'.repeat(64) },
    replayed: true,
  });
  for (const step of ['recover', 'challenge', 'verify', 'record'])
    expect((await f.send(step)).status).toBe(200);
  expect(f.write).not.toHaveBeenCalled();
  expect(f.mfa.issueChallenge).not.toHaveBeenCalled();
  expect(f.mfa.consumeChallenge).not.toHaveBeenCalled();
});
it('resolution uses separate canonical bytes, key and domain; malformed/wrong-scope input never reaches writer', async () => {
  const f = setup(),
    c = {
      version: 1,
      operationKey: event,
      originalRequestText: encodeLocalCustodyEvent(r),
      reason: 'Stale exact intent',
      confirmed: true,
    };
  f.read.mockImplementation(async (name, args) => ({
    data:
      name === 'read_local_custody_policy_cancellation'
        ? { state: 'not_found' }
        : {
            authorized: true,
            tenantId: t,
            actorId: a,
            sessionId: s,
            operationKey: event,
            requestSha256: sha(String(args.p_request_text)),
          },
    error: null,
  }));
  expect((await f.send('challenge', { resolution: c }, { 'Idempotency-Key': event })).status).toBe(
    200,
  );
  expect(f.mfa.issueChallenge).toHaveBeenCalledWith(
    expect.objectContaining({
      boundResourceRef: event,
      boundPayloadSha256: bindingSha256([
        'axiom.local-custody.cancel',
        1,
        t,
        a,
        s,
        sha(encodeLocalCustodyCancellation(c)),
      ]),
    }),
  );
  expect(
    (await f.send('record', { request: r, resolution: c }, { 'Idempotency-Key': event })).status,
  ).toBe(400);
  expect(
    (
      await f.send(
        'record',
        { resolution: { ...c, confirmed: false } },
        { 'Idempotency-Key': event },
      )
    ).status,
  ).toBe(400);
  expect(f.write).not.toHaveBeenCalled();
});
it('records only exact fresh cancellation MFA and refuses self-consistent changed-reason readback', async () => {
  const f = setup(),
    c = {
      version: 1,
      operationKey: event,
      originalRequestText: encodeLocalCustodyEvent(r),
      reason: 'Abandon stale intent',
      confirmed: true,
    };
  const cancellationText = encodeLocalCustodyCancellation(c),
    row = {
      state: 'cancelled',
      tenantId: t,
      actorId: a,
      operationKey: event,
      originalOperationKey: op,
      originalRequestText: c.originalRequestText,
      originalRequestSha256: sha(c.originalRequestText),
      cancellationText,
      cancellationSha256: sha(cancellationText),
      cancellationId: s,
      receipt: { id: '2', entryHash: 'c'.repeat(64) },
      replayed: false,
    };
  f.read.mockImplementation(async (name, args) => ({
    data:
      name === 'read_local_custody_policy_cancellation'
        ? { state: 'not_found' }
        : {
            authorized: true,
            tenantId: t,
            actorId: a,
            sessionId: s,
            operationKey: event,
            requestSha256: sha(String(args.p_request_text)),
          },
    error: null,
  }));
  f.mfa.verifyChallenge.mockResolvedValue({
    ok: true,
    challengeId: event,
    purpose: 'local_custody_policy',
    boundResourceRef: event,
    factorId: a,
    satisfiedWith: 'totp',
  });
  expect(
    (
      await f.send(
        'verify',
        { resolution: c, challengeId: event, code: '123456' },
        { 'Idempotency-Key': event },
      )
    ).status,
  ).toBe(200);
  f.write.mockResolvedValue({ data: row, error: null });
  const response = await f.send(
    'record',
    { resolution: c, challengeId: event },
    { 'Idempotency-Key': event },
  );
  expect(response.status).toBe(201);
  expect(f.write).toHaveBeenCalledWith(
    'record_local_custody_policy_cancellation',
    expect.objectContaining({ p_request_text: cancellationText, p_challenge_id: event }),
    expect.any(AbortSignal),
  );
  expect(f.mfa.consumeChallenge).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: s,
      consumedFor: event,
      boundPayloadSha256: bindingSha256([
        'axiom.local-custody.cancel',
        1,
        t,
        a,
        s,
        sha(cancellationText),
      ]),
    }),
  );
  const changed = encodeLocalCustodyCancellation({ ...c, reason: 'Different reason' });
  f.read.mockResolvedValue({
    data: { ...row, cancellationText: changed, cancellationSha256: sha(changed) },
    error: null,
  });
  expect((await f.send('recover', { resolution: c }, { 'Idempotency-Key': event })).status).toBe(
    503,
  );
  expect(f.write).toHaveBeenCalledTimes(1);
});
it('verifies cancellation tenant/actor/original/key/hash commitments independently of HTTP delivery', () => {
  const c = {
      version: 1,
      operationKey: event,
      originalRequestText: encodeLocalCustodyEvent(r),
      reason: 'Abandon stale intent',
      confirmed: true,
    },
    cancellationText = encodeLocalCustodyCancellation(c);
  const row = {
    state: 'cancelled',
    tenantId: t,
    actorId: a,
    operationKey: event,
    originalOperationKey: op,
    originalRequestText: c.originalRequestText,
    originalRequestSha256: sha(c.originalRequestText),
    cancellationText,
    cancellationSha256: sha(cancellationText),
    cancellationId: s,
    receipt: { id: '2', entryHash: 'c'.repeat(64) },
    replayed: true,
  };
  const expected = { tenantId: t, actorId: a, originalRequestText: c.originalRequestText };
  expect(verifyLocalCustodyCancellation(row, expected)).toEqual(row);
  for (const changed of [
    { tenantId: s },
    { actorId: s },
    { operationKey: s },
    { originalOperationKey: s },
    { originalRequestText: encodeLocalCustodyEvent({ ...r, reason: 'different' }) },
    { originalRequestSha256: 'd'.repeat(64) },
    { cancellationSha256: 'd'.repeat(64) },
    { cancellationText: JSON.stringify(c) },
  ])
    expect(() => verifyLocalCustodyCancellation({ ...row, ...changed }, expected)).toThrow();
  const different = encodeLocalCustodyCancellation({
    ...c,
    originalRequestText: encodeLocalCustodyEvent({ ...r, reason: 'different' }),
  });
  expect(() =>
    verifyLocalCustodyCancellation(
      { ...row, cancellationText: different, cancellationSha256: sha(different) },
      expected,
    ),
  ).toThrow();
  expect(() => verifyLocalCustodyCancellation(row, { ...expected, tenantId: s })).toThrow();
  expect(() =>
    verifyLocalCustodyCancellation(row, {
      ...expected,
      originalRequestText: expected.originalRequestText + ' ',
    }),
  ).toThrow();
});

describe('operator-staged manifest pre-fill', () => {
  function stagedApp(role: string, raw: string | null) {
    const app = new Hono<{ Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('tenantId', t);
      c.set('user', { id: a } as never);
      c.set('sessionId', s);
      c.set('role', role as never);
      await next();
    });
    app.route(
      '/v1',
      localCustodyPolicyRoutes({
        mfa: {} as unknown as MfaService,
        read: vi.fn(),
        write: vi.fn(),
        stagedManifest: async () => raw,
      }),
    );
    return (path = '/v1/local-custody-policy/staged-manifest') => app.request(path);
  }
  const staged = JSON.stringify({ policyText, policySha256: sha(policyText) });

  it('returns the verified manifest for this tenant to an owner and a founder', async () => {
    for (const role of ['owner', 'founder']) {
      const res = await stagedApp(role, staged)();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { policyText, policySha256: sha(policyText) } });
    }
  });
  it('refuses other roles, a missing file, a wrong digest and another tenant', async () => {
    expect((await stagedApp('axiom_analyst', staged)()).status).toBe(403);
    expect((await stagedApp('viewer', staged)()).status).toBe(403);
    expect((await stagedApp('owner', null)()).status).toBe(404);
    const tampered = JSON.stringify({ policyText, policySha256: 'f'.repeat(64) });
    expect((await stagedApp('owner', tampered)()).status).toBe(422);
    const ot = '99999999-9999-4999-8999-999999999999';
    const oref = ref.replace(t, ot);
    const otherPolicy = {
      ...p,
      tenantId: ot,
      keyPolicy: { primary: oref, readable: [oref] },
      keyPolicySha256: new LocalKeyPolicy({
        tenantId: ot,
        revision: op,
        mode: 'operator_managed',
        validity: { kind: 'until_revoked', reviewDueAt: 1 },
        primary: oref,
        readable: [oref],
      }).fingerprint,
    };
    const other = encodeLocalCustodyPolicy(otherPolicy);
    // A fully valid manifest for ANOTHER tenant is not offered here.
    const res = await stagedApp(
      'owner',
      JSON.stringify({ policyText: other, policySha256: sha(other) }),
    )();
    expect(res.status).toBe(404);
  });
  it('reads only <tenantId>.json from an absolute directory', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'axiom-staged-'));
    try {
      await writeFile(join(dir, `${t}.json`), staged);
      expect(await readStagedCustodyManifest(t, dir)).toBe(staged);
      expect(
        await readStagedCustodyManifest('99999999-9999-4999-8999-999999999999', dir),
      ).toBeNull();
      const { relative } = await import('node:path');
      // Even a relative path that does point at the staged file is refused.
      expect(await readStagedCustodyManifest(t, relative(process.cwd(), dir))).toBeNull();
      expect(await readStagedCustodyManifest(t, undefined)).toBeNull();
      await expect(readStagedCustodyManifest('../etc/passwd', dir)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
