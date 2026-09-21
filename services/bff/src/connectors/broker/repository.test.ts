import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { LedgerBrokerAudit, SupabaseBrokerCredentialStore } from './repository.js';
import { BrokerRefused, type BrokerLease } from './broker.js';
import type { LedgerClient } from '@axiom/ledger';
const id = (n: number) => `43430000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const lease: BrokerLease = {
  tenantId: id(1),
  estateId: id(2),
  connectorId: id(3),
  credentialId: id(5),
  credentialRevision: 2,
  connectorVersion: 3,
  grantId: id(6),
  workloadId: id(7),
  agentName: 'drishti',
  spiffeId: 'spiffe://test.invalid/agent/drishti',
  scope: 'connector.read',
  targetScopes: ['inventory.read'],
  validUntil: Date.now() + 600000,
  descriptorSha256: 'a'.repeat(64),
  endpointRef: 'crm',
  targetBinding: 'production',
  grantType: 'client_credentials',
};
const row = () => ({
  format_version: 1,
  algorithm: 'aes-256-gcm',
  key_ref: 'fixture/key',
  nonce: '\\x' + '01'.repeat(12),
  ciphertext: '\\x' + '02'.repeat(20),
  wrapped_data_key: '\\x' + '03'.repeat(32),
});
function fixture(value: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  const db = createClient('https://db.test.invalid', 'synthetic-service-key', {
    global: { fetch: fetcher },
    auth: { persistSession: false },
  });
  return { fetcher, store: new SupabaseBrokerCredentialStore(db) };
}
describe('broker credential repository and audit', () => {
  it('uses the service-only snapshot RPC with exact context and optimistic versions', async () => {
    const f = fixture(row());
    const envelope = await f.store.load(lease);
    expect(envelope.nonce).toEqual(Buffer.alloc(12, 1));
    const [url, init] = f.fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://db.test.invalid/rest/v1/rpc/read_broker_credential');
    expect(JSON.parse(String(init?.body))).toEqual({
      p_tenant_id: id(1),
      p_estate_id: id(2),
      p_connector_id: id(3),
      p_credential_id: id(5),
      p_connector_version: 3,
      p_credential_revision: 2,
      p_descriptor_sha256: 'a'.repeat(64),
      p_endpoint_ref: 'crm',
      p_target_binding: 'production',
      p_grant_type: 'client_credentials',
    });
    expect(await f.store.stillCurrent(lease)).toBe(true);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    null,
    { ...row(), format_version: 0 },
    { ...row(), nonce: '\\x12' },
    { ...row(), ciphertext: 'plaintext' },
    { ...row(), wrapped_data_key: '\\x' },
  ])('fails closed for missing or malformed encrypted rows', async (value) => {
    const f = fixture(value);
    await expect(f.store.load(lease)).rejects.toThrow(BrokerRefused);
    expect(await f.store.stillCurrent(lease)).toBe(false);
  });
  it('sanitizes database failures', async () => {
    const f = fixture({ message: 'private-provider-diagnostic' }, 500);
    await expect(f.store.load(lease)).rejects.toThrow(
      'Connector credential acquisition was refused.',
    );
    expect(await f.store.stillCurrent(lease)).toBe(false);
  });
  it('appends only allowlisted metadata for each phase and sanitizes ledger failures', async () => {
    const append = vi.fn<LedgerClient['append']>(async () => ({
      id: id(8),
      sequenceNo: 1,
      entryHash: 'a'.repeat(64),
      occurredAt: new Date().toISOString(),
    }));
    const audit = new LedgerBrokerAudit({ append });
    const polluted = {
      ...lease,
      workloadProof: 'private-proof',
      clientSecret: 'private-secret',
      access_token: 'private-token',
    };
    for (const phase of ['requested', 'acquired', 'denied'] as const)
      await audit.write(phase, polluted, id(4), 1000);
    expect(append.mock.calls.map(([entry]) => entry.actionType)).toEqual([
      'connector.token_requested',
      'connector.token_acquired',
      'connector.token_denied',
    ]);
    expect(append.mock.calls.map(([entry]) => entry.result)).toEqual([
      'pending',
      'success',
      'failure',
    ]);
    expect(JSON.stringify(append.mock.calls)).not.toContain('private-');
    expect(append.mock.calls[0]![0].detail).toMatchObject({
      credentialRevision: 2,
      connectorVersion: 3,
      expiresAt: '1970-01-01T00:00:01.000Z',
    });
    append.mockRejectedValueOnce(new Error('private-ledger-error'));
    await expect(audit.write('acquired', lease, id(4))).rejects.toThrow(BrokerRefused);
  });
});
