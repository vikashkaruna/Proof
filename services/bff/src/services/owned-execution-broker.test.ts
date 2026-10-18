import { describe, expect, it, vi } from 'vitest';
import { ApprovalEngine } from '@axiom/approval-engine';
import {
  OwnedExecutionBroker,
  ownedOperationId,
  type OwnedExecutionRequest,
} from './owned-execution-broker.js';
const id = (n: number) => `89110000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function fixture() {
  const engine = new ApprovalEngine(Buffer.from('synthetic-unit-test-signing-key-only'));
  const spec = {
    planId: id(2),
    actionIds: [id(3)],
    approverId: id(4),
    mode: 'batch' as const,
    concurrency: 1 as const,
    stopOnFailure: true,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    nonce: 'synthetic-nonce',
    contentDigest: 'a'.repeat(64),
  };
  const token = { spec, signature: await engine.sign(id(1), spec) };
  const input: OwnedExecutionRequest = {
    tenantId: id(1),
    planId: id(2),
    actionId: id(3),
    requestKey: 'owned-request',
    token,
    operation: 'forward',
  };
  const before = { fixture_id: id(8), resource_id: id(9), version: 0, audit_log_enabled: false };
  const current = {
    tenantId: id(1),
    planId: id(2),
    actionId: id(3),
    batchId: id(5),
    bindingId: id(6),
    engagementId: id(7),
    before,
    forward: null as typeof before | null,
    rollback: null as typeof before | null,
  };
  let actual = before;
  const operations = new Map<string, typeof before>();
  const call = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'resolve_owned_execution_target') return current;
    if (name === 'read_owned_synthetic_target') return actual;
    if (name === 'execute_owned_synthetic_action') {
      const operation = ownedOperationId(
        current.batchId,
        current.actionId,
        args.p_operation as 'forward' | 'rollback',
      );
      if (operations.has(operation)) return operations.get(operation);
      actual = {
        ...actual,
        version: actual.version + 1,
        audit_log_enabled: args.p_operation === 'forward',
      };
      operations.set(operation, actual);
      if (args.p_operation === 'forward') current.forward = actual;
      else current.rollback = actual;
      return actual;
    }
    throw Error('Unexpected RPC');
  });
  const identity = {
    verify: vi.fn(async () => ({
      spiffeId: 'spiffe://local.axiomproof.test/agent/karya',
      trustDomain: 'local.axiomproof.test',
      audience: 'axiom-owned-synthetic-execution',
      expiresAt: Date.now() + 300000,
      bundleRevision: 'current',
    })),
  };
  const broker = new OwnedExecutionBroker({
    approval: engine,
    identity,
    target: () => ({
      rpc: (name, args) => ({
        abortSignal: async () => ({ data: await call(name, args), error: null }),
      }),
    }),
  });
  const run = (operation: OwnedExecutionRequest['operation']) =>
    broker.run({ ...input, operation }, 'unit-proof', new AbortController().signal);
  return {
    engine,
    input,
    current,
    call,
    identity,
    broker,
    run,
    operations,
    actual: () => actual,
    setActual: (v: typeof before) => {
      actual = v;
    },
  };
}
describe('owned singleton broker', () => {
  it('performs actual port CAS then independent read and exact retry/rollback IDs', async () => {
    const f = await fixture();
    await f.run('forward');
    expect(f.actual().audit_log_enabled).toBe(true);
    expect(f.actual().version).toBe(1);
    expect(f.call.mock.calls.map((c) => c[0])).toEqual([
      'resolve_owned_execution_target',
      'execute_owned_synthetic_action',
      'read_owned_synthetic_target',
    ]);
    await f.run('forward');
    expect(f.operations.size).toBe(1);
    await f.run('simulate_rollback');
    await f.run('rollback');
    expect(f.actual().audit_log_enabled).toBe(false);
    expect(f.actual().version).toBe(2);
    await f.run('simulate_rollback');
    await f.run('rollback');
    expect(f.operations.size).toBe(2);
    expect(f.actual().version).toBe(2);
    expect(await f.run('verify')).toMatchObject({ checks: [{ outcome: 'passed' }] });
  });
  it('refuses another workload before any SQL', async () => {
    const f = await fixture();
    f.identity.verify.mockResolvedValue({
      ...(await f.identity.verify()),
      spiffeId: 'spiffe://local.axiomproof.test/agent/sudhaar',
    });
    await expect(f.run('forward')).rejects.toThrow();
    expect(f.call).not.toHaveBeenCalled();
  });
  it('refuses forged signed approval before SQL', async () => {
    const f = await fixture();
    f.input.token.signature = 'b'.repeat(64);
    await expect(f.run('forward')).rejects.toThrow();
    expect(f.call).not.toHaveBeenCalled();
  });
  it('refuses mixed action token before SQL', async () => {
    const f = await fixture();
    const raw = {
      ...f.input,
      token: { ...f.input.token, spec: { ...f.input.token.spec, actionIds: [id(3), id(10)] } },
    };
    await expect(f.broker.run(raw, 'proof', new AbortController().signal)).rejects.toThrow();
    expect(f.call).not.toHaveBeenCalled();
  });
  it('refuses unregistered or changed binding without CAS', async () => {
    const f = await fixture();
    f.current.actionId = id(10);
    await expect(f.run('forward')).rejects.toThrow();
    expect(f.operations.size).toBe(0);
  });
  it('cannot undo before a retained original forward', async () => {
    const f = await fixture();
    await expect(f.run('rollback')).rejects.toThrow();
    expect(f.operations.size).toBe(0);
  });
  it('does not report write success when independent readback differs', async () => {
    const f = await fixture();
    f.call.mockImplementation(async (name) =>
      name === 'resolve_owned_execution_target'
        ? f.current
        : name === 'execute_owned_synthetic_action'
          ? { ...f.current.before, version: 1, audit_log_enabled: true }
          : f.current.before,
    );
    await expect(f.run('forward')).rejects.toThrow('unconfirmed');
  });
  it('verification fails on stale state rather than trusting operation response', async () => {
    const f = await fixture();
    await f.run('forward');
    f.setActual({ ...f.current.before, version: 99 });
    expect(await f.run('verify')).toMatchObject({ checks: [{ outcome: 'failed' }] });
  });
  it('allows signature verification for consumed nonce while exact SQL gates remain', async () => {
    const f = await fixture();
    f.engine.markNonceUsed(f.input.token.spec.nonce);
    await f.run('forward');
    expect(f.operations.size).toBe(1);
  });
  it('derives deterministic distinct batch/action/kind operation IDs', () => {
    const first = ownedOperationId(id(1), id(2), 'forward');
    expect(first).toBe('9f5d97bf-30fc-8a17-bc46-ebfaf6ca5b68');
    expect(first).toBe(ownedOperationId(id(1), id(2), 'forward'));
    expect(
      new Set([
        first,
        ownedOperationId(id(1), id(2), 'rollback'),
        ownedOperationId(id(3), id(2), 'forward'),
        ownedOperationId(id(1), id(3), 'forward'),
      ]).size,
    ).toBe(4);
    expect(first).toMatch(/^[a-f0-9-]{14}8/);
  });
});
