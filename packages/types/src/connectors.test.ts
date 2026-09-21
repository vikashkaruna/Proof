import { describe, expect, it } from 'vitest';
import { ConnectorGrantSchema, ConnectorSchema, McpToolRegistrationSchema } from './connectors';
const id = '00000000-0000-4000-8000-000000000001';
const createdAt = '2026-09-21T10:00:00Z';
const grant = {
  id,
  tenantId: id,
  connectorId: id,
  workloadIdentityId: id,
  agentName: 'drishti',
  internalScope: 'connector.read',
  targetScopes: ['catalogue:read'],
  additionalConfirmationRequired: true,
  createdAt,
  expiresAt: '2026-09-21T11:00:00Z',
  revokedAt: null,
};
describe('connector authority metadata', () => {
  it('permits the accepted two-agent split and refuses planner/client access', () => {
    expect(ConnectorGrantSchema.safeParse(grant).success).toBe(true);
    expect(
      ConnectorGrantSchema.safeParse({
        ...grant,
        agentName: 'karya',
        internalScope: 'connector.write',
      }).success,
    ).toBe(true);
    for (const agentName of [
      'sudhaar',
      'nazar',
      'vibhaag',
      'parikshan',
      'saakshi',
      'lekha',
      'prativedan',
      'sanket',
    ]) {
      for (const internalScope of ['connector.read', 'connector.write']) {
        expect(ConnectorGrantSchema.safeParse({ ...grant, agentName, internalScope }).success).toBe(
          false,
        );
      }
    }
    expect(
      ConnectorGrantSchema.safeParse({ ...grant, internalScope: 'connector.write' }).success,
    ).toBe(false);
  });
  it('rejects unbounded or reversed grant lifetimes', () => {
    expect(ConnectorGrantSchema.safeParse({ ...grant, expiresAt: undefined }).success).toBe(false);
    expect(ConnectorGrantSchema.safeParse({ ...grant, expiresAt: createdAt }).success).toBe(false);
    expect(
      ConnectorGrantSchema.safeParse({ ...grant, revokedAt: '2026-09-20T10:00:00Z' }).success,
    ).toBe(false);
  });
  it('requires explicit target provenance instead of assuming production', () => {
    const connector = {
      id,
      tenantId: id,
      systemId: id,
      descriptorId: id,
      name: 'Database',
      endpointRef: 'local-fixture',
      assurance: 'high',
      status: 'draft',
      version: 1,
      updatedAt: '2026-09-22T00:00:00Z',
      createdAt,
    };
    expect(ConnectorSchema.safeParse(connector).success).toBe(false);
    expect(
      ConnectorSchema.safeParse({ ...connector, targetBinding: 'reference-mock' }).success,
    ).toBe(true);
  });
  it('refuses an unclassified tool', () => {
    const tool = {
      id,
      tenantId: id,
      connectorId: id,
      toolName: 'list',
      toolVersion: '1',
      description: 'Metadata',
      descriptionSha256: 'a'.repeat(64),
      inputSchema: {},
      createdAt,
    };
    expect(McpToolRegistrationSchema.safeParse(tool).success).toBe(false);
    expect(McpToolRegistrationSchema.safeParse({ ...tool, operationClass: 'read' }).success).toBe(
      true,
    );
  });
});
