import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectorManifestSchema, type ConnectorInvocation } from '@axiom/types';
import { AcquiredToken } from '../broker/oauth-grants.js';
import { GraphqlReadConnector, discoveryQuery } from './graphql-read.js';

const TOKEN = 'reference-graphql-bearer';
const context = (ms = 30_000): ConnectorInvocation => ({
  tenantId: 't',
  estateId: 'e',
  systemId: 's',
  connectorId: 'c',
  descriptorSha256: 'a'.repeat(64),
  grantId: 'g',
  workloadIdentity: 'spiffe://test/agent/drishti',
  correlationId: 'r',
  deadline: new Date(Date.now() + ms).toISOString(),
});
const manifest = ConnectorManifestSchema.parse({
  schemaVersion: 1,
  id: '41410000-0000-4000-8000-000000000021',
  target: 'code-repository',
  version: '1.0.0',
  transport: 'graphql',
  targetBinding: 'reference-mock',
  auth: 'oauth2.client_credentials',
  assurance: 'high',
  provenance: 'reference',
  capabilities: {
    enumerate: { operation: 'graphql.enumerate', mutating: false },
    sample: { operation: 'graphql.sample', mutating: false },
  },
  dataCategoryHints: ['contact'],
  rateLimit: { requestsPerSecond: 5, burst: 10 },
  graphql: {
    path: '/graphql',
    resources: {
      members: {
        root: 'members',
        pageSizeArg: 'first',
        cursorArg: 'after',
        itemsPath: ['nodes'],
        cursorPath: ['pageInfo', 'endCursor'],
        fields: ['login', 'email', 'profile.phone'],
      },
    },
  },
});
const members = [
  { login: 'asha', email: 'asha@example.in', profile: { phone: '9876543210' } },
  { login: 'ravi', email: null, profile: { phone: 'n/a' } },
];
const bodies: { query: string; variables: Record<string, unknown> }[] = [];
let server: Server;
let origin: string;
let mode: 'ok' | 'errors' = 'ok';

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.statusCode = 401;
        return res.end('{}');
      }
      const body = JSON.parse(raw);
      bodies.push(body);
      if (mode === 'errors')
        return res.end(JSON.stringify({ errors: [{ message: 'secret detail asha@example.in' }] }));
      const start = body.variables.cursor === 'c2' ? 1 : 0;
      const page = members.slice(start, start + body.variables.limit);
      res.end(
        JSON.stringify({
          data: {
            members: {
              nodes: page,
              pageInfo: { endCursor: start + page.length < members.length ? 'c2' : null },
            },
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const loopback = (input: string, init: RequestInit) => {
  const url = new URL(input);
  expect(url.href).toBe('https://git.reference.axiom.test/graphql');
  return fetch(`${origin}${url.pathname}`, init);
};
const connector = () =>
  new GraphqlReadConnector(
    manifest,
    { baseUrl: 'https://git.reference.axiom.test/' },
    async () => new AcquiredToken(TOKEN, ['read:org'], Date.now() + 60_000),
    loopback,
  );

describe('GraphqlReadConnector (W4.7)', () => {
  it('generates a single read-only query from the declared selection', () => {
    expect(discoveryQuery(manifest.graphql!.resources.members!)).toBe(
      'query AxiomDiscovery($limit: Int!, $cursor: String) { members(first: $limit, after: $cursor) { nodes { login email profile { phone } } pageInfo { endCursor } } }',
    );
  });

  it('enumerates observed fields and reports declared fields that are missing', async () => {
    const { records } = await connector().enumerate(context());
    expect(records).toEqual([
      { resource: 'members', fields: ['email', 'login', 'profile.phone'], missing: [] },
    ]);
    expect(bodies.at(-1)?.variables).toEqual({ limit: 5 });
  });

  it('profiles declared fields by shape only and pages with variables', async () => {
    const first = await connector().sample(context(), 'members', 1);
    expect(first.cursor).toBe('c2');
    const byField = Object.fromEntries(first.records.map((r) => [r.field, r]));
    expect(byField.email).toMatchObject({ detected: { email: 1 } });
    expect(byField['profile.phone']).toMatchObject({ detected: { phone_in: 1 } });
    const second = await connector().sample(context(), 'members', 1, 'c2');
    expect(bodies.at(-1)?.variables).toEqual({ limit: 1, cursor: 'c2' });
    expect(second.cursor).toBeUndefined();
    const serialized = JSON.stringify([first, second]);
    for (const raw of ['asha@example.in', '9876543210', 'asha', TOKEN])
      expect(serialized).not.toContain(raw);
  });

  it('refuses GraphQL errors, bad input and unsafe descriptors', async () => {
    mode = 'errors';
    const refusal = await connector()
      .sample(context(), 'members', 1)
      .catch((error: Error) => error);
    mode = 'ok';
    expect(refusal).toMatchObject({ reason: 'graphql_errors' });
    expect(String((refusal as Error).message)).not.toContain('asha');
    await expect(connector().sample(context(), 'constructor', 1)).rejects.toMatchObject({
      reason: 'resource',
    });
    await expect(connector().sample(context(), 'members', 1, '"}){x}')).rejects.toMatchObject({
      reason: 'cursor',
    });
    await expect(connector().enumerate(context(-1))).rejects.toMatchObject({ reason: 'deadline' });
    await expect(connector().read()).rejects.toMatchObject({ reason: 'raw_read_disabled' });
    const members = manifest.graphql!.resources.members!;
    const parse = (resource: Record<string, unknown>) =>
      ConnectorManifestSchema.parse({
        ...manifest,
        graphql: { path: '/graphql', resources: { members: { ...members, ...resource } } },
      });
    for (const bad of [
      { root: 'members { secrets }' },
      { root: 'mutation' + ' x(' },
      { fields: ['email', 'email'] },
      { fields: ['a.b.c.d'] },
      { fields: ['email } } mutation { drop'] },
      { cursorPath: undefined },
    ])
      expect(() => parse(bad)).toThrow();
    expect(() => ConnectorManifestSchema.parse({ ...manifest, graphql: undefined })).toThrow();
  });
});
