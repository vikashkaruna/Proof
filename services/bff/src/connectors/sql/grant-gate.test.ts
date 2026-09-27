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
});
