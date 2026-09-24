import { createClient } from '@supabase/supabase-js';
import { AGENT_CONTRACTS, type AgentName } from '@axiom/types';
import { describe, expect, it, vi } from 'vitest';
import { WorkloadIdentityRefused } from './jwt-svid.js';
import {
  WorkloadAuthenticator,
  SupabaseWorkloadRegistrationStore,
  type WorkloadRegistrationStore,
} from './registration.js';
const tenant = '46460000-0000-4000-8000-000000000001';
const workload = '46460000-0000-4000-8000-000000000002';
function fixture(agent: AgentName = 'drishti') {
  const identity = {
    spiffeId: `spiffe://local.axiomproof.test/agent/${agent}`,
    trustDomain: 'local.axiomproof.test',
    audience: 'axiom-credential-broker',
    expiresAt: Date.now() + 60000,
    bundleRevision: 'current',
  };
  const verifier = { verify: vi.fn(async () => identity) };
  const row = {
    id: workload,
    tenant_id: tenant,
    agent_name: agent,
    spiffe_id: identity.spiffeId,
    status: 'active' as const,
  };
  const store = { find: vi.fn<WorkloadRegistrationStore['find']>(async () => row) };
  return { identity, row, verifier, store, auth: new WorkloadAuthenticator(verifier, store) };
}
describe('live workload registration and declared scope checks', () => {
  it('looks up exact verified identity in the requested tenant and returns immutable metadata', async () => {
    const f = fixture();
    const principal = await f.auth.authenticate(
      'synthetic-proof',
      tenant,
      'drishti',
      'connector.read',
    );
    expect(f.store.find).toHaveBeenCalledWith(tenant, f.identity.spiffeId);
    expect(principal.agentName).toBe('drishti');
    expect(principal.workloadId).toBe(workload);
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal.declaredScopes)).toBe(true);
    expect(JSON.stringify(principal)).not.toContain('synthetic-proof');
  });
  it.each(Object.keys(AGENT_CONTRACTS) as AgentName[])(
    'checks the ten-agent connector matrix (%s)',
    async (agent) => {
      const f = fixture(agent);
      for (const scope of ['connector.read', 'connector.write']) {
        const attempt = f.auth.authenticate('synthetic-proof', tenant, agent, scope);
        if (
          (agent === 'drishti' && scope === 'connector.read') ||
          (agent === 'karya' && scope === 'connector.write')
        )
          await expect(attempt).resolves.toHaveProperty('agentName', agent);
        else await expect(attempt).rejects.toThrow(WorkloadIdentityRefused);
      }
    },
  );
  it('checks every declared permission and refuses undeclared control-library writes', async () => {
    for (const agent of Object.keys(AGENT_CONTRACTS) as AgentName[]) {
      const f = fixture(agent);
      for (const scope of AGENT_CONTRACTS[agent].toolScopes)
        await expect(f.auth.authenticate('proof', tenant, agent, scope)).resolves.toHaveProperty(
          'agentName',
          agent,
        );
      await expect(
        f.auth.authenticate('proof', tenant, agent, 'control_library.write'),
      ).rejects.toThrow(WorkloadIdentityRefused);
    }
  });
  it('does not let caller-selected agent names override the verified registration', async () => {
    const f = fixture('sudhaar');
    await expect(f.auth.authenticate('proof', tenant, 'karya', 'connector.write')).rejects.toThrow(
      WorkloadIdentityRefused,
    );
    expect(f.store.find).toHaveBeenCalled();
  });
  it('refuses tenant/subject/expiry changes and repeats registration lookup after disablement', async () => {
    const f = fixture();
    await f.auth.authenticate('proof', tenant, 'drishti', 'connector.read');
    f.store.find.mockResolvedValue(null);
    await expect(f.auth.authenticate('proof', tenant, 'drishti', 'connector.read')).rejects.toThrow(
      WorkloadIdentityRefused,
    );
    for (const row of [
      { ...f.row, tenant_id: workload },
      { ...f.row, spiffe_id: 'spiffe://local.axiomproof.test/other' },
    ]) {
      f.store.find.mockResolvedValue(row);
      await expect(
        f.auth.authenticate('proof', tenant, 'drishti', 'connector.read'),
      ).rejects.toThrow(WorkloadIdentityRefused);
    }
    f.store.find.mockResolvedValue(f.row);
    f.identity.expiresAt = Date.now() - 1;
    await expect(f.auth.authenticate('proof', tenant, 'drishti', 'connector.read')).rejects.toThrow(
      WorkloadIdentityRefused,
    );
  });
  it('sanitizes registration failure and refuses malformed tenant context', async () => {
    const f = fixture();
    await expect(
      f.auth.authenticate('proof', 'invalid', 'drishti', 'connector.read'),
    ).rejects.toThrow(WorkloadIdentityRefused);
    expect(f.verifier.verify).not.toHaveBeenCalled();
    f.store.find.mockRejectedValue(new Error('private-db-error'));
    await expect(f.auth.authenticate('proof', tenant, 'drishti', 'connector.read')).rejects.toThrow(
      'Workload identity was refused.',
    );
  });
  it('scopes PostgREST by tenant, exact subject and active status, and fails closed on corrupt rows', async () => {
    const f = fixture();
    let value: unknown = f.row;
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }),
    );
    const db = createClient('https://db.test.invalid', 'synthetic-key', {
      global: { fetch: fetcher },
      auth: { persistSession: false },
    });
    const store = new SupabaseWorkloadRegistrationStore(db);
    expect(await store.find(tenant, f.identity.spiffeId)).toEqual(f.row);
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.get('tenant_id')).toBe('eq.' + tenant);
    expect(url.searchParams.get('spiffe_id')).toBe('eq.' + f.identity.spiffeId);
    expect(url.searchParams.get('status')).toBe('eq.active');
    value = { ...f.row, status: 'disabled' };
    await expect(store.find(tenant, f.identity.spiffeId)).rejects.toThrow(WorkloadIdentityRefused);
    value = null;
    expect(await store.find(tenant, f.identity.spiffeId)).toBeNull();
  });
});
