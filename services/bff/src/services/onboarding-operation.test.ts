import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { encodeOnboardingRequest } from '@axiom/types';
import type { Variables } from '../types.js';
const state = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => ({ rpc: state.rpc }),
  createHumanActionWriter: () => ({ rpc: state.rpc }),
}));
import { createExactOnboarding, readExactOnboarding } from './onboarding-operation.js';
const actor = '11111111-1111-4111-8111-111111111111',
  session = '22222222-2222-4222-8222-222222222222',
  op = '33333333-3333-4333-8333-333333333333',
  claim = '44444444-4444-4444-8444-444444444444';
const request = {
  name: 'Synthetic company',
  slug: null,
  tier: 'growth' as const,
  is_sdf: false,
  processes_health_data: false,
  processes_children_data: false,
  dpo_name: null,
  dpo_email: null,
  systems: [],
};
const hash = createHash('sha256').update(encodeOnboardingRequest(request)).digest('hex');
function app(
  options: { actor?: string; session?: string; claim?: boolean; recovery?: boolean } = {},
) {
  const h = new Hono<{ Variables: Variables }>();
  h.use('*', async (c, next) => {
    c.set('user', { id: options.actor ?? actor } as never);
    c.set('sessionId', options.session ?? session);
    if (options.recovery) c.set('onboardingReadbackOnly', true);
    if (options.claim !== false)
      c.set('requestClaim', {
        id: claim,
        key: op,
        requestSha256: 'a'.repeat(64),
        authoritySha256: 'b'.repeat(64),
      });
    await next();
  });
  h.post('/organizations/onboard', async (c) => {
    const raw = await c.req.text();
    return createExactOnboarding(c, JSON.parse(raw) as unknown, raw);
  });
  h.get('/organizations/onboarding-operations/:operationKey', (c) => readExactOnboarding(c));
  h.post('/organizations/onboarding-operations/:operationKey/fence', (c) =>
    readExactOnboarding(c, true),
  );
  return h;
}
const headers = {
  'Content-Type': 'application/json',
  'X-Expected-Actor-Id': actor,
  'Idempotency-Key': op,
};
beforeEach(() => {
  state.rpc.mockReset();
  state.rpc.mockImplementation(async (name: string) =>
    name === 'take_rate_limit'
      ? { data: { allowed: true, retry_after: 20 } }
      : name === 'read_current_catalogue_version'
        ? { data: { version: '0.1.1' } }
        : { data: { actorId: actor, operationKey: op, requestSha256: hash, state: 'unconfirmed' } },
  );
});
describe('exact onboarding boundary', () => {
  it('uses trusted middleware claim/current session and canonical original payload only', async () => {
    const response = await app().request('/organizations/onboard', {
      method: 'POST',
      headers,
      body: JSON.stringify({ operationKey: op, request }),
    });
    expect(response.status).toBe(201);
    expect(state.rpc).toHaveBeenLastCalledWith(
      'onboard_organization_exact',
      expect.objectContaining({
        p_actor_id: actor,
        p_session_id: session,
        p_claim_id: claim,
        p_claim_request_sha256: 'a'.repeat(64),
        p_claim_authority_sha256: 'b'.repeat(64),
        p_request_text: encodeOnboardingRequest(request),
      }),
    );
  });
  it.each([{ actor: '55555555-5555-4555-8555-555555555555' }, { session: '' }, { claim: false }])(
    'refuses missing/substituted authority before SQL',
    async (options) => {
      const response = await app(options).request('/organizations/onboard', {
        method: 'POST',
        headers,
        body: JSON.stringify({ operationKey: op, request }),
      });
      expect(response.status).toBe(409);
      expect(state.rpc).not.toHaveBeenCalled();
    },
  );
  it('rejects client assertion of trusted claim IDs', async () => {
    const response = await app().request('/organizations/onboard', {
      method: 'POST',
      headers,
      body: JSON.stringify({ operationKey: op, request, claimId: claim }),
    });
    expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it('recovers from a new same-actor session without spending another entitlement', async () => {
    const fresh = '66666666-6666-4666-8666-666666666666';
    const response = await app({ session: fresh }).request(
      `/organizations/onboarding-operations/${op}?requestSha256=${hash}`,
      { headers },
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledExactlyOnceWith('read_onboarding_operation', {
      p_actor_id: actor,
      p_session_id: fresh,
      p_operation_key: op,
      p_request_sha256: hash,
    });
  });
  it('rejects foreign scope returned by database', async () => {
    state.rpc.mockResolvedValue({
      data: {
        actorId: '55555555-5555-4555-8555-555555555555',
        operationKey: op,
        requestSha256: hash,
        state: 'fenced',
      },
    });
    const response = await app().request(
      `/organizations/onboarding-operations/${op}?requestSha256=${hash}`,
      { headers },
    );
    expect(response.status).toBe(503);
  });
  it('retains uncertainty rather than inventing absence on database transport failure', async () => {
    state.rpc.mockResolvedValue({ error: { code: '08006' } });
    const response = await app().request(
      `/organizations/onboarding-operations/${op}?requestSha256=${hash}`,
      { headers },
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('fenced');
  });
});

it('forwards transient exact original payload only to fence SQL, without treating it as authority', async () => {
  const originalCreateBody = JSON.stringify({ operationKey: op, request });
  const response = await app().request(`/organizations/onboarding-operations/${op}/fence`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ operationKey: op, requestSha256: hash, originalCreateBody }),
  });
  expect(response.status).toBe(200);
  expect(state.rpc).toHaveBeenCalledExactlyOnceWith('fence_onboarding_operation', {
    p_actor_id: actor,
    p_session_id: session,
    p_operation_key: op,
    p_request_sha256: hash,
    p_original_body: originalCreateBody,
  });
});

it('nonclaimed replay after offboarding rechecks current visibility and cannot create or consume entitlement', async () => {
  state.rpc.mockResolvedValue({
    data: {
      actorId: actor,
      operationKey: op,
      requestSha256: hash,
      state: 'recorded_access_withdrawn',
    },
  });
  const response = await app({ claim: false, recovery: true }).request('/organizations/onboard', {
    method: 'POST',
    headers,
    body: JSON.stringify({ operationKey: op, request }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: {
      actorId: actor,
      operationKey: op,
      requestSha256: hash,
      state: 'recorded_access_withdrawn',
    },
  });
  expect(state.rpc).toHaveBeenCalledExactlyOnceWith(
    'read_onboarding_operation',
    expect.objectContaining({
      p_actor_id: actor,
      p_session_id: session,
      p_operation_key: op,
      p_request_sha256: hash,
    }),
  );
});
it('changed-body conflict only attempts hash-bound readback and exposes no old receipt', async () => {
  state.rpc.mockResolvedValue({ error: { code: '42501' } });
  const response = await app({ claim: false, recovery: true }).request('/organizations/onboard', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      operationKey: op,
      request: { ...request, name: 'Changed organization' },
    }),
  });
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain('tenantId');
  expect(state.rpc).toHaveBeenCalledExactlyOnceWith(
    'read_onboarding_operation',
    expect.objectContaining({ p_request_sha256: expect.not.stringMatching(hash) }),
  );
});
it('fresh-session nonclaimed create can only recover original; never reuse old admission for work', async () => {
  const fresh = '66666666-6666-4666-8666-666666666666';
  const response = await app({ claim: false, recovery: true, session: fresh }).request(
    '/organizations/onboard',
    { method: 'POST', headers, body: JSON.stringify({ operationKey: op, request }) },
  );
  expect(response.status).toBe(503);
  expect(state.rpc).toHaveBeenCalledExactlyOnceWith(
    'read_onboarding_operation',
    expect.objectContaining({ p_session_id: fresh }),
  );
});
