import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { BrokerEndpointRegistry, createCredentialBroker } from './configuration.js';
import { BrokerRefused, type BrokerLease } from './broker.js';
const id = (n: number) => `43430000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const config = () => ({
  version: 1,
  provider: 'aws',
  tenants: [
    {
      tenantId: id(1),
      primaryKey: 'arn:aws:kms:ap-south-1:123456789012:key/12345678-1234-1234-1234-123456789012',
      retiringKeys: [],
      endpoints: [
        {
          connectorId: id(3),
          endpointRef: 'crm',
          targetBinding: 'production',
          descriptorSha256: 'a'.repeat(64),
          endpoint: 'https://as.test.invalid/token',
          address: '10.20.30.40',
          timeoutMs: 5000,
        },
      ],
    },
  ],
});
const lease = (): BrokerLease => ({
  tenantId: id(1),
  estateId: id(2),
  connectorId: id(3),
  credentialId: id(5),
  credentialRevision: 1,
  connectorVersion: 1,
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
});
describe('trusted broker configuration', () => {
  it('copies pins and requires every context field to match', () => {
    const source = config();
    const registry = new BrokerEndpointRegistry(source);
    const transport = registry.forLease(lease());
    source.tenants[0]!.endpoints[0]!.endpointRef = 'changed';
    expect(registry.forLease(lease())).toBe(transport);
    for (const patch of [
      { tenantId: id(9) },
      { connectorId: id(9) },
      { endpointRef: 'changed' },
      { targetBinding: 'reference-mock' as const },
      { descriptorSha256: 'b'.repeat(64) },
    ])
      expect(() => registry.forLease({ ...lease(), ...patch })).toThrow(BrokerRefused);
  });
  it('rejects ambiguous tenants, connectors, unknown settings and unsafe pins at startup', () => {
    const tenants = config();
    tenants.tenants.push(tenants.tenants[0]!);
    const connectors = config();
    connectors.tenants[0]!.endpoints.push(connectors.tenants[0]!.endpoints[0]!);
    const unsafe = config();
    unsafe.tenants[0]!.endpoints[0]!.address = '169.254.169.254';
    for (const value of [tenants, connectors, unsafe, { ...config(), fallback: true }])
      expect(() => new BrokerEndpointRegistry(value)).toThrow();
  });
  it('defaults to deny-all without calling database or provider', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const db = createClient('https://db.test.invalid', 'synthetic-service-key', {
      global: { fetch: fetcher },
      auth: { persistSession: false },
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const broker = createCredentialBroker(db, config());
      await expect(
        broker.acquire({
          tenantId: id(1),
          estateId: id(2),
          connectorId: id(3),
          correlationId: id(4),
          scope: 'connector.read',
          workloadProof: 'synthetic',
        }),
      ).rejects.toThrow(BrokerRefused);
      expect(fetcher).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(
        '{"service":"axiom-bff","event":"connector.broker.refused"}\n',
      );
    } finally {
      stderr.mockRestore();
    }
  });
  it('refuses provider key rings outside Mumbai', () => {
    const db = createClient('https://db.test.invalid', 'synthetic-service-key');
    const value = config();
    value.tenants[0]!.primaryKey = value.tenants[0]!.primaryKey.replace('ap-south-1', 'us-east-1');
    expect(() => createCredentialBroker(db, value)).toThrow();
  });
});
