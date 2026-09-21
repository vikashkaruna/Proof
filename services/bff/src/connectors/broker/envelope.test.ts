import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type { ConnectorId, TenantId } from '@axiom/types';
import {
  CredentialEnvelopeError,
  openCredential,
  rotateEnvelope,
  sealCredential,
  wrappingContext,
  type CredentialId,
  type CredentialEnvelope,
  type KeyWrapper,
  type VaultIdentity,
} from './envelope.js';
const identity: VaultIdentity = {
  tenantId: '00000000-0000-4000-8000-000000000001' as TenantId,
  connectorId: '00000000-0000-4000-8000-000000000002' as ConnectorId,
  credentialId: '00000000-0000-4000-8000-000000000003' as CredentialId,
  grantType: 'client_credentials',
  descriptorSha256: 'a'.repeat(64),
  endpointRef: 'primary_crm',
  targetBinding: 'production',
};
/** Test-only KEK adapter. No production factory imports or falls back to it. */
class FixtureWrapper implements KeyWrapper {
  readonly key = randomBytes(32);
  constructor(readonly keyRef: string) {}
  async wrap(scope: VaultIdentity, key: Uint8Array) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(wrappingContext(scope));
    return {
      keyRef: this.keyRef,
      wrappedKey: Buffer.concat([nonce, cipher.update(key), cipher.final(), cipher.getAuthTag()]),
    };
  }
  async unwrap(scope: VaultIdentity, keyRef: string, wrapped: Uint8Array) {
    if (keyRef !== this.keyRef) throw new Error('Private provider error must not escape');
    const bytes = Buffer.from(wrapped);
    const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAAD(wrappingContext(scope));
    cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]);
  }
}
const payload = () => Buffer.from('synthetic-client-secret-for-vault-tests');
describe('tenant-bound credential envelopes', () => {
  it('encrypts with a unique data key/nonce and keeps plaintext out of the stored envelope', async () => {
    const wrapper = new FixtureWrapper('fixture/key-one');
    const first = await sealCredential(identity, payload(), wrapper);
    const second = await sealCredential(identity, payload(), wrapper);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(first.wrappedDataKey.equals(second.wrappedDataKey)).toBe(false);
    expect(JSON.stringify(first)).not.toContain(payload().toString());
    expect(await openCredential(identity, first, wrapper)).toEqual(payload());
  });
  it.each(['tenantId', 'connectorId', 'credentialId', 'grantType'] as const)(
    'refuses an envelope transplanted to another %s',
    async (field) => {
      const wrapper = new FixtureWrapper('fixture/key');
      const envelope = await sealCredential(identity, payload(), wrapper);
      const changed = {
        ...identity,
        [field]: field === 'grantType' ? 'jwt_bearer' : '00000000-0000-4000-8000-000000000009',
      };
      await expect(openCredential(changed, envelope, wrapper)).rejects.toThrow(
        CredentialEnvelopeError,
      );
    },
  );
  it.each([
    { descriptorSha256: 'b'.repeat(64) },
    { endpointRef: 'another_target' },
    { targetBinding: 'sandbox' as const },
  ])(
    'refuses retargeting a credential after changing connector configuration %#',
    async (patch) => {
      const wrapper = new FixtureWrapper('fixture/key');
      const envelope = await sealCredential(identity, payload(), wrapper);
      await expect(openCredential({ ...identity, ...patch }, envelope, wrapper)).rejects.toThrow(
        CredentialEnvelopeError,
      );
    },
  );
  it.each(['nonce', 'ciphertext', 'wrappedDataKey'] as const)(
    'authenticates tampered %s',
    async (field) => {
      const wrapper = new FixtureWrapper('fixture/key');
      const envelope = await sealCredential(identity, payload(), wrapper);
      envelope[field] = Buffer.from(envelope[field]);
      envelope[field][0] = envelope[field][0]! ^ 1;
      await expect(openCredential(identity, envelope, wrapper)).rejects.toThrow(
        CredentialEnvelopeError,
      );
    },
  );
  it('refuses unknown formats, altered key references and malformed lengths', async () => {
    const wrapper = new FixtureWrapper('fixture/key');
    const envelope = await sealCredential(identity, payload(), wrapper);
    for (const patch of [
      { formatVersion: 0 },
      { algorithm: 'plaintext' },
      { keyRef: 'fixture/other' },
      { nonce: Buffer.alloc(11) },
      { ciphertext: Buffer.alloc(16) },
      { wrappedDataKey: Buffer.alloc(0) },
    ])
      await expect(
        openCredential(identity, { ...envelope, ...patch } as CredentialEnvelope, wrapper),
      ).rejects.toThrow(CredentialEnvelopeError);
  });
  it('rotates to a fresh wrapping key while preserving the secret and leaving the source untouched', async () => {
    const old = new FixtureWrapper('fixture/old');
    const next = new FixtureWrapper('fixture/new');
    const envelope = await sealCredential(identity, payload(), old);
    const snapshot = JSON.stringify(envelope);
    const rotated = await rotateEnvelope(identity, envelope, old, next);
    expect(rotated.keyRef).toBe('fixture/new');
    expect(JSON.stringify(envelope)).toBe(snapshot);
    expect(await openCredential(identity, rotated, next)).toEqual(payload());
    await expect(openCredential(identity, rotated, old)).rejects.toThrow(CredentialEnvelopeError);
  });
  it('fails closed without exposing wrapping-provider error details', async () => {
    const broken: KeyWrapper = {
      async wrap() {
        throw new Error('private provider credential');
      },
      async unwrap() {
        throw new Error('private provider credential');
      },
    };
    await expect(sealCredential(identity, payload(), broken)).rejects.toThrow(
      'Credential envelope could not be authenticated.',
    );
    await expect(sealCredential(identity, Buffer.alloc(0), broken)).rejects.toThrow(
      CredentialEnvelopeError,
    );
    await expect(sealCredential(identity, Buffer.alloc(32769), broken)).rejects.toThrow(
      CredentialEnvelopeError,
    );
  });
});
