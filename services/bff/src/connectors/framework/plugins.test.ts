import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ConnectorInvocation } from '@axiom/types';
import {
  buildPluggableRegistry,
  connectorRegistry,
  reviewedDescriptorSources,
} from '../registry.js';
import {
  connectorCatalogue,
  pluginFor,
  sqlPluginFor,
  sqlTargets,
  websitePluginFor,
} from './plugins.js';
import type { SqlSession } from '../sql/postgres-read.js';

const postgresProduction = connectorRegistry.get('41410000-0000-4000-8000-000000000001')!;
const context: ConnectorInvocation = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  estateId: '00000000-0000-4000-8000-000000000002',
  systemId: '00000000-0000-4000-8000-000000000003',
  connectorId: '00000000-0000-4000-8000-000000000004',
  descriptorSha256: 'a'.repeat(64),
  grantId: '00000000-0000-4000-8000-000000000005',
  workloadIdentity: 'spiffe://test/agent/drishti',
  correlationId: '00000000-0000-4000-8000-000000000006',
  deadline: new Date(Date.now() + 30_000).toISOString(),
};

describe('connector plug-in framework', () => {
  it('runs every reviewed descriptor on a registered plug-in', () => {
    for (const manifest of connectorRegistry.values()) expect(pluginFor(manifest)).toBeDefined();
    expect([...sqlTargets].sort()).toEqual(['mariadb', 'mysql', 'postgresql']);
  });

  it('fails closed for a target or transport without a plug-in', () => {
    expect(sqlPluginFor('oracle')).toBeUndefined();
    expect(pluginFor({ ...postgresProduction, target: 'oracle' })).toBeUndefined();
    expect(pluginFor({ ...postgresProduction, transport: 'mcp' })).toBeUndefined();
    expect(() =>
      buildPluggableRegistry([
        JSON.stringify({
          ...postgresProduction,
          id: '41490000-0000-4000-8000-000000000001',
          target: 'oracle',
        }),
      ]),
    ).toThrow('no connector plug-in');
  });

  it('loads only reviewed descriptor file names from its directory, in order', () => {
    const directory = mkdtempSync(join(tmpdir(), 'axiom-descriptors-'));
    writeFileSync(join(directory, 'b-target.yaml'), 'second');
    writeFileSync(join(directory, 'a-target.yaml'), 'first');
    writeFileSync(join(directory, 'notes.txt'), 'ignored');
    writeFileSync(join(directory, 'Upper.yaml'), 'ignored');
    writeFileSync(join(directory, '.hidden.yaml'), 'ignored');
    expect(reviewedDescriptorSources(pathToFileURL(directory + '/'))).toEqual(['first', 'second']);
  });

  it('publishes a non-secret catalogue for every family', () => {
    const catalogue = connectorCatalogue(connectorRegistry);
    expect(catalogue).toHaveLength(connectorRegistry.size);
    expect(new Set(catalogue.map((entry) => entry.family))).toEqual(
      new Set(['sql', 'http', 'website']),
    );
    // An exact field set: no endpoint, credential or tenant data can ride along.
    for (const entry of catalogue)
      expect(Object.keys(entry).sort()).toEqual([
        'assurance',
        'auth',
        'dataCategoryHints',
        'descriptorId',
        'displayName',
        'family',
        'operations',
        'summary',
        'target',
        'targetBinding',
        'transport',
        'version',
      ]);
    expect(catalogue.find((e) => e.target === 'mysql')?.displayName).toBe('MySQL');
  });

  it('binds each MySQL-protocol engine to its own dialect', async () => {
    const statements: string[] = [];
    const sessions = async (): Promise<SqlSession> => ({
      query: async (text) => {
        statements.push(text);
        if (text.includes('as read_only'))
          return { rows: [{ read_only: 1, privileged: 0, can_write: 0 }] };
        return { rows: [] };
      },
      end: async () => undefined,
    });
    await sqlPluginFor('mariadb')!.reader(sessions).enumerate(context);
    expect(statements.join('\n')).toContain('max_statement_time');
    expect(statements.join('\n')).toContain('@@session.tx_read_only');
    expect(statements.join('\n')).toContain("'READ_ONLY ADMIN'");
    expect(statements.join('\n')).not.toContain('regexp_like');
    statements.length = 0;
    await sqlPluginFor('mysql')!.reader(sessions).enumerate(context);
    expect(statements.join('\n')).toContain('max_execution_time');
    expect(statements.join('\n')).toContain("regexp_like(t.table_schema, '^");
    expect(statements.join('\n')).not.toContain('READ_ONLY ADMIN');
  });

  it('runs signed-in website descriptors on the website plug-in', () => {
    const sandbox = connectorRegistry.get('41440000-0000-4000-8000-000000000003')!;
    expect(pluginFor(sandbox)).toMatchObject({
      family: 'website',
      target: 'website-authenticated',
    });
    expect(websitePluginFor('website-authenticated')!.sandboxHost.test('axiom-portal-nimbus')).toBe(
      true,
    );
    expect(websitePluginFor('website-authenticated')!.sandboxHost.test('portal.example.com')).toBe(
      false,
    );
    expect(pluginFor({ ...sandbox, target: 'website-unknown' })).toBeUndefined();
  });

  it('keeps sandbox host policies engine-specific', () => {
    expect(sqlPluginFor('postgresql')!.sandboxHost.test('axiom-pg-kosha-core')).toBe(true);
    expect(sqlPluginFor('mysql')!.sandboxHost.test('axiom-pg-kosha-core')).toBe(false);
    expect(sqlPluginFor('mariadb')!.sandboxHost.test('axiom-mariadb-nimbus-app')).toBe(true);
    expect(sqlPluginFor('mariadb')!.sandboxHost.test('db.example.com')).toBe(false);
  });
});
