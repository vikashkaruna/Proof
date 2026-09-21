import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorId, TenantId } from '@axiom/types';
import {
  CredentialBroker,
  BrokerRefused,
  type BrokerLease,
  type BrokerRequest,
  type BrokerResources,
  type BrokerAuthority,
} from './broker.js';
import {
  sealCredential,
  wrappingContext,
  type CredentialId,
  type KeyWrapper,
  type VaultIdentity,
} from './envelope.js';
import { AcquiredToken } from './oauth-grants.js';
const id = (n: number) => `43430000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const request = (): BrokerRequest => ({
  tenantId: id(1),
  estateId: id(2),
  connectorId: id(3),
  correlationId: id(4),
  scope: 'connector.read',
  workloadProof: 'synthetic-svid',
});
const lease = (): BrokerLease => ({
  tenantId: id(1),
  estateId: id(2),
  connectorId: id(3),
  credentialId: id(5),
  credentialRevision: 1,
  connectorVersion: 2,
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
const profile = () => ({
  version: 1,
  grantType: 'client_credentials',
  tokenEndpoint: 'https://as.test.invalid/token',
  clientAuth: {
    method: 'client_secret_basic',
    clientId: 'fixture',
    clientSecret: 'never-log-this-secret',
  },
  allowedScopes: ['inventory.read', 'records.write'],
  maxTokenLifetimeSeconds: 300,
});
async function fixture(approved = lease(), secret: unknown = profile()) {
  const kek = randomBytes(32);
  const keys: KeyWrapper = {
    async wrap(identity, key) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', kek, nonce);
      cipher.setAAD(wrappingContext(identity));
      return {
        keyRef: 'fixture/key',
        wrappedKey: Buffer.concat([nonce, cipher.update(key), cipher.final(), cipher.getAuthTag()]),
      };
    },
    unwrap: vi.fn(async (identity: VaultIdentity, _ref: string, wrapped: Uint8Array) => {
      const bytes = Buffer.from(wrapped);
      const cipher = createDecipheriv('aes-256-gcm', kek, bytes.subarray(0, 12));
      cipher.setAAD(wrappingContext(identity));
      cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]);
    }),
  };
  const identity: VaultIdentity = {
    tenantId: approved.tenantId as TenantId,
    connectorId: approved.connectorId as ConnectorId,
    credentialId: approved.credentialId as CredentialId,
    grantType: approved.grantType,
    descriptorSha256: approved.descriptorSha256,
    endpointRef: approved.endpointRef,
    targetBinding: approved.targetBinding,
  };
  const bytes = Buffer.from(JSON.stringify(secret));
  const envelope = await sealCredential(identity, bytes, keys);
  bytes.fill(0);
  const post = vi.fn(async (_url: string, body: Uint8Array) => ({
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      pragma: 'no-cache',
    },
    body: Buffer.from(
      JSON.stringify({
        access_token: 'opaque-test-token',
        token_type: 'Bearer',
        expires_in: 300,
        scope: new URLSearchParams(Buffer.from(body).toString()).get('scope'),
      }),
    ),
  }));
  const credentials = { load: vi.fn(async () => envelope), stillCurrent: vi.fn(async () => true) };
  const audit = {
    write: vi.fn<BrokerResources['audit']['write']>(async () => {}),
    refused: vi.fn(),
  };
  const resources: BrokerResources = { keys, credentials, audit, transport: () => ({ post }) };
  const authority = {
    authorize: vi.fn<BrokerAuthority['authorize']>(async () => approved),
    stillCurrent: vi.fn(async () => true),
  };
  return {
    resources,
    authority,
    post,
    keys,
    credentials,
    audit,
    broker: new CredentialBroker(resources, authority),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('credential broker authority boundary', () => {
  it('accounts for authorization-server latency when bounding the external token lifetime', async () => {
    vi.useFakeTimers();
    const approved = { ...lease(), validUntil: Date.now() + 301000 };
    const f = await fixture(approved);
    const original = f.post.getMockImplementation()!;
    f.post.mockImplementation(async (...args) => {
      vi.setSystemTime(Date.now() + 2000);
      return original(...args);
    });
    await expect(f.broker.acquire(request())).rejects.toThrow(BrokerRefused);
    expect(f.audit.write.mock.calls.map((call) => call[0])).toEqual(['requested', 'denied']);
  });
  it('defaults to deny-all before any credential/KMS/endpoint access', async () => {
    const f = await fixture();
    await expect(new CredentialBroker(f.resources).acquire(request())).rejects.toThrow(
      BrokerRefused,
    );
    expect(f.credentials.load).not.toHaveBeenCalled();
    expect(f.keys.unwrap).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
    expect(f.audit.write).not.toHaveBeenCalled();
    expect(f.audit.refused).toHaveBeenCalledOnce();
  });
  it('decrypts only authorized scope and audits before releasing a short-lived token', async () => {
    const f = await fixture();
    const token = await f.broker.acquire(request());
    expect(token.scopes).toEqual(['inventory.read']);
    expect(token.withValue((v) => v)).toBe('opaque-test-token');
    token.destroy();
    expect(f.audit.write.mock.calls.map((c) => c[0])).toEqual(['requested', 'acquired']);
    expect(f.authority.stillCurrent).toHaveBeenCalledTimes(4);
    expect(f.credentials.stillCurrent).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(f.audit.write.mock.calls)).not.toContain('never-log-this-secret');
    expect(JSON.stringify(f.audit.write.mock.calls)).not.toContain('synthetic-svid');
  });
  it.each(['tenantId', 'estateId', 'connectorId', 'scope', 'validUntil'] as const)(
    'refuses mismatched or expired lease %s',
    async (field) => {
      const f = await fixture();
      const bad = {
        ...lease(),
        [field]: field === 'scope' ? 'connector.write' : field === 'validUntil' ? 1 : id(99),
      };
      f.authority.authorize.mockResolvedValue(bad as BrokerLease);
      await expect(f.broker.acquire(request())).rejects.toThrow(BrokerRefused);
      expect(f.keys.unwrap).not.toHaveBeenCalled();
      expect(f.post).not.toHaveBeenCalled();
    },
  );
  it.each(['sudhaar', 'vibhaag', 'parikshan', 'saakshi', 'lekha', 'nazar', 'prativedan', 'sanket'])(
    'never issues client credentials to %s',
    async (agent) => {
      const f = await fixture();
      f.authority.authorize.mockResolvedValue({ ...lease(), agentName: agent } as BrokerLease);
      await expect(f.broker.acquire(request())).rejects.toThrow(BrokerRefused);
      expect(f.post).not.toHaveBeenCalled();
    },
  );
  it('requires Karya, production binding and matching current action approval for write scope', async () => {
    const approved: BrokerLease = {
      ...lease(),
      agentName: 'karya',
      scope: 'connector.write',
      targetScopes: ['records.write'],
      approval: { tokenId: id(8), actionId: id(9), validUntil: Date.now() + 600000 },
    };
    const input: BrokerRequest = {
      ...request(),
      scope: 'connector.write',
      approvalProof: 'synthetic-signed-approval',
      actionId: id(9),
    };
    const valid = await fixture(approved);
    const token = await valid.broker.acquire(input);
    expect(token.scopes).toEqual(['records.write']);
    token.destroy();
    for (const patch of [
      { agentName: 'drishti' },
      { targetBinding: 'sandbox' },
      { targetBinding: 'reference-mock' },
      { approval: undefined },
      { approval: { tokenId: id(8), actionId: id(99), validUntil: Date.now() + 600000 } },
      { approval: { tokenId: id(8), actionId: id(9), validUntil: 1 } },
    ]) {
      const f = await fixture(approved);
      f.authority.authorize.mockResolvedValue({ ...approved, ...patch } as BrokerLease);
      await expect(f.broker.acquire(input)).rejects.toThrow(BrokerRefused);
      expect(f.post).not.toHaveBeenCalled();
    }
  });
  it.each(['before-decrypt', 'before-request', 'after-request', 'after-audit'])(
    'withholds credentials revoked %s',
    async (phase) => {
      const f = await fixture();
      let checks = 0;
      const failAt =
        ['before-decrypt', 'before-request', 'after-request', 'after-audit'].indexOf(phase) + 1;
      f.credentials.stillCurrent.mockImplementation(async () => ++checks < failAt);
      const destroy = vi.spyOn(AcquiredToken.prototype, 'destroy');
      await expect(f.broker.acquire(request())).rejects.toThrow(BrokerRefused);
      if (failAt <= 2) expect(f.post).not.toHaveBeenCalled();
      else expect(destroy).toHaveBeenCalled();
    },
  );
  it('rechecks workload/grant authority and fails closed when the adapter is unavailable', async () => {
    const f = await fixture();
    f.authority.stillCurrent.mockRejectedValue(new Error('private attestation failure'));
    await expect(f.broker.acquire(request())).rejects.toThrow(
      'Connector credential acquisition was refused.',
    );
    expect(f.keys.unwrap).not.toHaveBeenCalled();
  });
  it('refuses a valid JWT-bearer profile concealed under a client-credentials descriptor', async () => {
    const secret = {
      ...profile(),
      grantType: 'jwt_bearer',
      assertion: {
        issuer: 'issuer',
        subject: 'subject',
        audience: 'audience',
        signingKey: {
          algorithm: 'RS256',
          keyId: 'fixture',
          privateKeyPem: 'not-used-because-family-is-wrong',
        },
      },
    };
    const f = await fixture(lease(), secret);
    await expect(f.broker.acquire(request())).rejects.toThrow(BrokerRefused);
    expect(f.post).not.toHaveBeenCalled();
  });
  it('refuses scope expansion beyond the encrypted profile and tokens exceeding grant lifetime', async () => {
    const f = await fixture({ ...lease(), targetScopes: ['admin.write'] });
    await expect(f.broker.acquire(request())).rejects.toThrow(BrokerRefused);
    expect(f.post).not.toHaveBeenCalled();
    const expiring = await fixture({ ...lease(), validUntil: Date.now() + 60000 });
    await expect(expiring.broker.acquire(request())).rejects.toThrow(BrokerRefused);
    expect(expiring.post).toHaveBeenCalledOnce();
  });
  it.each(['requested', 'acquired'] as const)(
    'never returns a token when %s audit fails',
    async (phase) => {
      const f = await fixture();
      f.audit.write.mockImplementation(async (current) => {
        if (current === phase) throw new Error('private ledger error');
      });
      await expect(f.broker.acquire(request())).rejects.toThrow(BrokerRefused);
      if (phase === 'requested') expect(f.post).not.toHaveBeenCalled();
    },
  );
  it('copies request and lease scopes before asynchronous dependencies can mutate their originals', async () => {
    const approved = lease();
    const f = await fixture(approved);
    const input = request();
    const originalLoad = f.credentials.load.getMockImplementation()!;
    f.authority.authorize.mockImplementation(async (snapshot) => {
      expect(Object.isFrozen(snapshot)).toBe(true);
      input.connectorId = id(99);
      return approved;
    });
    f.credentials.load.mockImplementation(async () => {
      (approved.targetScopes as string[]).push('admin.write');
      return originalLoad();
    });
    const token = await f.broker.acquire(input);
    expect(token.scopes).toEqual(['inventory.read']);
    token.destroy();
  });
});
