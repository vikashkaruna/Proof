import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredWorkload } from './registration.js';
import {
  TaskProof,
  WorkloadTaskAuthority,
  WorkloadTaskIssuer,
  WorkloadTaskRefused,
  SupabaseWorkloadTaskStore,
  type TaskRecord,
  type TaskIssueRequest,
  type TaskAuthorizationRequest,
  type WorkloadTaskStore,
} from './tasks.js';
const id = (n: number) => `47470000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const bearer = Buffer.alloc(32, 7).toString('base64url');
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const identity: RegisteredWorkload = {
    tenantId: id(1),
    workloadId: id(2),
    agentName: 'drishti',
    spiffeId: 'spiffe://local.axiomproof.test/agent/drishti',
    trustDomain: 'local.axiomproof.test',
    audience: 'axiom-credential-broker',
    bundleRevision: 'current',
    expiresAt: Date.now() + 60000,
    declaredScopes: ['connector.read', 'estate.read'],
  };
  const row: TaskRecord = {
    tenant_id: id(1),
    workload_id: id(2),
    agent_name: 'drishti',
    run_id: id(3),
    created_by: id(4),
    estate_id: id(5),
    engagement_id: id(6),
    correlation_id: id(7),
    input_hash: 'a'.repeat(64),
    scopes: ['connector.read'],
    expires_at: new Date(Date.now() + 30000).toISOString(),
  };
  const request: TaskAuthorizationRequest = {
    tenantId: id(1),
    runId: id(3),
    agentName: 'drishti',
    workloadProof: 'synthetic-svid',
    taskProof: bearer,
  };
  const authenticate = vi.fn(async () => identity);
  const load = vi.fn<WorkloadTaskStore['load']>(async () => row);
  return {
    identity,
    row,
    request,
    authenticate,
    load,
    authority: new WorkloadTaskAuthority({ authenticate }, { load }),
  };
}
function database(reply: (body: Record<string, unknown>) => unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>(
    async (_url, init) =>
      new Response(
        JSON.stringify(reply(JSON.parse(String(init?.body)) as Record<string, unknown>)),
        { status, headers: { 'Content-Type': 'application/json' } },
      ),
  );
  return {
    fetcher,
    db: createClient('https://db.test.invalid', 'synthetic-key', {
      global: { fetch: fetcher },
      auth: { persistSession: false },
    }),
  };
}
const issue: TaskIssueRequest = {
  tenantId: id(1),
  actorId: id(4),
  workloadId: id(2),
  agentName: 'drishti',
  estateId: id(5),
  engagementId: id(6),
  correlationId: id(7),
  inputHash: 'a'.repeat(64),
  scopes: ['connector.read'],
};
afterEach(() => vi.useRealTimers());
describe('task authority at the private BFF boundary', () => {
  it('requires SVID and a hashed task proof, intersects permissions and returns immutable safe context', async () => {
    const f = fixture();
    const result = await f.authority.authorize(f.request, 'connector.read');
    expect(f.authenticate).toHaveBeenCalledWith(
      'synthetic-svid',
      id(1),
      'drishti',
      'connector.read',
    );
    expect(f.load).toHaveBeenCalledWith({
      tenantId: id(1),
      runId: id(3),
      workloadId: id(2),
      agentName: 'drishti',
      proofHash: digest(bearer),
      scope: 'connector.read',
    });
    expect(result.grantedScopes).toEqual(['connector.read']);
    expect(result.expiresAt).toBe(Date.parse(f.row.expires_at));
    expect(result.estateId).toBe(id(5));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.grantedScopes)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-svid|taskProof|proofHash/);
    expect(JSON.stringify(result)).not.toContain(bearer);
  });
  it.each(['tenant_id', 'workload_id', 'run_id'] as const)(
    'refuses mismatched %s even from the store',
    async (field) => {
      const f = fixture();
      f.row[field] = id(99);
      await expect(f.authority.authorize(f.request, 'connector.read')).rejects.toThrow(
        WorkloadTaskRefused,
      );
    },
  );
  it.each([
    'wrong agent',
    'task scope',
    'declared scope',
    'identity tenant',
    'identity agent',
    'task expired',
    'identity expired',
    'null row',
    'store error',
    'auth error',
  ])('fails closed on %s', async (kind) => {
    const f = fixture();
    if (kind === 'wrong agent') f.row.agent_name = 'sudhaar';
    if (kind === 'task scope') f.row.scopes = [];
    if (kind === 'declared scope')
      f.authenticate.mockResolvedValue({ ...f.identity, declaredScopes: [] });
    if (kind === 'identity tenant')
      f.authenticate.mockResolvedValue({ ...f.identity, tenantId: id(99) });
    if (kind === 'identity agent')
      f.authenticate.mockResolvedValue({ ...f.identity, agentName: 'sudhaar' });
    if (kind === 'task expired') f.row.expires_at = new Date(Date.now() - 1).toISOString();
    if (kind === 'identity expired')
      f.authenticate.mockResolvedValue({ ...f.identity, expiresAt: Date.now() - 1 });
    if (kind === 'null row') f.load.mockResolvedValue(null);
    if (kind === 'store error') f.load.mockRejectedValue(new Error('secret-db-detail'));
    if (kind === 'auth error') f.authenticate.mockRejectedValue(new Error('secret-jwt-detail'));
    await expect(f.authority.authorize(f.request, 'connector.read')).rejects.toThrow(
      'Workload task authority was refused.',
    );
  });
  it('does not cache revoked authority between tool calls or outlive an SVID', async () => {
    const f = fixture();
    f.row.expires_at = new Date(Date.now() + 120000).toISOString();
    expect((await f.authority.authorize(f.request, 'connector.read')).expiresAt).toBe(
      f.identity.expiresAt,
    );
    f.load.mockResolvedValue(null);
    await expect(f.authority.authorize(f.request, 'connector.read')).rejects.toThrow(
      WorkloadTaskRefused,
    );
    expect(f.authenticate).toHaveBeenCalledTimes(2);
    expect(f.load).toHaveBeenCalledTimes(2);
  });
  it('refuses a proof that expires while task lookup is in flight', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.load.mockImplementation(async () => {
      vi.advanceTimersByTime(60001);
      return f.row;
    });
    await expect(f.authority.authorize(f.request, 'connector.read')).rejects.toThrow(
      WorkloadTaskRefused,
    );
  });
  it('copies caller input before awaiting identity verification', async () => {
    const f = fixture();
    f.authenticate.mockImplementation(async () => {
      f.request.tenantId = id(99);
      f.request.runId = id(99);
      f.request.taskProof = Buffer.alloc(32, 9).toString('base64url');
      return f.identity;
    });
    expect((await f.authority.authorize(f.request, 'connector.read')).runId).toBe(id(3));
    expect(f.load.mock.calls[0]?.[0].proofHash).toBe(digest(bearer));
  });
  it.each(['short', 'A'.repeat(42) + 'B', 'A'.repeat(42) + '=', 'A'.repeat(44)])(
    'rejects malformed or noncanonical task proof before I/O',
    async (value) => {
      const f = fixture();
      f.request.taskProof = value;
      await expect(f.authority.authorize(f.request, 'connector.read')).rejects.toThrow(
        WorkloadTaskRefused,
      );
      expect(f.authenticate).not.toHaveBeenCalled();
    },
  );
});
describe('delegation issuer and PostgREST adapter', () => {
  it('creates unique random proofs, persists only their hashes, and redacts ordinary serialization', async () => {
    const d = database((body) => ({ run_id: id(3), expires_at: body.p_expires_at }));
    const issuer = new WorkloadTaskIssuer(d.db);
    const first = await issuer.issue(issue),
      second = await issuer.issue(issue);
    expect(first.proof.reveal()).not.toBe(second.proof.reveal());
    const body = JSON.parse(String(d.fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.p_proof_hash).toBe(digest(first.proof.reveal()));
    expect(JSON.stringify(body)).not.toContain(first.proof.reveal());
    expect(JSON.stringify(first)).not.toContain(first.proof.reveal());
    expect(inspect(first.proof)).toBe('[REDACTED TASK PROOF]');
    expect(String(first.proof)).toBe('[REDACTED TASK PROOF]');
    expect(() => new TaskProof('invalid')).toThrow();
  });
  it.each(['karya', 'undeclared', 'duplicates', 'malformed'])(
    'refuses %s before issuing a task',
    async (kind) => {
      const d = database(() => null);
      const request = { ...issue };
      if (kind === 'karya') request.agentName = 'karya';
      if (kind === 'undeclared') request.scopes = ['connector.write'];
      if (kind === 'duplicates') request.scopes = ['connector.read', 'connector.read'];
      if (kind === 'malformed') request.inputHash = 'invalid';
      await expect(new WorkloadTaskIssuer(d.db).issue(request)).rejects.toThrow(
        WorkloadTaskRefused,
      );
      expect(d.fetcher).not.toHaveBeenCalled();
    },
  );
  it.each(['error', 'extra fields', 'changed deadline', 'expired', 'null'])(
    'refuses %s issuance responses',
    async (kind) => {
      vi.useFakeTimers();
      const d = database((body) => {
        if (kind === 'error') return { error: 'private-db-error' };
        if (kind === 'null') return null;
        if (kind === 'expired') vi.advanceTimersByTime(300001);
        return {
          run_id: id(3),
          expires_at:
            kind === 'changed deadline'
              ? new Date(Date.now() + 1000).toISOString()
              : body.p_expires_at,
          ...(kind === 'extra fields' ? { proof_hash: 'private' } : {}),
        };
      });
      await expect(new WorkloadTaskIssuer(d.db).issue(issue)).rejects.toThrow(WorkloadTaskRefused);
    },
  );
  it('maps all lookup dimensions to RPC and rejects extra/secret response fields and HTTP failures', async () => {
    const f = fixture();
    let reply: unknown = f.row;
    const d = database(() => reply);
    const store = new SupabaseWorkloadTaskStore(d.db);
    const query = {
      tenantId: id(1),
      runId: id(3),
      workloadId: id(2),
      agentName: 'drishti' as const,
      proofHash: digest(bearer),
      scope: 'connector.read',
    };
    expect(await store.load(query)).toEqual(f.row);
    expect(JSON.parse(String(d.fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      p_tenant_id: id(1),
      p_run_id: id(3),
      p_workload_id: id(2),
      p_agent: 'drishti',
      p_proof_hash: digest(bearer),
      p_scope: 'connector.read',
    });
    reply = { ...f.row, proof_hash: 'private' };
    await expect(store.load(query)).rejects.toThrow(WorkloadTaskRefused);
    reply = null;
    expect(await store.load(query)).toBeNull();
    await expect(
      new SupabaseWorkloadTaskStore(database(() => ({ message: 'private-db-error' }), 500).db).load(
        query,
      ),
    ).rejects.toThrow(WorkloadTaskRefused);
  });
  it('requires a positive revocation acknowledgement and bounds lifetime configuration', async () => {
    const good = database(() => ({ revoked: true }));
    await new WorkloadTaskIssuer(good.db).revoke(id(1), id(4), id(3), id(7));
    const bad = database(() => ({ error: 'forbidden' }));
    await expect(new WorkloadTaskIssuer(bad.db).revoke(id(1), id(4), id(3), id(7))).rejects.toThrow(
      WorkloadTaskRefused,
    );
    for (const lifetime of [0, 901, NaN, 1.5])
      expect(() => new WorkloadTaskIssuer(good.db, lifetime)).toThrow();
  });
});
