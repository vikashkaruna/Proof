import { describe, it, expect } from 'vitest';
import {
  ConnectorManifestSchema,
  CreateConnectorRequestSchema,
  Capability,
  rolesWith,
} from '@axiom/types';
import { buildRegistry, connectorRegistry, loadDescriptor } from './registry.js';
const production = [...connectorRegistry.values()][0]!;
const reference = [...connectorRegistry.values()][1]!;
describe('reviewed descriptor registry', () => {
  it('loads production and explicitly non-production descriptors', () => {
    expect(production.capabilities.write?.requiresApprovalToken).toBe(true);
    expect(reference.targetBinding).toBe('reference-mock');
    expect(reference.capabilities.write).toBeUndefined();
  });
  it.each([
    { ...production, targetBinding: 'sandbox' },
    { ...production, auth: 'legacy_static' },
    { ...production, assurance: 'low' },
    { ...production, version: 'latest' },
    { ...production, id: '00000000-0000-0000-0000-000000000000' },
    { ...production, id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' },
    { ...production, password: 'secret' },
    {
      ...production,
      capabilities: {
        ...production.capabilities,
        write: { operation: 'sql.write', mutating: true },
      },
    },
    {
      ...production,
      capabilities: { enumerate: { operation: 'DROP TABLE secrets', mutating: false } },
    },
    { ...production, rateLimit: { requestsPerSecond: 0, burst: 1 } },
  ])('refuses unsafe/incomplete manifests %#', (input) => {
    expect(ConnectorManifestSchema.safeParse(input).success).toBe(false);
  });
  it.each([
    'a: 1\na: 2',
    'a: &anchor {}\nb: *anchor',
    '---\na: 1\n---\nb: 2',
    'a: !custom foo',
    'x'.repeat(65537),
  ])('rejects unsafe YAML %#', (source) => {
    expect(() => loadDescriptor(source)).toThrow();
  });
  it('refuses duplicate identities or versions', () => {
    const source = JSON.stringify(production);
    expect(() => buildRegistry([source, source])).toThrow('Duplicate');
    expect(() =>
      buildRegistry([source, JSON.stringify({ ...production, id: reference.id })]),
    ).toThrow('Duplicate');
  });
  it('rejects ambiguous numeric YAML scalars', () => {
    expect(() => loadDescriptor('rateLimit: { burst: 010 }')).toThrow('decimal integers');
  });
  it('accepts only non-secret endpoint references and refuses injected scope', () => {
    const base = {
      systemId: production.id,
      descriptorId: production.id,
      name: 'CRM',
      endpointRef: 'primary_crm',
    };
    expect(CreateConnectorRequestSchema.safeParse(base).success).toBe(true);
    for (const endpointRef of [
      'postgres://user:password@host/db',
      'https://host',
      'Bearer secret',
      '../secret',
    ])
      expect(CreateConnectorRequestSchema.safeParse({ ...base, endpointRef }).success).toBe(false);
    expect(
      CreateConnectorRequestSchema.safeParse({ ...base, tenantId: production.id }).success,
    ).toBe(false);
  });
  it('limits lifecycle management to owner/admin/founder', () => {
    expect(rolesWith(Capability.CONNECTOR_MANAGE).sort()).toEqual(['admin', 'founder', 'owner']);
  });
});
