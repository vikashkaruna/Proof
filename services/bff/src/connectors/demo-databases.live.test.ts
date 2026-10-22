import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConnectorInvocation } from '@axiom/types';
import { sqlPluginFor } from './framework/plugins.js';

// Live check of every SQL plug-in against its synthetic demo database
// (scripts/local-demo-databases.py up). Runs the real session factory: TLS
// verified against the local demo CA, the least-privilege account, and the
// plug-in's read-only adapter. Skipped unless the protected state directory
// is supplied, e.g. AXIOM_DEMO_DATABASES_DIR=<repo>/.axiom-runtime/demo-targets.
const state = process.env.AXIOM_DEMO_DATABASES_DIR;

const targets = [
  {
    name: 'axiom-pg-kosha-core',
    target: 'postgresql',
    port: 57551,
    database: 'kosha_core',
    tables: ['core.accounts', 'core.branches', 'core.customers', 'core.loans', 'core.nominees'],
    sample: 'core.customers',
    detected: { email: 200, phone_in: 200, pan: 200, aadhaar_like: 200 },
    freeText: { resource: 'core.service_notes', column: 'notes', shape: 'phone_in' },
  },
  {
    name: 'axiom-mysql-sanjeevani-his',
    target: 'mysql',
    port: 57552,
    database: 'his',
    tables: ['his.diagnoses', 'his.guardians', 'his.patients', 'his.staff', 'his.wards'],
    sample: 'his.patients',
    detected: { email: 200, phone_in: 200, aadhaar_like: 200 },
    freeText: { resource: 'his.appointment_notes', column: 'notes', shape: 'email' },
  },
  {
    name: 'axiom-mariadb-nimbus-app',
    target: 'mariadb',
    port: 57553,
    database: 'app',
    tables: ['app.billing_profiles', 'app.marketing_consents', 'app.support_tickets', 'app.users'],
    sample: 'app.users',
    detected: { email: 200, phone_in: 200 },
    freeText: { resource: 'app.billing_profiles', column: 'company_pan', shape: 'pan' },
  },
] as const;

const context = (): ConnectorInvocation => ({
  tenantId: '00000000-0000-4000-8000-000000000001',
  estateId: '00000000-0000-4000-8000-000000000002',
  systemId: '00000000-0000-4000-8000-000000000003',
  connectorId: '00000000-0000-4000-8000-000000000004',
  descriptorSha256: 'a'.repeat(64),
  grantId: '00000000-0000-4000-8000-000000000005',
  workloadIdentity: 'spiffe://local.axiomproof.test/agent/drishti',
  correlationId: '00000000-0000-4000-8000-000000000006',
  deadline: new Date(Date.now() + 30_000).toISOString(),
});

describe.skipIf(!state).each(targets)('$target demo database ($name)', (demo) => {
  const plugin = sqlPluginFor(demo.target)!;
  const reader = (user: string, caFile = 'ca.pem') =>
    plugin.reader(
      plugin.sessions({
        endpoint: () => ({
          host: 'localhost',
          port: demo.port,
          database: demo.database,
          user,
          region: 'ap-south-1',
          caPem: readFileSync(join(state!, demo.name, 'tls', caFile), 'utf8'),
        }),
        credentials: {
          password: async () =>
            readFileSync(join(state!, demo.name, `${user}.password`), 'utf8').trim(),
        },
      }),
    );

  it('enumerates the synthetic catalogue over verified TLS as the read-only account', async () => {
    const { records } = await reader('axiom_discovery_ro').enumerate(context());
    const resources = records.map((r) => String(r.resource));
    for (const table of demo.tables) expect(resources).toContain(table);
    const sampled = records.find((r) => r.resource === demo.sample) as {
      categoryHints: string[];
    };
    expect(sampled.categoryHints).toEqual(expect.arrayContaining(['contact']));
  });

  it('profiles a sample by value shape without returning a value', async () => {
    const { records } = await reader('axiom_discovery_ro').sample(context(), demo.sample, 200);
    const detected = Object.assign(
      {},
      ...records.map((r) => r.detected as Record<string, number>),
    ) as Record<string, number>;
    expect(detected).toMatchObject(demo.detected);
    expect(JSON.stringify(records)).not.toMatch(/@example\.in/);
    const free = await reader('axiom_discovery_ro').sample(context(), demo.freeText.resource, 200);
    const column = free.records.find((r) => r.column === demo.freeText.column) as {
      detected: Record<string, number>;
      categoryHints: string[];
    };
    expect(column.categoryHints).toEqual([]);
    expect(column.detected[demo.freeText.shape]).toBeGreaterThan(0);
  });

  it('refuses the over-privileged account before reading', async () => {
    await expect(reader('axiom_overprivileged').enumerate(context())).rejects.toMatchObject({
      reason: 'write_privilege',
    });
  });

  it('refuses a server certificate the pinned CA did not issue', async () => {
    await expect(
      plugin
        .reader(
          plugin.sessions({
            endpoint: () => ({
              host: 'localhost',
              port: demo.port,
              database: demo.database,
              user: 'axiom_discovery_ro',
              region: 'ap-south-1',
              caPem: readFileSync(join(state!, demo.name, 'tls', 'server.crt'), 'utf8'),
            }),
            credentials: { password: async () => 'never-used' },
          }),
        )
        .enumerate(context()),
    ).rejects.toThrow();
  });
});
