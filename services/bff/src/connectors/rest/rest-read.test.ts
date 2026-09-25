import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectorInvocation, ConnectorManifest } from '@axiom/types';
import { ConnectorManifestSchema } from '@axiom/types';
import { AcquiredToken } from '../broker/oauth-grants.js';
import { connectorRegistry, loadDescriptor } from '../registry.js';
import { RestReadConnector } from './rest-read.js';

const TOKEN = 'reference-bearer-value';
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
const contacts = [
  { id: 1, email: 'asha@example.in', mobile: '9876543210', profile: { pan: 'ABCDE1234F' } },
  { id: 2, email: 'ravi@example.in', mobile: null, profile: { pan: 'bad' } },
  { id: 3, email: 'not-an-email', mobile: '+91 9123456780', tags: ['vip'] },
];
const seen: { url: string; auth?: string }[] = [];
let server: Server;
let origin: string;

// Axiom's reference service. Production endpoints must be HTTPS; the test
// fetch forwards the validated HTTPS URL to this loopback server unchanged.
beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url!, auth: req.headers.authorization });
    const url = new URL(req.url!, 'http://reference');
    const json = (status: number, body: unknown, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`)
      return json(401, { error: 'unauthorized' });
    if (url.pathname === '/v1/contacts') {
      const limit = Number(url.searchParams.get('limit'));
      const start = url.searchParams.get('cursor') === 'page-2' ? 2 : 0;
      const page = contacts.slice(start, start + limit);
      return json(200, {
        data: page,
        next_cursor: start + limit < contacts.length ? 'page-2' : null,
      });
    }
    if (url.pathname === '/v1/redirect') {
      res.writeHead(302, { location: 'https://elsewhere.invalid/' });
      return res.end();
    }
    if (url.pathname === '/v1/html') return json(200, { data: [] }, 'text/html');
    if (url.pathname === '/v1/huge') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(`{"data":["${'x'.repeat(1024 * 1024 + 10)}"]}`);
    }
    return json(404, { error: 'missing' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const loopback = (input: string, init: RequestInit) => {
  const url = new URL(input);
  expect(url.origin).toBe('https://crm.reference.axiom.test');
  return fetch(`${origin}${url.pathname}${url.search}`, init);
};
const token = async () => new AcquiredToken(TOKEN, ['crm.read'], Date.now() + 60_000);
const crm = connectorRegistry.get('41410000-0000-4000-8000-000000000011')!;
const connector = (manifest: ConnectorManifest = crm) =>
  new RestReadConnector(
    manifest,
    { baseUrl: 'https://crm.reference.axiom.test/' },
    token,
    loopback,
  );
const withResources = (resources: Record<string, unknown>) =>
  ConnectorManifestSchema.parse({ ...crm, rest: { resources } });

describe('RestReadConnector (W4.7)', () => {
  it('ships the five-system reference pack with reference provenance and no writes', () => {
    const rest = [...connectorRegistry.values()].filter((m) => m.transport === 'rest');
    expect(rest.map((m) => m.target).sort()).toEqual([
      'code-repository',
      'crm',
      'data-warehouse',
      'hrms',
      'ticketing',
    ]);
    for (const m of rest) {
      expect(m.provenance).toBe('reference');
      expect(m.targetBinding).toBe('reference-mock');
      expect(m.capabilities.write).toBeUndefined();
    }
  });

  it('enumerates declared resources with observed field paths, using the broker token', async () => {
    const { records } = await connector().enumerate(context());
    expect(records).toEqual([
      {
        resource: 'contacts',
        fields: ['email', 'id', 'mobile', 'profile.pan', 'tags'],
      },
    ]);
    expect(seen.at(-1)).toEqual({ url: '/v1/contacts?limit=5', auth: `Bearer ${TOKEN}` });
  });

  it('profiles value shapes without returning any value, and pages by cursor', async () => {
    const first = await connector().sample(context(), 'contacts', 2);
    expect(first.cursor).toBe('page-2');
    const byField = Object.fromEntries(first.records.map((r) => [r.field, r]));
    expect(byField.email).toMatchObject({
      sampled: 2,
      detected: { email: 2 },
      categoryHints: ['contact'],
    });
    expect(byField['profile.pan']).toMatchObject({ detected: { pan: 1 } });
    expect(byField.mobile).toMatchObject({ nonNull: 1, detected: { phone_in: 1 } });
    const second = await connector().sample(context(), 'contacts', 2, 'page-2');
    expect(second.cursor).toBeUndefined();
    expect(Object.fromEntries(second.records.map((r) => [r.field, r])).mobile).toMatchObject({
      detected: { phone_in: 1 },
    });
    const serialized = JSON.stringify([first, second]);
    for (const raw of ['asha@example.in', '9876543210', 'ABCDE1234F', 'vip', TOKEN])
      expect(serialized).not.toContain(raw);
  });

  it('refuses undeclared resources, bad input and unsafe responses without leaking bodies', async () => {
    await expect(connector().sample(context(), 'toString', 5)).rejects.toMatchObject({
      reason: 'resource',
    });
    await expect(connector().sample(context(), 'contacts', 101)).rejects.toMatchObject({
      reason: 'limit',
    });
    await expect(connector().sample(context(), 'contacts', 2, 'a&b=c')).rejects.toMatchObject({
      reason: 'cursor',
    });
    await expect(connector().enumerate(context(-1))).rejects.toMatchObject({ reason: 'deadline' });
    await expect(connector().read()).rejects.toMatchObject({ reason: 'raw_read_disabled' });
    const resource = (path: string) => ({ path, itemsPointer: '/data', pageSizeParam: 'limit' });
    const probe = (path: string) =>
      connector(withResources({ probe: resource(path) })).sample(context(), 'probe', 5);
    await expect(probe('/v1/redirect')).rejects.toMatchObject({ reason: 'transport' });
    await expect(probe('/v1/html')).rejects.toMatchObject({ reason: 'content_type' });
    await expect(probe('/v1/huge')).rejects.toMatchObject({ reason: 'too_large' });
    await expect(probe('/v1/absent')).rejects.toMatchObject({ reason: 'status_404' });
    const denied = new RestReadConnector(
      crm,
      { baseUrl: 'https://crm.reference.axiom.test/' },
      async () => new AcquiredToken('wrong', ['crm.read'], Date.now() + 60_000),
      loopback,
    );
    await expect(denied.sample(context(), 'contacts', 1)).rejects.toMatchObject({
      reason: 'status_401',
    });
  });

  it('rejects unsafe descriptors and endpoints before any request', () => {
    for (const path of ['/v1/../admin', '//evil.test/x', '/v1/x?y=1', 'v1/x', '/v1/{id}'])
      expect(() =>
        withResources({ bad: { path, itemsPointer: '/data', pageSizeParam: 'limit' } }),
      ).toThrow();
    expect(() => ConnectorManifestSchema.parse({ ...crm, rest: undefined })).toThrow();
    expect(() =>
      loadDescriptor(
        `schemaVersion: 1\nid: 41410000-0000-4000-8000-000000000099\ntarget: x\nversion: 1.0.0\ntransport: sql\ntargetBinding: sandbox\nauth: cloud_iam\nassurance: high\ncapabilities: { enumerate: { operation: sql.enumerate, mutating: false } }\ndataCategoryHints: []\nrateLimit: { requestsPerSecond: 1, burst: 1 }\nrest: { resources: { a: { path: /a, itemsPointer: /d, pageSizeParam: limit } } }\n`,
      ),
    ).toThrow();
    for (const baseUrl of [
      'http://crm.reference.axiom.test/',
      'https://user:pw@crm.reference.axiom.test/',
      'https://crm.reference.axiom.test/api',
      'https://crm.reference.axiom.test/?q=1',
    ])
      expect(() => new RestReadConnector(crm, { baseUrl }, token, loopback)).toThrow(/endpoint/);
  });
});
