import { crc32c } from '@aws-crypto/crc32c';
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { KeyManagementServiceClient, type protos } from '@google-cloud/kms';
import { z } from 'zod';
import type { TenantId } from '@axiom/types';
import { wrappingContext, type KeyWrapper, type VaultIdentity } from './envelope.js';

/** Narrow promise-only SDK ports avoid exposing callback overloads to callers. */
export interface AwsKmsPort {
  send(command: EncryptCommand | DecryptCommand): Promise<{
    KeyId?: string;
    CiphertextBlob?: Uint8Array;
    Plaintext?: Uint8Array;
  }>;
}
export interface GcpKmsPort {
  encrypt(
    request: protos.google.cloud.kms.v1.IEncryptRequest,
  ): Promise<[protos.google.cloud.kms.v1.IEncryptResponse, ...unknown[]]>;
  decrypt(
    request: protos.google.cloud.kms.v1.IDecryptRequest,
  ): Promise<[protos.google.cloud.kms.v1.IDecryptResponse, ...unknown[]]>;
}

export interface TenantKeyRing {
  primary: string;
  retiring: readonly string[];
}
const awsKey =
  /^arn:aws:kms:ap-south-1:[0-9]{12}:key\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const gcpKey =
  /^projects\/[a-z0-9-]+\/locations\/asia-south1\/keyRings\/[a-zA-Z0-9_-]+\/cryptoKeys\/[a-zA-Z0-9_-]+$/;

/** Trusted deployment configuration, copied on construction. Each tenant owns
 * distinct wrapping-key resources. Arbitrary envelope key references never
 * select a new KMS resource or provider endpoint. */
class KeyPolicy {
  readonly #rings = new Map<string, TenantKeyRing>();
  constructor(rings: ReadonlyMap<TenantId, TenantKeyRing>, pattern: RegExp) {
    const owners = new Map<string, string>();
    for (const [tenantId, ring] of rings) {
      const tenant = z.uuid().parse(tenantId).toLowerCase();
      if (this.#rings.has(tenant)) throw new Error('Duplicate credential key policy');
      const refs = [ring.primary, ...ring.retiring];
      if (refs.length > 10 || new Set(refs).size !== refs.length)
        throw new Error('Invalid credential key policy');
      for (const key of refs) {
        if (
          key.length > 500 ||
          !pattern.test(key) ||
          (owners.has(key) && owners.get(key) !== tenant)
        )
          throw new Error('Invalid credential key policy');
        owners.set(key, tenant);
      }
      this.#rings.set(tenant, { primary: ring.primary, retiring: [...ring.retiring] });
    }
  }
  primary(tenant: TenantId): string {
    const ring = this.#rings.get(tenant.toLowerCase());
    if (!ring) throw new Error('No credential key policy for this tenant');
    return ring.primary;
  }
  requireReadable(tenant: TenantId, keyRef: string): void {
    const ring = this.#rings.get(tenant.toLowerCase());
    if (!ring || (keyRef !== ring.primary && !ring.retiring.includes(keyRef)))
      throw new Error('Credential key is not permitted for this tenant');
  }
}

export class AwsKmsKeyWrapper implements KeyWrapper {
  readonly #policy: KeyPolicy;
  constructor(
    rings: ReadonlyMap<TenantId, TenantKeyRing>,
    private readonly client: AwsKmsPort = new KMSClient({ region: 'ap-south-1' }),
  ) {
    this.#policy = new KeyPolicy(rings, awsKey);
  }
  async wrap(identity: VaultIdentity, dataKey: Uint8Array) {
    if (dataKey.byteLength !== 32) throw new Error('Invalid data key');
    const keyRef = this.#policy.primary(identity.tenantId);
    const result = await this.client.send(
      new EncryptCommand({
        KeyId: keyRef,
        Plaintext: dataKey,
        EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
        EncryptionContext: { axiomCredential: wrappingContext(identity).toString('base64') },
      }),
    );
    if (result.KeyId !== keyRef || !result.CiphertextBlob?.byteLength)
      throw new Error('KMS wrapping response invalid');
    return { keyRef, wrappedKey: result.CiphertextBlob };
  }
  async unwrap(identity: VaultIdentity, keyRef: string, wrappedKey: Uint8Array) {
    this.#policy.requireReadable(identity.tenantId, keyRef);
    const result = await this.client.send(
      new DecryptCommand({
        KeyId: keyRef,
        CiphertextBlob: wrappedKey,
        EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
        EncryptionContext: { axiomCredential: wrappingContext(identity).toString('base64') },
      }),
    );
    if (result.KeyId !== keyRef || result.Plaintext?.byteLength !== 32) {
      result.Plaintext?.fill(0);
      throw new Error('KMS unwrapping response invalid');
    }
    return result.Plaintext;
  }
}

export class GcpKmsKeyWrapper implements KeyWrapper {
  readonly #policy: KeyPolicy;
  constructor(
    rings: ReadonlyMap<TenantId, TenantKeyRing>,
    private readonly client: GcpKmsPort = new KeyManagementServiceClient(),
  ) {
    this.#policy = new KeyPolicy(rings, gcpKey);
  }
  async wrap(identity: VaultIdentity, dataKey: Uint8Array) {
    if (dataKey.byteLength !== 32) throw new Error('Invalid data key');
    const keyRef = this.#policy.primary(identity.tenantId);
    const aad = wrappingContext(identity);
    const [result] = await this.client.encrypt({
      name: keyRef,
      plaintext: dataKey,
      plaintextCrc32c: { value: crc32c(dataKey) },
      additionalAuthenticatedData: aad,
      additionalAuthenticatedDataCrc32c: { value: crc32c(aad) },
    });
    if (
      !result.name?.startsWith(`${keyRef}/cryptoKeyVersions/`) ||
      !/^[1-9][0-9]*$/.test(result.name.slice(`${keyRef}/cryptoKeyVersions/`.length)) ||
      !result.ciphertext ||
      result.verifiedPlaintextCrc32c !== true ||
      result.verifiedAdditionalAuthenticatedDataCrc32c !== true
    )
      throw new Error('KMS wrapping response invalid');
    const wrappedKey =
      typeof result.ciphertext === 'string'
        ? Buffer.from(result.ciphertext, 'base64')
        : Buffer.from(result.ciphertext);
    if (
      !wrappedKey.length ||
      result.ciphertextCrc32c?.value == null ||
      Number(result.ciphertextCrc32c.value) !== crc32c(wrappedKey)
    )
      throw new Error('KMS wrapping response invalid');
    return { keyRef, wrappedKey };
  }
  async unwrap(identity: VaultIdentity, keyRef: string, wrappedKey: Uint8Array) {
    this.#policy.requireReadable(identity.tenantId, keyRef);
    const aad = wrappingContext(identity);
    const [result] = await this.client.decrypt({
      name: keyRef,
      ciphertext: wrappedKey,
      ciphertextCrc32c: { value: crc32c(wrappedKey) },
      additionalAuthenticatedData: aad,
      additionalAuthenticatedDataCrc32c: { value: crc32c(aad) },
    });
    if (!result.plaintext) throw new Error('KMS unwrapping response invalid');
    const key =
      typeof result.plaintext === 'string'
        ? Buffer.from(result.plaintext, 'base64')
        : Buffer.from(result.plaintext);
    if (typeof result.plaintext !== 'string') result.plaintext.fill(0);
    if (
      key.length !== 32 ||
      result.plaintextCrc32c?.value == null ||
      Number(result.plaintextCrc32c.value) !== crc32c(key)
    ) {
      key.fill(0);
      throw new Error('KMS unwrapping response invalid');
    }
    return key;
  }
}
