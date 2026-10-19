import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Variables } from '../types.js';
import { ownedSyntheticPlanRoutes, type OwnedSyntheticRouteDeps } from './owned-synthetic-plans.js';
import { ownedHash } from '../services/owned-execution-plan.js';
import { ownedOperationId } from '../services/owned-execution-broker.js';
const id = (n: number) => `89140000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const request = {
  operationKey: id(3),
  bindingId: id(4),
  engagementId: id(5),
  expectedSnapshotHash: 'a'.repeat(64),
  reason: 'Explicit human owned synthetic configuration request.',
  acknowledgeOwnedSynthetic: true,
  actionType: 'config.audit_log_enable',
  desiredEnabled: true,
};
let app: Hono<{ Variables: Variables }>;
let authenticated: boolean;
let role: Variables['role'];
let session: string;
let deps: OwnedSyntheticRouteDeps;
beforeEach(() => {
  authenticated = true;
  role = 'owner';
  session = id(6);
  deps = {
    isKilled: vi.fn(async () => false),
    planPorts: vi.fn(() => {
      throw Error('No actual controller mounted in component test');
    }),
    cancellationPorts: vi.fn(() => ({
      authorizeCurrentHuman: vi.fn(async () => {}),
      cancelOriginalPendingRequest: vi.fn(async () => ({
        tenantId: id(1),
        actorId: id(2),
        operationKey: id(3),
        requestHash: ownedHash({ tenantId: id(1), actorId: id(2), request }),
        cancellationKey: id(8),
        reason: 'Stop my original unrecorded synthetic request.',
        state: 'cancelled',
        humanReceipt: '101',
        planId: null,
        executionAllowed: false,
      })),
    })),
    readTargets: vi.fn(async () => ({
      tenantId: id(1),
      actorId: id(2),
      engagementId: id(5),
      targets: [
        {
          bindingId: id(4),
          engagementId: id(5),
          label: 'Owned synthetic audit configuration',
          scope: 'owned_synthetic_config.audit_log_enable',
          auditLogEnabled: false,
          currentVersion: 0,
          snapshotHash: 'a'.repeat(64),
        },
      ],
    })),
    readOriginalOutcome: vi.fn(async () => ({ state: 'pending', receipt: null })),
  };
  app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    if (authenticated) {
      c.set('user', { id: id(2) } as Variables['user']);
      c.set('tenantId', id(1));
      c.set('role', role);
      c.set('sessionId', session);
    }
    return next();
  });
  app.route('/', ownedSyntheticPlanRoutes(deps));
});
function post(path = '', body: unknown = request, headers: Record<string, string> = {}) {
  return app.request('/plans/owned-synthetic' + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Expected-Actor-Id': id(2),
      'Idempotency-Key': id(3),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
it.each(['', '/cancel', '/outcome', '/observe-effect'])(
  'unprovided Auth context is401 before source/controller work on%s',
  async (path) => {
    authenticated = false;
    expect((await post(path)).status).toBe(401);
    expect(deps.planPorts).not.toHaveBeenCalled();
    expect(deps.cancellationPorts).not.toHaveBeenCalled();
    expect(deps.readOriginalOutcome).not.toHaveBeenCalled();
  },
);
it.each(['viewer', 'approver', 'reviewer', 'axiom_analyst'] as const)(
  'role%s cannot use owned execution source routes',
  async (r) => {
    role = r;
    expect((await post()).status).toBe(403);
    expect(deps.planPorts).not.toHaveBeenCalled();
  },
);
it('requires current session and bound expected actor before controller construction', async () => {
  session = '';
  expect((await post()).status).toBe(403);
  session = id(6);
  expect((await post('', request, { 'X-Expected-Actor-Id': id(99) })).status).toBe(409);
  expect(deps.planPorts).not.toHaveBeenCalled();
});
it.each([
  { ...request, url: 'http://caller.example' },
  { ...request, approvalTokenId: id(99) },
  { ...request, storageMode: 'postgres' },
])('request cannot register endpoint or supply authority%j', async (body) => {
  expect((await post('', body)).status).toBe(400);
  expect(deps.planPorts).not.toHaveBeenCalled();
});
it('invalid idempotency and query inputs make zero controller calls', async () => {
  expect((await post('', request, { 'Idempotency-Key': id(99) })).status).toBe(400);
  expect((await post('?url=http://caller.example')).status).toBe(400);
  expect(deps.planPorts).not.toHaveBeenCalled();
});
it('oversized body rejected before parsing or source RPC', async () => {
  expect((await post('', { reason: 'x'.repeat(17000) })).status).toBe(413);
  expect(deps.planPorts).not.toHaveBeenCalled();
});
it('engaged execution kill switch refuses plan creation before controller use', async () => {
  vi.mocked(deps.isKilled).mockResolvedValue(true);
  expect((await post()).status).toBe(423);
  expect(deps.planPorts).not.toHaveBeenCalled();
});
it('missing trusted target controller fails closed without a plan receipt', async () => {
  const result = await post();
  expect(result.status).toBe(503);
  expect(await result.json()).toEqual({ error: { code: 'owned_plan_outcome_unconfirmed' } });
});
it('human pending cancellation remains possible while execution is stopped', async () => {
  vi.mocked(deps.isKilled).mockResolvedValue(true);
  const result = await post(
    '/cancel',
    { request, cancellationKey: id(8), reason: 'Stop my original unrecorded synthetic request.' },
    { 'Idempotency-Key': id(8) },
  );
  expect(result.status).toBe(200);
  expect(deps.isKilled).not.toHaveBeenCalled();
  expect(deps.cancellationPorts).toHaveBeenCalledOnce();
  expect(await result.json()).toMatchObject({
    state: 'cancelled',
    planId: null,
    executionAllowed: false,
  });
});
it('read-only original outcome computes subject-bound original hash and does not create controller', async () => {
  const result = await post('/outcome');
  expect(result.status).toBe(200);
  expect(deps.readOriginalOutcome).toHaveBeenCalledWith(
    expect.objectContaining({ tenantId: id(1), actorId: id(2), sessionId: id(6) }),
    id(3),
    ownedHash({ tenantId: id(1), actorId: id(2), request }),
  );
  expect(deps.planPorts).not.toHaveBeenCalled();
});
it('invalid or substituted source outcome never reaches browser', async () => {
  vi.mocked(deps.readOriginalOutcome).mockResolvedValue({
    state: 'recorded',
    receipt: { tenantId: id(99) },
  });
  expect((await post('/outcome')).status).toBe(503);
  vi.mocked(deps.readOriginalOutcome).mockResolvedValue({
    state: 'pending',
    receipt: { bogus: true },
  });
  expect((await post('/outcome')).status).toBe(503);
});
it('discovery returns bounded server-owned source only, with no-store', async () => {
  const r = await app.request(`/plans/owned-synthetic/targets/${id(5)}`, {
    headers: { 'X-Expected-Actor-Id': id(2) },
  });
  expect(r.status).toBe(200);
  expect(r.headers.get('Cache-Control')).toBe('private, no-store');
  expect(deps.readTargets).toHaveBeenCalledOnce();
});
it('substituted discovery identity is refused', async () => {
  vi.mocked(deps.readTargets).mockResolvedValue({
    tenantId: id(99),
    actorId: id(2),
    engagementId: id(5),
    targets: [],
  });
  expect(
    (
      await app.request(`/plans/owned-synthetic/targets/${id(5)}`, {
        headers: { 'X-Expected-Actor-Id': id(2) },
      })
    ).status,
  ).toBe(503);
});

it.each(['owner', 'viewer'] as const)(
  'mounted source middleware leaves unrelated later and legacy plan GET routes unchanged for%s',
  async (r) => {
    role = r;
    app.get('/later-unrelated', (c) => c.json({ ok: true }));
    app.get('/plans/:id', (c) => c.json({ legacyId: c.req.param('id') }));
    const unrelated = await app.request('/later-unrelated');
    expect(unrelated.status).toBe(200);
    expect(await unrelated.json()).toEqual({ ok: true });
    const legacy = await app.request('/plans/' + id(99));
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toEqual({ legacyId: id(99) });
    expect(deps.readTargets).not.toHaveBeenCalled();
    expect(deps.planPorts).not.toHaveBeenCalled();
  },
);
it.each(['', '/cancel', '/outcome'])(
  'counts streaming bytes before buffering owned body%s despite false length',
  async (suffix) => {
    const cancelled = vi.fn();
    const raw = new Request('http://localhost/plans/owned-synthetic' + suffix, {
      method: 'POST',
      headers: { 'Content-Length': '1', 'Idempotency-Key': id(3), 'X-Expected-Actor-Id': id(2) },
      body: new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(16385));
        },
        cancel: cancelled,
      }),
      ...{ duplex: 'half' },
    });
    const unbounded = vi.spyOn(raw, 'text');
    const result = await app.request(raw);
    expect(result.status).toBe(413);
    expect(unbounded).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalled();
    expect(deps.planPorts).not.toHaveBeenCalled();
    expect(deps.cancellationPorts).not.toHaveBeenCalled();
    expect(deps.readOriginalOutcome).not.toHaveBeenCalled();
  },
);

it.each(['', '/cancel', '/outcome'])(
  'finite owned stream%s rejects before unbounded text materialization',
  async (suffix) => {
    const raw = new Request('http://localhost/plans/owned-synthetic' + suffix, {
      method: 'POST',
      headers: { 'Idempotency-Key': id(3), 'X-Expected-Actor-Id': id(2) },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(16385));
          c.close();
        },
      }),
      ...{ duplex: 'half' },
    });
    const unbounded = vi.spyOn(raw, 'text');
    expect((await app.request(raw)).status).toBe(413);
    expect(unbounded).not.toHaveBeenCalled();
  },
);

const effectRequest = { operationKey: id(3), planId: id(11), actionId: id(12), batchId: id(13) };
function effectReceipt() {
  return {
    ...effectRequest,
    tenantId: id(1),
    actorId: id(2),
    bindingId: id(4),
    contentDigest: 'a'.repeat(64),
    ledgerReceipt: '123',
    observation: {
      outcome: 'unknown',
      observedAt: '2026-10-19T00:00:00+00:00',
      forwardOperationId: ownedOperationId(id(13), id(12), 'forward'),
      rollbackOperationId: ownedOperationId(id(13), id(12), 'rollback'),
      forward: null,
      rollback: null,
      current: { fixture_id: id(20), resource_id: id(21), version: 0, audit_log_enabled: false },
      currentMatchesLastCommit: null,
      recordedActionStatus: 'failed',
      recordedBatchStatus: 'partial_failure',
      approvalExpired: true,
      approvalRevoked: false,
      retryAllowed: false,
      rollbackAllowed: false,
      executionStatusChanged: false,
    },
  };
}
it('reads original accepted effect without dispatch, retry or target-credential access', async () => {
  deps.observeEffect = vi.fn(async () => effectReceipt());
  const response = await post('/observe-effect', effectRequest);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(effectReceipt());
  expect(deps.observeEffect).toHaveBeenCalledWith(
    expect.objectContaining({ tenantId: id(1), actorId: id(2), sessionId: id(6) }),
    effectRequest,
  );
  expect(deps.planPorts).not.toHaveBeenCalled();
  expect(deps.cancellationPorts).not.toHaveBeenCalled();
});
it.each(['tenantId', 'actorId', 'operationKey', 'planId', 'actionId', 'batchId'] as const)(
  'rejects an observation for foreign%s',
  async (field) => {
    deps.observeEffect = vi.fn(async () => ({ ...effectReceipt(), [field]: id(99) }));
    expect((await post('/observe-effect', effectRequest)).status).toBe(503);
  },
);
it('rejects substituted provider operation identity', async () => {
  const r = effectReceipt();
  deps.observeEffect = vi.fn(async () => ({
    ...r,
    observation: { ...r.observation, forwardOperationId: id(99) },
  }));
  expect((await post('/observe-effect', effectRequest)).status).toBe(503);
});
it('unmounted, killed or uncertain effect source never becomes success', async () => {
  expect((await post('/observe-effect', effectRequest)).status).toBe(503);
  deps.observeEffect = vi.fn(async () => effectReceipt());
  vi.mocked(deps.isKilled).mockResolvedValue(true);
  expect((await post('/observe-effect', effectRequest)).status).toBe(423);
  expect(deps.observeEffect).not.toHaveBeenCalled();
  vi.mocked(deps.isKilled).mockResolvedValue(false);
  vi.mocked(deps.observeEffect).mockRejectedValue(Error('lost reply'));
  expect((await post('/observe-effect', effectRequest)).status).toBe(503);
});
it.each(['viewer', 'approver', 'reviewer', 'axiom_analyst'] as const)(
  'role%s cannot record an execution observation',
  async (r) => {
    role = r;
    deps.observeEffect = vi.fn(async () => effectReceipt());
    expect((await post('/observe-effect', effectRequest)).status).toBe(403);
    expect(deps.observeEffect).not.toHaveBeenCalled();
  },
);
it('refuses caller-supplied authority, endpoint or mismatching key before observation', async () => {
  deps.observeEffect = vi.fn(async () => effectReceipt());
  for (const extra of [
    { signedToken: {} },
    { endpoint: 'http://caller.invalid' },
    { retry: true },
  ]) {
    expect((await post('/observe-effect', { ...effectRequest, ...extra })).status).toBe(400);
  }
  expect((await post('/observe-effect', effectRequest, { 'Idempotency-Key': id(99) })).status).toBe(
    400,
  );
  expect(deps.observeEffect).not.toHaveBeenCalled();
});
