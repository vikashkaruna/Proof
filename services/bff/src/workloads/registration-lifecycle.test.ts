import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { WorkloadRegistrationLifecycle } from './registration-lifecycle.js';
const id = (n: number) => `76760000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = {
  tenantId: id(1),
  actorId: id(2),
  workloadId: id(3),
  correlationId: id(4),
  expectedVersion: 2,
  agent: 'parikshan' as const,
  spiffeId: 'spiffe://axiom.test/agent/parikshan',
  status: 'disabled' as const,
};
const receipt = {
  tenant_id: id(1),
  workload_id: id(3),
  version: 3,
  status: 'disabled',
  receipt: '42',
};
function fixture(value: unknown = receipt) {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }),
  );
  const db = createClient('https://db.test.invalid', 'synthetic', {
    global: { fetch: fetcher },
    auth: { persistSession: false },
  });
  return { fetcher, lifecycle: new WorkloadRegistrationLifecycle(db) };
}
describe('reviewed tenant workload registration lifecycle', () => {
  it('binds the audit receipt to the requested tenant/workload/status and applies a caller deadline', async () => {
    const f = fixture();
    expect(await f.lifecycle.manage(input)).toEqual(receipt);
    const request = f.fetcher.mock.calls[0]![1]!;
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(request.body))).toEqual({
      p_tenant_id: id(1),
      p_actor_id: id(2),
      p_workload_id: id(3),
      p_correlation_id: id(4),
      p_expected_version: 2,
      p_agent: 'parikshan',
      p_spiffe_id: input.spiffeId,
      p_status: 'disabled',
    });
  });
  it('accepts an already recorded matching status receipt after a lost reply', async () => {
    expect(await fixture({ ...receipt, version: 2 }).lifecycle.manage(input)).toHaveProperty(
      'version',
      2,
    );
  });
  it.each([
    { ...receipt, tenant_id: id(9) },
    { ...receipt, workload_id: id(9) },
    { ...receipt, status: 'active' },
    { ...receipt, version: 1 },
    { ...receipt, version: 4 },
    { ...receipt, receipt: '' },
    { ...receipt, private: 'never expose' },
    { error: 'version_conflict', private: 'do not expose' },
    null,
  ])('refuses foreign, stale, malformed or private backend responses', async (value) => {
    await expect(fixture(value).lifecycle.manage(input)).rejects.toThrow(
      'Workload registration change refused',
    );
  });
  it.each([
    { actorId: 'invalid' },
    { expectedVersion: -1 },
    { expectedVersion: 2147483647 },
    { status: 'active' as const, spiffeId: 'spiffe://axiom.test/agent/karya' },
    { status: 'active' as const, spiffeId: input.spiffeId + '\n' },
    { expectedVersion: 0, spiffeId: 'https://untrusted.invalid' },
    { scopes: ['connector.write'] },
  ])('refuses invalid authority and caller-supplied grants before I/O', async (change) => {
    const f = fixture();
    await expect(f.lifecycle.manage({ ...input, ...change })).rejects.toThrow(
      'Workload registration change refused',
    );
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('can disable a preserved legacy binding without rewriting it', async () => {
    const f = fixture();
    expect(
      await f.lifecycle.manage({ ...input, spiffeId: 'spiffe://legacy.test/parikshan' }),
    ).toEqual(receipt);
  });
  it('does not emit database error details', async () => {
    const f = fixture();
    f.fetcher.mockRejectedValue(new Error('synthetic-private-provider-output'));
    await expect(f.lifecycle.manage(input)).rejects.toThrow('Workload registration change refused');
  });
});
