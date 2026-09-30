/** W9 component probe. Requires an isolated local PostgreSQL database named
 * axiom_w9_probe. Never point this at customer or shared databases. */
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { renderHtmlToPdf } from '@axiom/report-kit/renderer';
import { DiscoveryService } from '../src/connectors/discovery.js';
import { createFakeDb } from '../src/test/fake-postgrest.js';

const urlText = process.env.AXIOM_W9_DISPOSABLE_URL;
if (!urlText || process.env.AXIOM_W9_DISPOSABLE !== '1')
  throw new Error(
    'Set AXIOM_W9_DISPOSABLE=1 and AXIOM_W9_DISPOSABLE_URL for an isolated local database',
  );
const url = new URL(urlText);
if (url.pathname !== '/axiom_w9_probe' || !['localhost', '127.0.0.1'].includes(url.hostname))
  throw new Error('W9 probe refuses non-local or non-dedicated databases');

const tenantId = '11111111-1111-4111-8111-111111111111';
const estateId = '22222222-2222-4222-8222-222222222222';
const connectorId = '33333333-3333-4333-8333-333333333333';
const descriptorId = '41410000-0000-4000-8000-000000000001';
const spiffeId = 'spiffe://axiom.test/agent/drishti';
const password = randomBytes(24).toString('hex');
const admin = new pg.Client({ connectionString: urlText });
const readerUrl = new URL(urlText);
readerUrl.username = 'w9_probe_reader';
readerUrl.password = password;
let createdSchema = false;
let createdRole = false;

function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  return work().then((value) => ({
    value,
    ms: Math.round((performance.now() - start) * 100) / 100,
  }));
}

try {
  await admin.connect();
  await admin.query('create schema w9_probe');
  createdSchema = true;
  await admin.query(
    'create table w9_probe.records (id bigint primary key, category text not null)',
  );
  const load = await timed(() =>
    admin.query(
      "insert into w9_probe.records select n, case when n % 2 = 0 then 'even' else 'odd' end from generate_series(1, 1000000) n",
    ),
  );
  await admin.query('analyze w9_probe.records');
  await admin.query(`create role w9_probe_reader login password '${password}'`);
  createdRole = true;
  await admin.query('grant usage on schema w9_probe to w9_probe_reader');
  await admin.query('grant select on w9_probe.records to w9_probe_reader');
  const counted = await admin.query('select count(*)::int as count from w9_probe.records');
  const rowCount = Number(counted.rows[0].count);
  if (rowCount !== 1_000_000) throw new Error('Fixture row count mismatch');

  const fake = createFakeDb({
    connectors: [
      { id: connectorId, tenant_id: tenantId, descriptor_id: descriptorId, status: 'active' },
    ],
  });
  fake.onRpc('resolve_sql_read_grant', () => ({
    grantId: '55555555-5555-4555-8555-555555555555',
    workloadId: '66666666-6666-4666-8666-666666666666',
    agentName: 'drishti',
    spiffeId,
    systemId: '77777777-7777-4777-8777-777777777777',
    grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    connectorVersion: 1,
    descriptorSha256: 'b'.repeat(64),
    endpointRef: 'w9_probe',
    targetBinding: 'reference-mock',
  }));
  fake.onRpc('record_connector_discovery', () => ({ run: { id: 'w9-probe-run' } }));
  const discovery = new DiscoveryService(
    {
      sql: [
        {
          tenantId,
          connectorId,
          endpoint: {
            host: 'localhost',
            port: Number(url.port),
            database: 'axiom_w9_probe',
            user: 'w9_probe_reader',
            region: 'ap-south-1',
            caPem: 'probe',
          },
        },
      ],
    },
    {
      identity: {
        verify: async () => ({
          spiffeId,
          trustDomain: 'axiom.test',
          audience: 'w9-probe',
          expiresAt: Date.now() + 60_000,
          bundleRevision: 'w9-probe',
        }),
      },
      sqlSessions: async () => {
        const client = new pg.Client({ connectionString: readerUrl.toString() });
        await client.connect();
        return {
          query: (text, values) => client.query(text, values ? [...values] : undefined),
          end: () => client.end(),
        };
      },
      client: () => fake.client as never,
    },
  );
  const enumeration = await timed(() =>
    discovery.run({ tenantId, estateId, connectorId, operation: 'enumerate' }, 'probe-svid'),
  );
  const sample = await timed(() =>
    discovery.run(
      {
        tenantId,
        estateId,
        connectorId,
        operation: 'sample',
        resource: 'w9_probe.records',
        limit: 200,
      },
      'probe-svid',
    ),
  );
  const sampledCounts = sample.value.records.map((record) => Number(record.sampled));
  if (
    !enumeration.value.records.some((record) => record.resource === 'w9_probe.records') ||
    sampledCounts.length !== 2 ||
    sampledCounts.some((count) => count !== 200)
  )
    throw new Error('Discovery result did not match fixture');

  const html = `<!doctype html><html><head><title>W9 PDF renderer probe</title></head><body>
    <h1>W9 PDF renderer probe</h1><p>Synthetic performance fixture; no compliance claims or approval.</p>
    <table>${Array.from({ length: 100 }, (_, i) => `<tr><td>Fixture row ${i + 1}</td><td>Assessment-derived content placeholder</td></tr>`).join('')}</table>
    </body></html>`;
  const pdf = await timed(() =>
    renderHtmlToPdf(html, {
      requireChromium: true,
      documentDate: '2026-09-30T00:00:00.000Z',
      timeoutMs: 30_000,
    }),
  );
  if (pdf.value.renderer !== 'chromium') throw new Error('Renderer fallback is forbidden');
  process.stdout.write(
    `${JSON.stringify(
      {
        probe: 'w9-live-components-v1',
        fixtureRows: rowCount,
        fixtureLoadMs: load.ms,
        discovery: {
          postgres: true,
          authorization: 'mock',
          recording: 'mock',
          enumerateMs: enumeration.ms,
          sampleMs: sample.ms,
          sampleLimit: 200,
          sampledDistinctRows: 200,
          rawReadAvailable: false,
        },
        report: {
          renderer: pdf.value.renderer,
          rendererMs: pdf.ms,
          pdfBytes: pdf.value.byteLength,
          sourceBoundReport: false,
          founderReview: false,
          retainedArtifact: false,
        },
        nfr7: 'UNVERIFIED',
        nfr8: 'UNVERIFIED',
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (createdSchema) {
    try {
      await admin.query('drop schema w9_probe cascade');
    } catch {
      /* preserve original failure */
    }
  }
  if (createdRole) {
    try {
      await admin.query('drop role w9_probe_reader');
    } catch {
      /* preserve original failure */
    }
  }
  await admin.end().catch(() => {});
}
