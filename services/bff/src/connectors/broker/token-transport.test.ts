import { randomBytes } from 'node:crypto';
import type { TenantId, ConnectorId } from '@axiom/types';
import { CredentialBroker, type BrokerLease } from './broker.js';
import { sealCredential, type KeyWrapper, type CredentialId } from './envelope.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PinnedTokenTransport, type PinnedTokenEndpoint } from './token-transport.js';
import { OAuthGrantError, acquireOAuthToken } from './oauth-grants.js';
let server: Server;
let directory: string;
let endpoint: string;
let caPem: string;
let requests = 0;
const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
const profile = () =>
  Buffer.from(
    JSON.stringify({
      version: 1,
      grantType: 'client_credentials',
      tokenEndpoint: endpoint + '/token',
      clientAuth: { method: 'client_secret_basic', clientId: 'fixture', clientSecret: 'synthetic' },
      allowedScopes: ['inventory.read'],
      maxTokenLifetimeSeconds: 300,
    }),
  );
const config = (
  path = '/token',
  patch: Partial<PinnedTokenEndpoint> = {},
): PinnedTokenEndpoint => ({
  endpoint: endpoint + path,
  address: '127.0.0.1',
  targetBinding: 'reference-mock',
  timeoutMs: 3000,
  caPem,
  ...patch,
});
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'axiom-oauth-tls-'));
  writeFileSync(
    join(directory, 'cert.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=reference-as.test.invalid\n[ext]\nsubjectAltName=DNS:reference-as.test.invalid\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n',
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-new',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'cert.pem'),
      '-config',
      join(directory, 'cert.conf'),
    ],
    { stdio: 'ignore' },
  );
  caPem = readFileSync(join(directory, 'cert.pem'), 'utf8');
  server = createServer(
    { key: readFileSync(join(directory, 'key.pem')), cert: caPem },
    async (req, res) => {
      requests++;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      if (
        req.url === '/token' &&
        (req.headers.authorization !==
          'Basic ' + Buffer.from('fixture:synthetic').toString('base64') ||
          form.get('grant_type') !== 'client_credentials' ||
          form.get('scope') !== 'inventory.read')
      ) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: endpoint + '/token' });
        res.end();
        return;
      }
      if (req.url === '/oversized') {
        res.end(Buffer.alloc(65537, 'x'));
        return;
      }
      if (req.url === '/slow') {
        const timer = setTimeout(() => res.end('{}'), 1000);
        res.on('close', () => clearTimeout(timer));
        return;
      }
      if (req.url === '/truncated') {
        res.writeHead(200, { 'Content-Length': '1000' });
        res.write('{}');
        res.socket?.destroy();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      });
      res.end(
        JSON.stringify({
          access_token: 'fixture-token',
          token_type: 'Bearer',
          expires_in: 300,
          scope: 'inventory.read',
        }),
      );
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture failed');
  endpoint = `https://reference-as.test.invalid:${address.port}`;
});
afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (directory) rmSync(directory, { recursive: true, force: true });
});
describe('pinned HTTPS token endpoint', () => {
  it('opens an encrypted credential and completes broker acquisition against the TLS reference AS', async () => {
    const id = (n: number) => `45450000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const lease: BrokerLease = {
      tenantId: id(1),
      estateId: id(2),
      connectorId: id(3),
      credentialId: id(4),
      credentialRevision: 1,
      connectorVersion: 1,
      grantId: id(5),
      workloadId: id(6),
      agentName: 'drishti',
      spiffeId: 'spiffe://test.invalid/agent/drishti',
      scope: 'connector.read',
      targetScopes: ['inventory.read'],
      validUntil: Date.now() + 600000,
      descriptorSha256: 'a'.repeat(64),
      endpointRef: 'reference',
      targetBinding: 'reference-mock',
      grantType: 'client_credentials',
    };
    // This isolated KMS fixture retains a DEK under an opaque handle; production
    // uses the separately tested cloud adapters. Authority is explicitly synthetic.
    const dataKeys = new Map<string, Buffer>();
    const keys: KeyWrapper = {
      async wrap(_identity, value) {
        const handle = randomBytes(32);
        dataKeys.set(handle.toString('hex'), Buffer.from(value));
        return { keyRef: 'fixture/key', wrappedKey: handle };
      },
      async unwrap(_identity, _keyRef, handle) {
        return Buffer.from(dataKeys.get(Buffer.from(handle).toString('hex'))!);
      },
    };
    const clear = profile();
    const envelope = await sealCredential(
      {
        tenantId: lease.tenantId as TenantId,
        connectorId: lease.connectorId as ConnectorId,
        credentialId: lease.credentialId as CredentialId,
        grantType: lease.grantType,
        descriptorSha256: lease.descriptorSha256,
        endpointRef: lease.endpointRef,
        targetBinding: lease.targetBinding,
      },
      clear,
      keys,
    );
    clear.fill(0);
    const phases: string[] = [];
    const broker = new CredentialBroker(
      {
        keys,
        credentials: {
          async load() {
            return envelope;
          },
          async stillCurrent() {
            return true;
          },
        },
        transport: () => new PinnedTokenTransport(config()),
        audit: {
          refused() {},
          async write(phase) {
            phases.push(phase);
          },
        },
      },
      {
        async authorize() {
          return lease;
        },
        async stillCurrent() {
          return true;
        },
      },
    );
    try {
      const token = await broker.acquire({
        tenantId: lease.tenantId,
        estateId: lease.estateId,
        connectorId: lease.connectorId,
        correlationId: id(7),
        scope: 'connector.read',
        workloadProof: 'synthetic-only',
      });
      expect(token.withValue((value) => value)).toBe('fixture-token');
      expect(phases).toEqual(['requested', 'acquired']);
      token.destroy();
    } finally {
      for (const key of dataKeys.values()) key.fill(0);
    }
  });
  it('uses a fixed address without DNS while verifying the configured TLS hostname and CA', async () => {
    const token = await acquireOAuthToken(
      profile(),
      ['inventory.read'],
      new PinnedTokenTransport(config()),
    );
    expect(token.withValue((v) => v)).toBe('fixture-token');
    token.destroy();
  });
  it('refuses untrusted certificates and hostname substitutions', async () => {
    for (const cfg of [
      config('/token', { caPem: undefined }),
      config('/token', { endpoint: endpoint.replace('reference-as', 'foreign-as') + '/token' }),
    ]) {
      const transport = new PinnedTokenTransport(cfg);
      await expect(
        transport.post(cfg.endpoint, Buffer.from('grant_type=client_credentials'), headers),
      ).rejects.toThrow(OAuthGrantError);
    }
  });
  it.each(['/redirect', '/oversized', '/slow', '/truncated'])(
    'refuses redirects, oversized, stalled or truncated responses (%s)',
    async (path) => {
      const transport = new PinnedTokenTransport(
        config(path, path === '/slow' ? { timeoutMs: 50 } : {}),
      );
      await expect(
        transport.post(endpoint + path, Buffer.from('grant_type=client_credentials'), headers),
      ).rejects.toThrow(OAuthGrantError);
    },
  );
  it('rejects URL and header substitution before connecting', async () => {
    const transport = new PinnedTokenTransport(config());
    const before = requests;
    await expect(transport.post(endpoint + '/foreign', Buffer.from('x'), headers)).rejects.toThrow(
      OAuthGrantError,
    );
    await expect(
      transport.post(endpoint + '/token', Buffer.from('x'), {
        ...headers,
        Host: 'foreign.test.invalid',
      }),
    ).rejects.toThrow(OAuthGrantError);
    await expect(
      transport.post(endpoint + '/token', Buffer.from('x'), {
        ...headers,
        Authorization: 'Basic x\r\nInjected: y',
      }),
    ).rejects.toThrow(OAuthGrantError);
    expect(requests).toBe(before);
  });
  it.each([
    '0.0.0.0',
    '169.254.169.254',
    '168.63.129.16',
    '100.100.100.200',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
  ])('refuses metadata, non-unicast and unsupported address pins (%s)', (address) => {
    expect(() => new PinnedTokenTransport(config('/token', { address }))).toThrow();
  });
  it('allows loopback only for explicitly synthetic bindings and refuses userinfo/query/fragment/IP URLs', () => {
    for (const targetBinding of ['production', 'sandbox'] as const)
      expect(() => new PinnedTokenTransport(config('/token', { targetBinding }))).toThrow();
    for (const url of [
      'http://reference-as.test.invalid/token',
      'https://user:pass@reference-as.test.invalid/token',
      'https://reference-as.test.invalid/token?secret=x',
      'https://reference-as.test.invalid/token#fragment',
      'https://127.0.0.1/token',
    ])
      expect(() => new PinnedTokenTransport(config('/token', { endpoint: url }))).toThrow();
  });
});
