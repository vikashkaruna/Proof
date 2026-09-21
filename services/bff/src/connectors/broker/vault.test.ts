import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectorId, TenantId } from '@axiom/types';
import { CredentialVault, VaultError, type VaultActor } from './vault.js';
import {
  openCredential,
  type CredentialId,
  type KeyWrapper,
  type VaultIdentity,
} from './envelope.js';
const actor: VaultActor = {
  tenantId: '42420000-0000-4000-8000-000000000002' as TenantId,
  actorId: '42420000-0000-4000-8000-000000000001',
  correlationId: '42420000-0000-4000-8000-000000000009',
};
const connectorId = '42420000-0000-4000-8000-000000000006' as ConnectorId;
const descriptorId = '42420000-0000-4000-8000-000000000005';
const profile = () =>
  Buffer.from(
    JSON.stringify({
      version: 1,
      grantType: 'client_credentials',
      tokenEndpoint: 'https://auth.test.invalid/token',
      clientAuth: {
        method: 'client_secret_basic',
        clientId: 'fixture',
        clientSecret: 'fixture-client-secret',
      },
      allowedScopes: ['inventory.read'],
      maxTokenLifetimeSeconds: 300,
    }),
  );
/** In-memory wrapping service for storage-adapter tests only. Envelopes contain
 * opaque handles, never the fixture's clear DEKs. Crypto conformance is separate. */
function wrapper(ref = 'fixture/key') {
  const keys = new Map<string, Buffer>();
  const implementation: KeyWrapper = {
    async wrap(_identity, key) {
      const handle = randomBytes(32);
      keys.set(handle.toString('hex'), Buffer.from(key));
      return { keyRef: ref, wrappedKey: handle };
    },
    async unwrap(_identity, keyRef, handle) {
      const key = keys.get(Buffer.from(handle).toString('hex'));
      if (keyRef !== ref || !key) throw new Error('private error');
      return Buffer.from(key);
    },
  };
  return {
    ...implementation,
    wrap: vi.fn(implementation.wrap),
    unwrap: vi.fn(implementation.unwrap),
  };
}
function fixture() {
  let role = 'admin';
  let endpoint = 'crm';
  let rpcError = false;
  let stored: Record<string, unknown> | null = null;
  const requests: { url: URL; body: Record<string, unknown> | null }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    requests.push({ url, body });
    let result: unknown;
    switch (url.pathname.split('/').at(-1)) {
      case 'tenant_users':
        result = { role };
        break;
      case 'connectors':
        result = {
          id: connectorId,
          descriptor_id: descriptorId,
          version: 4,
          endpoint_ref: endpoint,
          target_binding: 'production',
          status: 'active',
        };
        break;
      case 'connector_descriptors':
        result = {
          content_sha256: 'a'.repeat(64),
          manifest: { auth: 'oauth2.client_credentials' },
        };
        break;
      case 'connector_credentials':
        result = stored;
        break;
      case 'manage_connector_credential': {
        if (rpcError) {
          result = { error: 'version_conflict' };
          break;
        }
        const envelope = body!.p_envelope as Record<string, unknown>;
        const operation = body!.p_operation;
        if (operation === 'create' || operation === 'rotate')
          stored = {
            id: body!.p_credential_id,
            revision: Number(body!.p_expected_revision) + 1,
            format_version: envelope.formatVersion,
            grant_type: envelope.grantType,
            algorithm: envelope.algorithm,
            key_ref: envelope.keyRef,
            nonce: '\\x' + envelope.nonce,
            ciphertext: '\\x' + envelope.ciphertext,
            wrapped_data_key: '\\x' + envelope.wrappedDataKey,
            descriptor_sha256: envelope.descriptorSha256,
            endpoint_ref: envelope.endpointRef,
            target_binding: envelope.targetBinding,
            expires_at: null,
            revoked_at: null,
          };
        result = {
          credentialId: body!.p_credential_id,
          revision: Number(body!.p_expected_revision) + 1,
          revoked: operation === 'revoke',
        };
        break;
      }
      default:
        throw new Error('Unexpected database request');
    }
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const db = createClient('https://vault-db.test.invalid', 'synthetic-service-key', {
    global: { fetch: fetcher },
    auth: { persistSession: false },
  });
  return {
    db,
    requests,
    setRole: (v: string) => {
      role = v;
    },
    setEndpoint: (v: string) => {
      endpoint = v;
    },
    failRpc: () => {
      rpcError = true;
    },
    stored: () => stored!,
    patchStored: (v: Record<string, unknown>) => {
      stored = { ...stored, ...v };
    },
  };
}
describe('credential vault administrative adapter', () => {
  it('rejects malformed and mismatched OAuth profiles before wrapping or persistence', async () => {
    for (const secret of [Buffer.from('raw secret'), Buffer.from('{}'), profile()]) {
      const f = fixture();
      const key = wrapper();
      await expect(
        new CredentialVault(f.db, key).create(actor, connectorId, 'jwt_bearer', secret),
      ).rejects.toThrow(VaultError);
      expect(key.wrap).not.toHaveBeenCalled();
      expect(f.requests.some((r) => r.body)).toBe(false);
      expect(secret).toEqual(Buffer.alloc(secret.length));
    }
  });
  it('persists only authenticated ciphertext, scopes reads, rotates with CAS and returns safe receipts', async () => {
    const f = fixture();
    const initial = wrapper();
    const next = wrapper('fixture/new');
    const vault = new CredentialVault(f.db, initial);
    const secret = profile();
    const receipt = await vault.create(actor, connectorId, 'client_credentials', secret);
    expect(secret).toEqual(Buffer.alloc(secret.length));
    expect(receipt).toEqual({ credentialId: expect.any(String), revision: 1, revoked: false });
    expect(JSON.stringify(f.requests)).not.toContain('fixture-client-secret');
    const rotated = await vault.rotate(
      actor,
      connectorId,
      receipt.credentialId as CredentialId,
      next,
    );
    expect(rotated.revision).toBe(2);
    const writes = f.requests.filter((r) => r.body);
    expect(writes[1]!.body).toMatchObject({
      p_connector_version: 4,
      p_expected_revision: 1,
      p_operation: 'rotate',
    });
    const row = f.stored();
    const identity: VaultIdentity = {
      tenantId: actor.tenantId,
      connectorId,
      credentialId: receipt.credentialId as CredentialId,
      grantType: 'client_credentials',
      descriptorSha256: 'a'.repeat(64),
      endpointRef: 'crm',
      targetBinding: 'production',
    };
    const bytes = (name: string) => Buffer.from(String(row[name]).slice(2), 'hex');
    const decrypted = await openCredential(
      identity,
      {
        formatVersion: 1,
        algorithm: 'aes-256-gcm',
        keyRef: 'fixture/new',
        nonce: bytes('nonce'),
        ciphertext: bytes('ciphertext'),
        wrappedDataKey: bytes('wrapped_data_key'),
      },
      next,
    );
    expect(decrypted).toEqual(profile());
    decrypted.fill(0);
    for (const request of f.requests.filter((r) =>
      ['connectors', 'connector_credentials', 'tenant_users'].includes(
        r.url.pathname.split('/').at(-1)!,
      ),
    ))
      expect(request.url.searchParams.get('tenant_id')).toBe(`eq.${actor.tenantId}`);
    expect(
      (await vault.revoke(actor, connectorId, receipt.credentialId as CredentialId, 2)).revoked,
    ).toBe(true);
  });
  it('denies demoted users before connector/credential reads or KMS calls and clears input', async () => {
    const f = fixture();
    f.setRole('viewer');
    const key = wrapper();
    const secret = profile();
    await expect(
      new CredentialVault(f.db, key).create(actor, connectorId, 'client_credentials', secret),
    ).rejects.toThrow(VaultError);
    expect(f.requests).toHaveLength(1);
    expect(key.wrap).not.toHaveBeenCalled();
    expect(secret).toEqual(Buffer.alloc(secret.length));
  });
  it('refuses retargeted, legacy, expired or revoked records before decrypting', async () => {
    for (const change of [
      { format_version: 0 },
      { expires_at: 'invalid' },
      { expires_at: '2000-01-01T00:00:00Z' },
      { revoked_at: '2026-01-01T00:00:00Z' },
      { endpoint_ref: 'other' },
    ]) {
      const f = fixture();
      const key = wrapper();
      const vault = new CredentialVault(f.db, key);
      const receipt = await vault.create(actor, connectorId, 'client_credentials', profile());
      f.patchStored(change);
      await expect(
        vault.rotate(actor, connectorId, receipt.credentialId as CredentialId, wrapper()),
      ).rejects.toThrow(VaultError);
      expect(key.unwrap).not.toHaveBeenCalled();
    }
  });
  it('surfaces an atomic persistence refusal without claiming the rotation succeeded', async () => {
    const f = fixture();
    const key = wrapper();
    const vault = new CredentialVault(f.db, key);
    const receipt = await vault.create(actor, connectorId, 'client_credentials', profile());
    const before = JSON.stringify(f.stored());
    f.failRpc();
    await expect(
      vault.rotate(
        actor,
        connectorId,
        receipt.credentialId as CredentialId,
        wrapper('fixture/next'),
      ),
    ).rejects.toThrow(VaultError);
    expect(JSON.stringify(f.stored())).toBe(before);
  });
});
