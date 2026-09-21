import { randomBytes } from 'node:crypto';
import { crc32c } from '@aws-crypto/crc32c';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorId, TenantId } from '@axiom/types';
import {
  AwsKmsKeyWrapper,
  GcpKmsKeyWrapper,
  type TenantKeyRing,
  type AwsKmsPort,
  type GcpKmsPort,
} from './key-wrappers.js';
import { wrappingContext, type CredentialId, type VaultIdentity } from './envelope.js';
const identity: VaultIdentity = {
  tenantId: '00000000-0000-4000-8000-000000000001' as TenantId,
  connectorId: '00000000-0000-4000-8000-000000000002' as ConnectorId,
  credentialId: '00000000-0000-4000-8000-000000000003' as CredentialId,
  descriptorSha256: 'a'.repeat(64),
  endpointRef: 'crm',
  targetBinding: 'production',
  grantType: 'client_credentials',
};
const otherTenant = '00000000-0000-4000-8000-000000000009' as TenantId;
const awsRef = 'arn:aws:kms:ap-south-1:123456789012:key/00000000-0000-4000-8000-000000000004';
const gcpRef = 'projects/axiom-test/locations/asia-south1/keyRings/vault/cryptoKeys/tenant';
const rings = (primary: string, retiring: string[] = []): Map<TenantId, TenantKeyRing> =>
  new Map([[identity.tenantId, { primary, retiring }]]);
afterEach(() => vi.restoreAllMocks());
describe('tenant KMS adapters (injected provider responses; no cloud calls)', () => {
  it('AWS pins Mumbai key ARN and authenticated context in both operations', async () => {
    const client: AwsKmsPort = { send: vi.fn() };
    const send = vi.spyOn(client, 'send');
    const wrapper = new AwsKmsKeyWrapper(rings(awsRef), client);
    const dek = randomBytes(32);
    const wrapped = randomBytes(80);
    send.mockResolvedValueOnce({ KeyId: awsRef, CiphertextBlob: wrapped });
    expect(await wrapper.wrap(identity, dek)).toEqual({ keyRef: awsRef, wrappedKey: wrapped });
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      KeyId: awsRef,
      Plaintext: dek,
      EncryptionContext: { axiomCredential: wrappingContext(identity).toString('base64') },
    });
    send.mockResolvedValueOnce({ KeyId: awsRef, Plaintext: dek });
    expect(await wrapper.unwrap(identity, awsRef, wrapped)).toBe(dek);
    expect(send.mock.calls[1]?.[0].input).toMatchObject({
      KeyId: awsRef,
      CiphertextBlob: wrapped,
      EncryptionContext: { axiomCredential: wrappingContext(identity).toString('base64') },
    });
  });
  it('AWS refuses foreign keys/tenants and malformed DEKs before making requests', async () => {
    const client: AwsKmsPort = { send: vi.fn() };
    const send = vi.spyOn(client, 'send');
    const wrapper = new AwsKmsKeyWrapper(rings(awsRef), client);
    await expect(
      wrapper.wrap({ ...identity, tenantId: otherTenant }, randomBytes(32)),
    ).rejects.toThrow();
    await expect(wrapper.wrap(identity, randomBytes(31))).rejects.toThrow();
    await expect(wrapper.unwrap(identity, awsRef + '9', randomBytes(80))).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it('AWS rejects wrong provider key identity and clears invalid plaintext', async () => {
    const client: AwsKmsPort = { send: vi.fn() };
    const send = vi.spyOn(client, 'send');
    const wrapper = new AwsKmsKeyWrapper(rings(awsRef), client);
    send.mockResolvedValueOnce({ KeyId: awsRef + '9', CiphertextBlob: randomBytes(80) });
    await expect(wrapper.wrap(identity, randomBytes(32))).rejects.toThrow();
    const bad = randomBytes(32);
    send.mockResolvedValueOnce({ KeyId: awsRef + '9', Plaintext: bad });
    await expect(wrapper.unwrap(identity, awsRef, randomBytes(80))).rejects.toThrow();
    expect(bad).toEqual(Buffer.alloc(32));
  });
  it('GCP verifies request/response CRC32C, AAD and exact key version prefix', async () => {
    const client: GcpKmsPort = { encrypt: vi.fn(), decrypt: vi.fn() };
    const encrypt = vi.spyOn(client, 'encrypt');
    const decrypt = vi.spyOn(client, 'decrypt');
    const wrapper = new GcpKmsKeyWrapper(rings(gcpRef), client);
    const dek = randomBytes(32);
    const ciphertext = randomBytes(80);
    encrypt.mockResolvedValueOnce([
      {
        name: gcpRef + '/cryptoKeyVersions/1',
        ciphertext,
        ciphertextCrc32c: { value: crc32c(ciphertext) },
        verifiedPlaintextCrc32c: true,
        verifiedAdditionalAuthenticatedDataCrc32c: true,
      },
    ]);
    expect(await wrapper.wrap(identity, dek)).toEqual({ keyRef: gcpRef, wrappedKey: ciphertext });
    const aad = wrappingContext(identity);
    expect(encrypt).toHaveBeenCalledWith({
      name: gcpRef,
      plaintext: dek,
      plaintextCrc32c: { value: crc32c(dek) },
      additionalAuthenticatedData: aad,
      additionalAuthenticatedDataCrc32c: { value: crc32c(aad) },
    });
    const providerBuffer = Buffer.from(dek);
    decrypt.mockResolvedValueOnce([
      { plaintext: providerBuffer, plaintextCrc32c: { value: crc32c(dek) } },
    ]);
    expect(await wrapper.unwrap(identity, gcpRef, ciphertext)).toEqual(dek);
    expect(providerBuffer).toEqual(Buffer.alloc(32));
    expect(decrypt).toHaveBeenCalledWith({
      name: gcpRef,
      ciphertext,
      ciphertextCrc32c: { value: crc32c(ciphertext) },
      additionalAuthenticatedData: aad,
      additionalAuthenticatedDataCrc32c: { value: crc32c(aad) },
    });
  });
  it.each(['key', 'missing-checksum', 'checksum', 'plaintext-unverified', 'aad-unverified'])(
    'GCP refuses an unauthenticated encrypt response (%s)',
    async (reason) => {
      const client: GcpKmsPort = { encrypt: vi.fn(), decrypt: vi.fn() };
      const ciphertext = randomBytes(80);
      vi.spyOn(client, 'encrypt').mockResolvedValueOnce([
        {
          name: (reason === 'key' ? gcpRef + '-other' : gcpRef) + '/cryptoKeyVersions/1',
          ciphertext,
          ciphertextCrc32c:
            reason === 'missing-checksum'
              ? null
              : { value: crc32c(ciphertext) ^ (reason === 'checksum' ? 1 : 0) },
          verifiedPlaintextCrc32c: reason !== 'plaintext-unverified',
          verifiedAdditionalAuthenticatedDataCrc32c: reason !== 'aad-unverified',
        },
      ]);
      await expect(
        new GcpKmsKeyWrapper(rings(gcpRef), client).wrap(identity, randomBytes(32)),
      ).rejects.toThrow();
    },
  );
  it('GCP refuses foreign tenant/key before IO and clears corrupted returned keys', async () => {
    const client: GcpKmsPort = { encrypt: vi.fn(), decrypt: vi.fn() };
    const decrypt = vi.spyOn(client, 'decrypt');
    const wrapper = new GcpKmsKeyWrapper(rings(gcpRef), client);
    await expect(wrapper.unwrap(identity, gcpRef + '-other', randomBytes(80))).rejects.toThrow();
    await expect(
      wrapper.unwrap({ ...identity, tenantId: otherTenant }, gcpRef, randomBytes(80)),
    ).rejects.toThrow();
    expect(decrypt).not.toHaveBeenCalled();
    const plaintext = randomBytes(32);
    decrypt.mockResolvedValueOnce([
      { plaintext, plaintextCrc32c: { value: crc32c(plaintext) ^ 1 } },
    ]);
    await expect(wrapper.unwrap(identity, gcpRef, randomBytes(80))).rejects.toThrow();
    expect(plaintext).toEqual(Buffer.alloc(32));
  });
  it('pins copied tenant key policies and permits only explicit retiring keys', async () => {
    const client: AwsKmsPort = { send: vi.fn() };
    const send = vi.spyOn(client, 'send');
    const old = awsRef.replace(/4$/, '5');
    const config = rings(awsRef, [old]);
    const wrapper = new AwsKmsKeyWrapper(config, client);
    config.clear();
    send.mockResolvedValueOnce({ KeyId: old, Plaintext: randomBytes(32) });
    await wrapper.unwrap(identity, old, randomBytes(80));
    send.mockResolvedValueOnce({ KeyId: awsRef, CiphertextBlob: randomBytes(80) });
    expect((await wrapper.wrap(identity, randomBytes(32))).keyRef).toBe(awsRef);
  });
  it('refuses shared, duplicate, alias and non-Mumbai tenant keys at configuration time', () => {
    for (const ref of [awsRef.replace('ap-south-1', 'us-east-1'), awsRef.replace('key/', 'alias/')])
      expect(() => new AwsKmsKeyWrapper(rings(ref))).toThrow();
    expect(
      () => new GcpKmsKeyWrapper(rings(gcpRef.replace('asia-south1', 'us-central1'))),
    ).toThrow();
    expect(() => new AwsKmsKeyWrapper(rings(awsRef, [awsRef]))).toThrow();
    const shared = rings(gcpRef);
    shared.set(otherTenant, { primary: gcpRef, retiring: [] });
    expect(() => new GcpKmsKeyWrapper(shared)).toThrow();
  });
});
