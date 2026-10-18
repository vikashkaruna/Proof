import { generateKeyPairSync } from 'node:crypto';
import { SignJWT } from 'jose';
import { JwtSvidVerifier } from '../../workloads/jwt-svid.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from '../../test/fake-postgrest.js';
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: vi.fn() }));
import { SqlDiscoveryGate, type SqlDiscoveryRequest } from './grant-gate.js';
import type { SqlSession } from './postgres-read.js';

const NOW = Date.now();
const SPIFFE = 'spiffe://axiom.test/agent/drishti';
const request: SqlDiscoveryRequest = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  estateId: '22222222-2222-4222-8222-222222222222',
  connectorId: '33333333-3333-4333-8333-333333333333',
  correlationId: '44444444-4444-4444-8444-444444444444',
  workloadProof: 'svid',
};
const grant = (over: Record<string, unknown> = {}) => ({
  grantId: '55555555-5555-4555-8555-555555555555',
  workloadId: '66666666-6666-4666-8666-666666666666',
  agentName: 'drishti',
  spiffeId: SPIFFE,
  systemId: '77777777-7777-4777-8777-777777777777',
  grantExpiresAt: new Date(NOW + 86_400_000).toISOString(),
  connectorVersion: 1,
  descriptorSha256: 'b'.repeat(64),
  endpointRef: 'crm_sql',
  targetBinding: 'production',
  ...over,
});

let fake: FakeDb;
let answers: unknown[];
let opened: number;
const identity = { verify: vi.fn() };
const sessions = async (): Promise<SqlSession> => {
  opened += 1;
  return {
    query: async (text) =>
      text.includes('transaction_read_only')
        ? { rows: [{ read_only: true, privileged: false, can_write: false }] }
        : text.includes('select n.nspname as schema')
          ? {
              rows: [
                { schema: 'crm', table: 'customers', kind: 'r', estimated_rows: 3, columns: [] },
              ],
            }
          : text.includes('a.attname as name')
            ? { rows: [{ name: 'email' }] }
            : { rows: [] },
    end: async () => undefined,
  };
};
const gate = () => new SqlDiscoveryGate(identity, sessions, { client: () => fake.client as never });
const scanSessions = async (): Promise<SqlSession> => {
  opened += 1;
  return {
    query: async (text) => {
      if (text.includes('transaction_read_only'))
        return { rows: [{ read_only: true, privileged: false, can_write: false }] };
      if (text.includes('join pg_index')) return { rows: [{ name: 'id' }] };
      if (text.includes('as supported'))
        return {
          rows: [
            { name: 'id', supported: true },
            { name: 'email', supported: true },
          ],
        };
      if (text.includes('as __scan_key'))
        return {
          rows: [
            { __scan_key: '1', c0: '1', c1: 'private@example.test' },
            { __scan_key: '2', c0: '2', c1: 'second@example.test' },
          ],
        };
      return { rows: [] };
    },
    end: async () => undefined,
  };
};
const scanGate = () =>
  new SqlDiscoveryGate(identity, scanSessions, { client: () => fake.client as never });

// The MySQL connector issues different session-control and catalogue SQL; this
// fake answers the MySQL posture query and the information_schema page query.
const mysqlSessions = async (): Promise<SqlSession> => {
  opened += 1;
  return {
    query: async (text) =>
      text.includes('@@session.transaction_read_only')
        ? { rows: [{ read_only: 1, privileged: 0, can_write: 0 }] }
        : text.includes('from information_schema.tables')
          ? {
              rows: [{ tschema: 'crm', tname: 'customers', kind: 'r', estimated_rows: 3 }],
            }
          : { rows: [] },
    end: async () => undefined,
  };
};
const mysqlGate = () =>
  new SqlDiscoveryGate(identity, mysqlSessions, {
    client: () => fake.client as never,
    engine: 'mysql',
  });

beforeEach(() => {
  fake = createFakeDb();
  opened = 0;
  answers = [grant(), grant()];
  fake.onRpc('resolve_sql_read_grant', () => answers.shift() ?? null);
  identity.verify.mockReset();
  identity.verify.mockResolvedValue({ spiffeId: SPIFFE, expiresAt: NOW + 600_000 });
});

describe('SqlDiscoveryGate (W4.6)', () => {
  it('runs discovery only under a live grant for the verified workload', async () => {
    const result = await gate().enumerate(request);
    expect(result.records.map((r) => r.resource)).toEqual(['crm.customers']);
    expect(opened).toBe(1);
  });

  it('opens no session without a verified identity or a live grant', async () => {
    identity.verify.mockRejectedValueOnce(new Error('bad svid'));
    await expect(gate().enumerate(request)).rejects.toMatchObject({ reason: 'identity' });
    answers = [null];
    await expect(gate().enumerate(request)).rejects.toMatchObject({ reason: 'no_grant' });
    answers = [grant({ spiffeId: 'spiffe://axiom.test/agent/other' })];
    await expect(gate().enumerate(request)).rejects.toMatchObject({ reason: 'no_grant' });
    answers = [grant({ agentName: 'karya' })];
    await expect(gate().enumerate(request)).rejects.toMatchObject({ reason: 'no_grant' });
    answers = [grant({ grantExpiresAt: new Date(NOW - 1).toISOString() })];
    await expect(gate().enumerate(request)).rejects.toMatchObject({ reason: 'expired' });
    expect(opened).toBe(0);
  });

  it('withholds results when the grant is revoked or changed mid-invocation', async () => {
    answers = [grant(), null];
    await expect(gate().sample(request, 'crm.customers', 5)).rejects.toMatchObject({
      reason: 'grant_changed',
    });
    answers = [grant(), grant({ descriptorSha256: 'c'.repeat(64) })];
    await expect(gate().enumerate(request)).rejects.toMatchObject({ reason: 'grant_changed' });
  });

  it.each(['postgresql', 'mysql'] as const)(
    'withholds %s results when session cleanup reaches workload expiry',
    async (engine) => {
      let now = NOW;
      identity.verify.mockResolvedValue({ spiffeId: SPIFFE, expiresAt: NOW + 1_000 });
      const open = engine === 'mysql' ? mysqlSessions : sessions;
      const timedSessions = async () => {
        const session = await open();
        return {
          ...session,
          end: async () => {
            await session.end();
            now = NOW + 1_000;
          },
        };
      };
      const timedGate = new SqlDiscoveryGate(identity, timedSessions, {
        client: () => fake.client as never,
        engine,
        now: () => now,
      });
      await expect(timedGate.enumerate(request)).rejects.toMatchObject({ reason: 'expired' });
      expect(opened).toBe(1);
    },
  );

  it.each(['postgresql', 'mysql'] as const)(
    'withholds %s results when live grant recheck reaches workload expiry',
    async (engine) => {
      let now = NOW;
      let checks = 0;
      identity.verify.mockResolvedValue({ spiffeId: SPIFFE, expiresAt: NOW + 1_000 });
      fake.onRpc('resolve_sql_read_grant', () => {
        checks += 1;
        if (checks === 2) now = NOW + 1_000;
        return grant();
      });
      const timedGate = new SqlDiscoveryGate(
        identity,
        engine === 'mysql' ? mysqlSessions : sessions,
        {
          client: () => fake.client as never,
          engine,
          now: () => now,
        },
      );
      await expect(timedGate.enumerate(request)).rejects.toMatchObject({ reason: 'expired' });
      expect(checks).toBe(2);
    },
  );

  it('withholds results at the invocation budget even when identity and grant remain valid', async () => {
    let now = NOW;
    const timedGate = new SqlDiscoveryGate(identity, sessions, {
      client: () => fake.client as never,
      now: () => now,
    });
    await expect(
      timedGate.discover(request, async () => {
        now = NOW + 30_000;
        return { records: [] };
      }),
    ).rejects.toMatchObject({ reason: 'expired' });
  });

  it.each(['systemId', 'workloadId', 'endpointRef', 'targetBinding'] as const)(
    'withholds results when %s changes without a descriptor revision',
    async (field) => {
      const values = {
        systemId: request.tenantId,
        workloadId: request.estateId,
        endpointRef: 'other_sql',
        targetBinding: 'sandbox',
      };
      answers = [grant(), grant({ [field]: values[field] })];
      await expect(gate().enumerate(request)).rejects.toMatchObject({ reason: 'grant_changed' });
    },
  );

  it('withholds results when workload trust is revoked after discovery', async () => {
    identity.verify.mockReset();
    identity.verify.mockResolvedValueOnce({ spiffeId: SPIFFE, expiresAt: NOW + 600_000 });
    identity.verify.mockRejectedValueOnce(new Error('revoked bundle'));
    await expect(gate().enumerate(request)).rejects.toMatchObject({ reason: 'identity' });
    expect(opened).toBe(1);
  });

  it('withholds results when grant expiry is shortened past the release time', async () => {
    let now = NOW;
    let checks = 0;
    fake.onRpc('resolve_sql_read_grant', () => {
      checks += 1;
      if (checks === 2) {
        now = NOW + 1_000;
        return grant({ grantExpiresAt: new Date(NOW + 500).toISOString() });
      }
      return grant();
    });
    const timedGate = new SqlDiscoveryGate(identity, sessions, {
      client: () => fake.client as never,
      now: () => now,
    });
    await expect(timedGate.enumerate(request)).rejects.toMatchObject({ reason: 'expired' });
  });

  it('checks actual signed SVID trust again after read-only session cleanup', async () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    let trusted = true;
    const verifier = new JwtSvidVerifier(
      {
        audience: 'sql-discovery',
        trustDomains: ['axiom.test'],
        maxLifetimeSeconds: 300,
      },
      {
        load: async () => ({
          revision: 'test-current',
          validUntil: NOW + 600_000,
          jwks: {
            keys: [
              { ...pair.publicKey.export({ format: 'jwk' }), kid: 'gate-test', use: 'jwt-svid' },
            ],
          },
        }),
        stillCurrent: async () => trusted,
      },
    );
    const proof = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'gate-test', typ: 'JWT' })
      .setSubject(SPIFFE)
      .setAudience('sql-discovery')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .sign(pair.privateKey);
    const open = async () => {
      const session = await sessions();
      return {
        ...session,
        end: async () => {
          await session.end();
          trusted = false;
        },
      };
    };
    const verifiedGate = new SqlDiscoveryGate(verifier, open, {
      client: () => fake.client as never,
    });
    await expect(
      verifiedGate.enumerate({ ...request, workloadProof: proof }),
    ).rejects.toMatchObject({ reason: 'identity' });
    expect(opened).toBe(1);
  });

  it('checks the deadline after the final asynchronous workload verification', async () => {
    let now = NOW;
    identity.verify.mockReset();
    identity.verify.mockResolvedValueOnce({ spiffeId: SPIFFE, expiresAt: NOW + 1_000 });
    identity.verify.mockImplementationOnce(async () => {
      now = NOW + 1_000;
      return { spiffeId: SPIFFE, expiresAt: NOW + 1_000 };
    });
    const timedGate = new SqlDiscoveryGate(identity, sessions, {
      client: () => fake.client as never,
      now: () => now,
    });
    await expect(timedGate.enumerate(request)).rejects.toMatchObject({ reason: 'expired' });
  });

  it('withholds results if verified workload identity changes at release', async () => {
    identity.verify.mockReset();
    identity.verify.mockResolvedValueOnce({ spiffeId: SPIFFE, expiresAt: NOW + 600_000 });
    identity.verify.mockResolvedValueOnce({
      spiffeId: 'spiffe://axiom.test/agent/other',
      expiresAt: NOW + 600_000,
    });
    await expect(gate().enumerate(request)).rejects.toMatchObject({ reason: 'identity' });
  });

  it('withholds results when re-resolved grant expiry is malformed', async () => {
    answers = [grant(), grant({ grantExpiresAt: 'invalid' })];
    await expect(gate().enumerate(request)).rejects.toMatchObject({ reason: 'expired' });
  });

  it('selects the MySQL connector when the descriptor targets MySQL', async () => {
    const result = await mysqlGate().enumerate(request);
    expect(result.records.map((r) => r.resource)).toEqual(['crm.customers']);
    expect(opened).toBe(1);
  });

  it('withholds MySQL results under the same mid-invocation checks', async () => {
    answers = [grant(), null];
    await expect(mysqlGate().enumerate(request)).rejects.toMatchObject({
      reason: 'grant_changed',
    });
  });

  it('withholds redacted scan aggregates when the grant is revoked after processing', async () => {
    answers = [grant(), null];
    await expect(scanGate().scanRedacted(request, 'crm.customers', 2, 2)).rejects.toMatchObject({
      reason: 'grant_changed',
    });
    expect(opened).toBe(1);
  });

  it('releases only counts from a redacted scan under an unchanged grant', async () => {
    const { result, grant: resolved } = await scanGate().scanRedacted(
      request,
      'crm.customers',
      2,
      2,
    );
    expect(resolved.grantId).toBe(grant().grantId);
    expect(result).toMatchObject({ processedRows: 2, pages: 1, complete: true });
    expect(result.fields.find((field) => field.field === 'email')).toMatchObject({
      sampled: 2,
      detected: { email: 2 },
    });
    expect(JSON.stringify(result)).not.toContain('private@example.test');
  });

  it('refuses scan on MySQL without opening a session', async () => {
    await expect(mysqlGate().scanRedacted(request, 'crm.customers', 2, 2)).rejects.toMatchObject({
      reason: 'engine_unsupported',
    });
    expect(opened).toBe(0);
  });
});

describe('reviewed SQL endpoint binding fence', () => {
  const binding = () => ({
    tenantId: request.tenantId,
    estateId: request.estateId,
    connectorId: request.connectorId,
    systemId: '77777777-7777-4777-8777-777777777777',
    descriptorId: '41410000-0000-4000-8000-000000000001',
    descriptorSha256: 'b'.repeat(64),
    endpointRef: 'crm_sql',
    targetBinding: 'production' as const,
    connectorVersion: 1,
  });
  const bound = (pin = binding()) =>
    new SqlDiscoveryGate(identity, sessions, { client: () => fake.client as never, binding: pin });
  it.each([
    { endpointRef: 'other_endpoint' },
    { descriptorSha256: 'c'.repeat(64) },
    { targetBinding: 'sandbox' },
    { connectorVersion: 2 },
    { systemId: '88888888-8888-4888-8888-888888888888' },
  ])('refuses a mismatching first grant before opening a session: %j', async (delta) => {
    answers = [grant(delta)];
    await expect(bound().enumerate(request)).rejects.toMatchObject({ reason: 'no_grant' });
    expect(opened).toBe(0);
  });
  it.each([
    { endpointRef: 'other_endpoint' },
    { descriptorSha256: 'c'.repeat(64) },
    { targetBinding: 'sandbox' },
    { connectorVersion: 2 },
    { systemId: '88888888-8888-4888-8888-888888888888' },
  ])('withholds results when the pinned binding changes before release: %j', async (delta) => {
    answers = [grant(), grant(delta)];
    await expect(bound().enumerate(request)).rejects.toMatchObject({ reason: 'grant_changed' });
    expect(opened).toBe(1);
  });
  it.each(['tenantId', 'estateId', 'connectorId'] as const)(
    'refuses a request outside configured%s before opening',
    async (field) => {
      await expect(
        bound().enumerate({ ...request, [field]: '99999999-9999-4999-8999-999999999999' }),
      ).rejects.toMatchObject({ reason: 'no_grant' });
      expect(opened).toBe(0);
    },
  );
  it('clones the reviewed pin so caller mutation cannot redirect an in-flight gate', async () => {
    const pin = binding();
    const service = bound(pin);
    pin.endpointRef = 'other_endpoint';
    await expect(service.enumerate(request)).resolves.toMatchObject({ records: expect.any(Array) });
    expect(opened).toBe(1);
  });
});

describe('PostgreSQL original deadline cancels stalled work', () => {
  it('aborts a never-settling first grant lookup before any session opens', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let settled = false;
    let observedSignal: AbortSignal | undefined;
    const pending = Object.assign(new Promise<never>(() => {}), {
      abortSignal(signal: AbortSignal) {
        observedSignal = signal;
        return this;
      },
    });
    const stalledClient = { rpc: () => pending };
    const bounded = new SqlDiscoveryGate(identity, sessions, {
      client: () => stalledClient as never,
      now: () => Date.now(),
    });
    const operation = bounded.enumerate(request).catch(() => {
      settled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(30001);
      expect(settled).toBe(true);
      expect(observedSignal?.aborted).toBe(true);
      expect(opened).toBe(0);
    } finally {
      vi.useRealTimers();
      void operation;
    }
  });
  it('closes a live session and stops its stalled read before returning an expiry refusal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let settled = false;
    let active = false;
    let ended = false;
    let rejectRead: ((error: Error) => void) | undefined;
    const open = async (): Promise<SqlSession> => ({
      query: async (text) => {
        if (text.includes('transaction_read_only'))
          return { rows: [{ read_only: true, privileged: false, can_write: false }] };
        if (text.includes('select n.nspname')) {
          active = true;
          return new Promise((_, reject) => {
            rejectRead = reject;
          });
        }
        return { rows: [] };
      },
      end: async () => {
        active = false;
        ended = true;
        rejectRead?.(new Error('fixture transport closed'));
      },
    });
    const bounded = new SqlDiscoveryGate(identity, open, {
      client: () => fake.client as never,
      now: () => Date.now(),
    });
    const operation = bounded.enumerate(request).catch(() => {
      settled = true;
      expect(active).toBe(false);
      expect(ended).toBe(true);
    });
    try {
      await vi.advanceTimersByTimeAsync(30001);
      expect(settled).toBe(true);
      expect(active).toBe(false);
      expect(ended).toBe(true);
    } finally {
      vi.useRealTimers();
      void operation;
    }
  });
});
