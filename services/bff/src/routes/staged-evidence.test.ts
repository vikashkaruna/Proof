import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';
import { UserRole } from '@axiom/types';
import type { Variables } from '../types.js';
const state = vi.hoisted(() => ({
  prepare: vi.fn(),
  invoke: vi.fn(),
  recover: vi.fn(),
  status: vi.fn(),
}));
vi.mock('../services/saakshi-evidence-controller.js', async (original) => ({
  ...(await original<typeof import('../services/saakshi-evidence-controller.js')>()),
  prepareStagedEvidence: state.prepare,
  invokePreparedStagedEvidence: state.invoke,
  recoverStagedEvidence: state.recover,
  readUnconfirmedStagedEvidence: state.status,
}));
import { stagedEvidenceRoutes, type StagedEvidenceRoutesDeps } from './staged-evidence.js';
const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const retention = {
  provider: 's3-compatible' as const,
  bucket: 'owned-target',
  lockMode: 'COMPLIANCE' as const,
  retentionPolicy: 'seven_years' as const,
  encryption: 'AES256' as const,
  legalHold: false,
};
const raw = {
  operationKey: id,
  filename: 'owned.txt',
  contentType: 'text/plain',
  evidenceType: 'document',
  description: 'owned',
  controlIds: [],
  contentBase64: Buffer.from('owned bytes').toString('base64'),
  retentionApproval: { ...retention, acknowledgesImmutableRetention: true },
};
let role: UserRole, actor: string, attested: boolean, killed: boolean;
let deps: StagedEvidenceRoutesDeps;
function app() {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: actor } as User);
    c.set('tenantId', id);
    c.set('role', role);
    c.set('sessionId', 'test-session');
    c.set('approvalScopes', []);
    return next();
  });
  app.route('/v1', stagedEvidenceRoutes(deps));
  return app;
}
function post(
  body: unknown = raw,
  headers: Record<string, string> = {},
  path = '/v1/evidence/staged-ingestions',
) {
  return app().request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Expected-Actor-Id': id,
      'Idempotency-Key': id,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  role = UserRole.OWNER;
  actor = id;
  attested = true;
  killed = false;
  deps = {
    rpc: { call: vi.fn() },
    mfa: {
      sessionAttestation: vi.fn(async () =>
        attested ? { factorId: id, validUntil: Date.now() + 1000 } : null,
      ) as StagedEvidenceRoutesDeps['mfa']['sessionAttestation'],
    },
    killSwitch: { isActive: vi.fn(async () => killed) },
    configuration: {
      retention,
      key: { id: 'synthetic', key: Buffer.alloc(32, 3), otherKeys: [Buffer.alloc(32, 4)] },
    },
    invocation: {
      runtimeUrl: 'http://owned.invalid',
      runtimeToken: 'synthetic-peer'.padEnd(48, 'p'),
      realtime: { broadcast: vi.fn() },
    },
  };
  state.prepare.mockResolvedValue({ replayed: false, bodyHash: 'b'.repeat(64) });
  state.invoke.mockResolvedValue({
    status: 503,
    body: { error: { code: 'staged_evidence_unconfirmed' } },
  });
  state.recover.mockRejectedValue(new Error('not proved'));
  state.status.mockResolvedValue({ status: 'unconfirmed', accepted: false });
});
describe('authenticated staged evidence composition routes', () => {
  it('options disclose configured consequence but never approval or keys', async () => {
    const response = await app().request('/v1/evidence/staged-ingestion-options');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ enabled: true, retention });
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.recover).not.toHaveBeenCalled();
  });
  it('missing setup has explicit unavailable state without empty success', async () => {
    deps.configuration = undefined;
    expect(await (await app().request('/v1/evidence/staged-ingestion-options')).json()).toEqual({
      enabled: false,
      retention: null,
    });
    expect((await post()).status).toBe(503);
    expect(state.prepare).not.toHaveBeenCalled();
  });
  it.each(['viewer', 'actor', 'mfa', 'kill', 'authority'])(
    'refuses %s before payload preparation or invocation',
    async (kind) => {
      if (kind === 'viewer') role = UserRole.VIEWER;
      if (kind === 'actor') actor = other;
      if (kind === 'mfa') attested = false;
      if (kind === 'kill') killed = true;
      if (kind === 'authority')
        deps.killSwitch.isActive = vi.fn(async () => {
          throw new Error('secret failure');
        });
      const response = await post();
      expect(response.status).toBe(
        kind === 'actor' ? 409 : kind === 'kill' ? 423 : kind === 'authority' ? 503 : 403,
      );
      expect(state.prepare).not.toHaveBeenCalled();
      expect(state.invoke).not.toHaveBeenCalled();
    },
  );
  it.each(['key', 'ack', 'tasks', 'query', 'encoding'])(
    'refuses %s request drift before preparation',
    async (kind) => {
      const response = await post(
        kind === 'ack'
          ? { ...raw, retentionApproval: { ...retention, acknowledgesImmutableRetention: false } }
          : kind === 'tasks'
            ? { ...raw, tasks: [] }
            : raw,
        kind === 'key'
          ? { 'Idempotency-Key': other }
          : kind === 'encoding'
            ? { 'Content-Encoding': 'gzip' }
            : {},
        kind === 'query' ? '/v1/evidence/staged-ingestions?extra=1' : undefined,
      );
      expect(response.status).toBe(400);
      expect(state.prepare).not.toHaveBeenCalled();
    },
  );
  it('fresh prepared source invokes only the dedicated composer and reports unconfirmed result honestly', async () => {
    const response = await post();
    expect(response.status).toBe(503);
    expect(state.prepare).toHaveBeenCalledWith(deps.rpc, id, id, raw, deps.configuration);
    expect(state.invoke).toHaveBeenCalledTimes(1);
  });
  it('already recorded uncertain attempt never redispatches or invents acceptance', async () => {
    state.prepare.mockResolvedValue({ replayed: true, bodyHash: 'b'.repeat(64) });
    const response = await post();
    expect(response.status).toBe(503);
    expect(state.invoke).not.toHaveBeenCalled();
    expect(state.recover).toHaveBeenCalledWith(deps.rpc, id, id, id, 'b'.repeat(64));
  });
  it('repeated requests recheck live kill/MFA/actor before original source replay', async () => {
    await post();
    state.prepare.mockClear();
    state.invoke.mockClear();
    killed = true;
    expect((await post()).status).toBe(423);
    expect(state.prepare).not.toHaveBeenCalled();
  });
  it('result lookup requires original exact body digest and no extra query', async () => {
    const response = await app().request(
      `/v1/evidence/staged-ingestions/${id}/result?bodyHash=${'b'.repeat(64)}&cipher=forbidden`,
      { headers: { 'X-Expected-Actor-Id': id } },
    );
    expect(response.status).toBe(400);
    expect(state.recover).not.toHaveBeenCalled();
  });
  it.each(['short-key', 'reused-key', 'short-peer', 'bad-url', 'bad-retention'])(
    'invalid %s disables creation before preparing an intent',
    async (kind) => {
      if (kind === 'short-key') deps.configuration!.key.key = Buffer.alloc(31);
      if (kind === 'reused-key') deps.configuration!.key.otherKeys = [deps.configuration!.key.key];
      if (kind === 'short-peer') deps.invocation = { ...deps.invocation!, runtimeToken: 'short' };
      if (kind === 'bad-url')
        deps.invocation = { ...deps.invocation!, runtimeUrl: 'file:///tmp/runtime' };
      if (kind === 'bad-retention')
        deps.configuration!.retention = { ...retention, legalHold: 'true' as unknown as boolean };
      expect(await (await app().request('/v1/evidence/staged-ingestion-options')).json()).toEqual({
        enabled: false,
        retention: null,
      });
      expect((await post()).status).toBe(503);
      expect(state.prepare).not.toHaveBeenCalled();
    },
  );
  it('disabled creation preserves authenticated original status and expiry recovery without dispatch', async () => {
    deps.configuration = undefined;
    const response = await app().request(
      `/v1/evidence/staged-ingestions/${id}/status?bodyHash=${'b'.repeat(64)}`,
      { headers: { 'X-Expected-Actor-Id': id } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(state.status).toHaveBeenCalledWith(deps.rpc, id, id, id, 'b'.repeat(64));
    const expired = await post(
      { bodyHash: 'b'.repeat(64), acknowledgeUnconfirmedPreservation: true },
      {},
      `/v1/evidence/staged-ingestions/${id}/expire`,
    );
    expect(expired.status).toBe(200);
    expect(state.status).toHaveBeenLastCalledWith(deps.rpc, id, id, id, 'b'.repeat(64), true);
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.invoke).not.toHaveBeenCalled();
  });
  it.each(['result', 'status', 'expire'])(
    'rechecks actor/MFA/kill for every %s operation',
    async (operation) => {
      const request = () =>
        operation === 'expire'
          ? post(
              { bodyHash: 'b'.repeat(64), acknowledgeUnconfirmedPreservation: true },
              {},
              `/v1/evidence/staged-ingestions/${id}/expire`,
            )
          : app().request(
              `/v1/evidence/staged-ingestions/${id}/${operation}?bodyHash=${'b'.repeat(64)}`,
              { headers: { 'X-Expected-Actor-Id': id } },
            );
      for (const denial of ['actor', 'mfa', 'kill', 'role']) {
        actor = denial === 'actor' ? other : id;
        attested = denial !== 'mfa';
        killed = denial === 'kill';
        role = denial === 'role' ? UserRole.VIEWER : UserRole.OWNER;
        expect((await request()).status).toBe(
          denial === 'actor' ? 409 : denial === 'kill' ? 423 : 403,
        );
      }
      expect(state.status).not.toHaveBeenCalled();
      expect(state.recover).not.toHaveBeenCalled();
    },
  );
  it.each(['ack', 'extra', 'key', 'query', 'encoding', 'oversized'])(
    'refuses expiry %s drift before administrative settlement',
    async (kind) => {
      const body = { bodyHash: 'b'.repeat(64), acknowledgeUnconfirmedPreservation: kind !== 'ack' };
      const response = await post(
        kind === 'extra'
          ? { ...body, tasks: [] }
          : kind === 'oversized'
            ? { ...body, extra: 'x'.repeat(5000) }
            : body,
        kind === 'key'
          ? { 'Idempotency-Key': other }
          : kind === 'encoding'
            ? { 'Content-Encoding': 'gzip' }
            : {},
        `/v1/evidence/staged-ingestions/${id}/expire${kind === 'query' ? '?extra=1' : ''}`,
      );
      expect(response.status).toBe(kind === 'oversized' ? 413 : 400);
      expect(state.status).not.toHaveBeenCalled();
      expect(state.invoke).not.toHaveBeenCalled();
    },
  );
  it('unexpired or mismatched original expiry refusal remains unconfirmed without dispatch', async () => {
    state.status.mockRejectedValue(new Error('private database detail'));
    const response = await post(
      { bodyHash: 'b'.repeat(64), acknowledgeUnconfirmedPreservation: true },
      {},
      `/v1/evidence/staged-ingestions/${id}/expire`,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'staged_evidence_unconfirmed' } });
    expect(state.invoke).not.toHaveBeenCalled();
  });
});
