import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole, encodeMonitoringReadScope, type MonitoringReadScopeContext } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';
import type { MfaService } from '../services/mfa.js';
const state = vi.hoisted(() => ({ db: null as FakeDb | null }));
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => state.db!.client,
  createHumanActionWriter: () => state.db!.client,
}));
import {
  monitoringReadScopeRoutes,
  monitoringReadScopesEnabled,
} from './monitoring-read-scopes.js';
const id = (n: number) => `71710000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenant = id(1),
  actor = id(2),
  session = id(3),
  schedule = id(4),
  operation = id(5),
  challenge = id(6);
const request = {
  schemaVersion: 1 as const,
  operationKey: operation,
  scheduleId: schedule,
  estateId: id(7),
  engagementId: id(8),
  connectorId: id(9),
  grantId: id(10),
  configurationSha256: 'a'.repeat(64),
  cadence: '* * * * *',
  preflightRequestId: id(11),
  previousScopeId: null,
  expiresAt: '2030-01-01T00:00:00Z',
  reason: 'Explicit narrow synthetic scheduled enumeration',
};
const intent = { phase: 'authorize' as const, request };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const sha = hash(encodeMonitoringReadScope(intent));
const absent = {
  recorded: false as const,
  requestSha256: sha,
  challengeExpiresAt: null,
  fenced: false,
  fenceReceiptId: null,
};
let db: FakeDb, context: MonitoringReadScopeContext;
const mfa = {
  issueChallenge: vi.fn<MfaService['issueChallenge']>(),
  verifyChallenge: vi.fn<MfaService['verifyChallenge']>(),
  consumeChallenge: vi.fn<MfaService['consumeChallenge']>(),
};
const discovery = vi.fn(async () => ({
  workerStatus: 'read_completed' as const,
  cleanupConfirmed: true,
}));
const write = vi.fn((args: Record<string, unknown>) => ({
  recorded: true,
  requestSha256: hash(String(args.p_request_text)),
  scopeId: operation,
  receiptId: '44',
  revoked: false,
}));
beforeEach(() => {
  vi.unstubAllEnvs();
  write.mockClear();
  discovery.mockClear();
  mfa.issueChallenge.mockReset().mockResolvedValue({
    ok: true,
    challengeId: challenge,
    expiresAt: '2030-01-01T00:00:00Z',
    maxAttempts: 5,
  });
  mfa.verifyChallenge.mockReset().mockResolvedValue({
    ok: true,
    challengeId: challenge,
    purpose: 'monitoring_read_scope',
    boundResourceRef: operation,
    factorId: id(12),
    satisfiedWith: 'totp',
  });
  mfa.consumeChallenge
    .mockReset()
    .mockResolvedValue({ ok: true, challengeId: challenge, satisfiedAt: '2026-01-01T00:00:00Z' });
  context = {
    tenantId: tenant,
    actorId: actor,
    scheduleId: schedule,
    estateId: id(7),
    kind: 'rediscovery',
    cadence: '* * * * *',
    status: 'active',
    scopeId: null,
    scopes: [],
    fires: [],
    targets: [
      {
        connectorId: id(9),
        name: 'Synthetic PG',
        configurationSha256: 'a'.repeat(64),
        grantId: id(10),
        maxExpiresAt: '2030-01-01T00:00:00Z',
      },
    ],
    preflights: [],
    engagements: [{ id: id(8), title: 'Synthetic engagement' }],
  };
  db = createFakeDb({ monitoring_read_scopes: [], postgresql_discovery_requests: [] });
  state.db = db;
  db.onRpc('monitoring_read_scope_context', () => context);
  db.onRpc('read_monitoring_read_scope_operation', () => absent);
  db.onRpc('preflight_monitoring_read_scope', () => ({
    request,
    tenantId: tenant,
    actorId: actor,
    sessionId: session,
    phase: 'authorize',
    requestSha256: sha,
    scopeRevocationAvailable: true,
    preflightDiscoveryId: id(13),
    preflightResultSha256: 'b'.repeat(64),
  }));
  db.onRpc('record_monitoring_read_scope', write);
});
function fixture(enabled = true, role: UserRole = UserRole.OWNER) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', tenant);
    c.set('user', {
      id: actor,
      app_metadata: {},
      user_metadata: {},
      aud: 'authenticated',
      created_at: '2026-01-01T00:00:00Z',
    });
    c.set('sessionId', session);
    c.set('role', role);
    await next();
  });
  app.route('/v1', monitoringReadScopeRoutes({ mfa, controller: { run: discovery }, enabled }));
  app.get('/v1/unrelated', (c) => c.json({ ok: true }));
  return app;
}
function send(
  step: string,
  body: unknown = { intent },
  role: UserRole = UserRole.OWNER,
  enabled = true,
  expected: string | null = actor,
) {
  return fixture(enabled, role).request(`/v1/monitoring/schedules/${schedule}/read-scope/${step}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(expected ? { 'X-Expected-Actor-Id': expected } : {}),
    },
    body: JSON.stringify(body),
  });
}
it('is unavailable by default and cannot be enabled in production or nonstrict auth', () => {
  expect(monitoringReadScopesEnabled()).toBe(false);
  vi.stubEnv('AXIOM_SCHEDULED_POSTGRESQL_READ_ENABLED', 'true');
  vi.stubEnv('ENVIRONMENT', 'local');
  vi.stubEnv('AXIOM_AUTH_MODE', 'strict');
  expect(monitoringReadScopesEnabled()).toBe(true);
  vi.stubEnv('ENVIRONMENT', 'prod');
  expect(monitoringReadScopesEnabled()).toBe(false);
  vi.stubEnv('ENVIRONMENT', 'local');
  vi.stubEnv('AXIOM_AUTH_MODE', 'dev');
  expect(monitoringReadScopesEnabled()).toBe(false);
});
it('guards exact and child paths while leaving unrelated routes available', async () => {
  const app = fixture(false);
  for (const suffix of ['', '/preflight', '/challenge']) {
    const response = await app.request(`/v1/monitoring/schedules/${schedule}/read-scope${suffix}`, {
      method: suffix ? 'POST' : 'GET',
      headers: { 'X-Expected-Actor-Id': actor, 'content-type': 'application/json' },
      ...(suffix ? { body: '{}' } : {}),
    });
    expect(response.status).toBe(503);
  }
  expect((await app.request('/v1/unrelated')).status).toBe(200);
  expect(mfa.issueChallenge).not.toHaveBeenCalled();
});
it.each([UserRole.VIEWER, UserRole.REVIEWER, UserRole.APPROVER, UserRole.ADMIN, UserRole.FOUNDER])(
  'refuses nonowner %s before source or MFA operations',
  async (role) => {
    expect((await send('challenge', { intent }, role)).status).toBe(403);
    expect(mfa.issueChallenge).not.toHaveBeenCalled();
  },
);
it.each([null, id(99)])(
  'binds the verified actor and current session before challenge issuance',
  async (expected) => {
    expect((await send('challenge', { intent }, UserRole.OWNER, true, expected)).status).toBe(409);
    expect(mfa.issueChallenge).not.toHaveBeenCalled();
  },
);
it('issues only a current server-verified canonical scope-bound challenge', async () => {
  expect((await send('challenge')).status).toBe(200);
  expect(mfa.issueChallenge).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: tenant,
      userId: actor,
      sessionId: session,
      purpose: 'monitoring_read_scope',
      boundResourceRef: operation,
      ttlMs: 300000,
    }),
  );
  expect(write).not.toHaveBeenCalled();
});
it('refuses altered source proofs and caller-selected endpoints without issuing MFA', async () => {
  db.onRpc('preflight_monitoring_read_scope', () => ({
    request: { ...request, grantId: id(99) },
    tenantId: tenant,
    actorId: actor,
    sessionId: session,
    phase: 'authorize',
    requestSha256: sha,
    scopeRevocationAvailable: true,
    preflightDiscoveryId: id(13),
    preflightResultSha256: 'b'.repeat(64),
  }));
  expect((await send('challenge')).status).toBe(503);
  expect(
    (
      await send('challenge', {
        intent: { phase: 'authorize', request: { ...request, password: 'private-marker' } },
      })
    ).status,
  ).toBe(400);
  expect(mfa.issueChallenge).not.toHaveBeenCalled();
});
it('reconciles already-recorded scope receipts without consuming MFA again', async () => {
  db.onRpc('read_monitoring_read_scope_operation', () => ({
    recorded: true,
    requestSha256: sha,
    scopeId: operation,
    receiptId: '44',
    revoked: false,
  }));
  expect((await send('record', { intent, challengeId: challenge })).status).toBe(200);
  expect(mfa.consumeChallenge).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
it('allows SQL to reverify an already-consumed exact challenge after a lost recording reply', async () => {
  mfa.consumeChallenge.mockResolvedValue({ ok: false, reason: 'challenge_already_consumed' });
  expect((await send('record', { intent, challengeId: challenge })).status).toBe(200);
  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0]![0]).not.toHaveProperty('code');
});
it.each(['binding_mismatch', 'factor_changed', 'challenge_expired'] as const)(
  'does not record when MFA is %s',
  async (reason) => {
    mfa.consumeChallenge.mockResolvedValue({ ok: false, reason });
    expect((await send('record', { intent, challengeId: challenge })).status).toBe(403);
    expect(write).not.toHaveBeenCalled();
  },
);
it('authoritatively fences an unrecorded intent before allowing a restart', async () => {
  db.onRpc('fence_monitoring_read_scope', () => ({
    ...absent,
    fenced: true,
    fenceReceiptId: '45',
  }));
  const response = await send('fence');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { fenceReceiptId: '45' } });
  expect(mfa.issueChallenge).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
it('does not issue or record an already-fenced original operation', async () => {
  db.onRpc('read_monitoring_read_scope_operation', () => ({
    ...absent,
    fenced: true,
    fenceReceiptId: '45',
  }));
  expect((await send('challenge')).status).toBe(200);
  expect(mfa.issueChallenge).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
it('runs a real enumerate-only preflight using the current owner without worker secrets', async () => {
  db.onRpc('request_postgresql_discovery', (args) => {
    expect(args.op).toBe('enumerate');
    expect(args.a).toBe(actor);
    expect(args.resource).toBeNull();
    return { requestId: operation, status: 'queued', replayed: false };
  });
  db.onRpc('finish_postgresql_discovery', () => ({ requestId: operation, status: 'completed' }));
  expect(
    (await send('preflight', { operationKey: operation, connectorId: id(9), engagementId: id(8) }))
      .status,
  ).toBe(200);
  expect(discovery).toHaveBeenCalledExactlyOnceWith(tenant, operation);
});
it('does not relaunch a retained technical preflight after a lost reply', async () => {
  db.onRpc('request_postgresql_discovery', () => ({
    requestId: operation,
    status: 'claimed',
    replayed: true,
  }));
  expect(
    (await send('preflight', { operationKey: operation, connectorId: id(9), engagementId: id(8) }))
      .status,
  ).toBe(200);
  expect(discovery).not.toHaveBeenCalled();
});
