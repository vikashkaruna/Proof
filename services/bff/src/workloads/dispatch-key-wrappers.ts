import { crc32c } from '@aws-crypto/crc32c';
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { KeyManagementServiceClient, type protos } from '@google-cloud/kms';
import { DispatchRefused, type DispatchKeyWrapper } from './dispatch-payload.js';
import { DispatchKeyPolicy, dispatchKmsBinding } from './dispatch-key-policy.js';

const deadlineMs = 5000;
const maxWrappedBytes = 16384;
export interface DispatchAwsKmsPort {
  send(
    command: EncryptCommand | DecryptCommand,
    options: { abortSignal: AbortSignal },
  ): Promise<{
    KeyId?: string;
    EncryptionAlgorithm?: string;
    CiphertextBlob?: Uint8Array;
    Plaintext?: Uint8Array;
  }>;
}
export interface DispatchGcpKmsPort {
  encrypt(
    request: protos.google.cloud.kms.v1.IEncryptRequest,
    options: { timeout: number; retry: null },
  ): Promise<[protos.google.cloud.kms.v1.IEncryptResponse, ...unknown[]]>;
  decrypt(
    request: protos.google.cloud.kms.v1.IDecryptRequest,
    options: { timeout: number; retry: null },
  ): Promise<[protos.google.cloud.kms.v1.IDecryptResponse, ...unknown[]]>;
}

/** One outstanding provider call per controller adapter, even if it ignores its
 * deadline. Discard/clear a late result; never accumulate unbounded SDK work. */
class KmsBudget {
  #busy = false;
  async run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    discard: (result: T) => void,
  ): Promise<T> {
    if (this.#busy) throw new DispatchRefused();
    this.#busy = true;
    const controller = new AbortController();
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        controller.abort();
        reject(new DispatchRefused());
      }, deadlineMs);
    });
    const work = Promise.resolve()
      .then(() => operation(controller.signal))
      .then((result) => {
        if (expired) {
          discard(result);
          throw new DispatchRefused();
        }
        return result;
      })
      .finally(() => {
        this.#busy = false;
      });
    try {
      return await Promise.race([work, timeout]);
    } catch {
      throw new DispatchRefused();
    } finally {
      clearTimeout(timer);
    }
  }
}
function requireBytes(value: Uint8Array, min: number, max: number): void {
  if (!(value instanceof Uint8Array) || value.byteLength < min || value.byteLength > max)
    throw new DispatchRefused();
}
function responseBytes(
  value: Uint8Array | string | null | undefined,
  min: number,
  max: number,
): Buffer {
  if (value == null || (typeof value === 'string' && value.length > Math.ceil(max / 3) * 4))
    throw new DispatchRefused();
  if (typeof value !== 'string') requireBytes(value, min, max);
  const bytes = typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.from(value);
  if (
    bytes.length < min ||
    bytes.length > max ||
    (typeof value === 'string' && bytes.toString('base64') !== value)
  ) {
    bytes.fill(0);
    throw new DispatchRefused();
  }
  return bytes;
}
function clearPlaintext(value: Uint8Array | string | null | undefined): void {
  if (value instanceof Uint8Array) value.fill(0);
}

/** Uses controller workload credentials; never install in a scheduler/worker. */
export class AwsDispatchKeyWrapper implements DispatchKeyWrapper {
  readonly #budget = new KmsBudget();
  constructor(
    private readonly policy: DispatchKeyPolicy,
    private readonly client: DispatchAwsKmsPort = new KMSClient({
      region: 'ap-south-1',
      endpoint: 'https://kms.ap-south-1.amazonaws.com',
      maxAttempts: 1,
    }),
  ) {
    if (policy.provider !== 'aws') throw new DispatchRefused();
  }
  async wrap(context: Uint8Array, key: Uint8Array) {
    let plaintext: Buffer | undefined;
    try {
      const binding = dispatchKmsBinding(context);
      const keyRef = this.policy.primary(binding.tenant);
      requireBytes(key, 32, 32);
      plaintext = Buffer.from(key);
      const result = await this.#budget.run(
        (abortSignal) =>
          this.client.send(
            new EncryptCommand({
              KeyId: keyRef,
              Plaintext: plaintext,
              EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
              EncryptionContext: {
                axiomDispatchPurpose: 'axiom.assessment.dispatch.dek.v1',
                axiomDispatchContext: binding.digest,
              },
            }),
            { abortSignal },
          ),
        (value) => clearPlaintext(value.Plaintext),
      );
      clearPlaintext(result.Plaintext);
      if (result.KeyId !== keyRef || result.EncryptionAlgorithm !== 'SYMMETRIC_DEFAULT')
        throw new DispatchRefused();
      return { keyRef, wrappedKey: responseBytes(result.CiphertextBlob, 1, maxWrappedBytes) };
    } catch {
      throw new DispatchRefused();
    } finally {
      plaintext?.fill(0);
    }
  }
  async unwrap(context: Uint8Array, keyRef: string, wrappedKey: Uint8Array) {
    let plaintext: Uint8Array | undefined;
    try {
      const binding = dispatchKmsBinding(context);
      this.policy.requireReadable(binding.tenant, keyRef);
      requireBytes(wrappedKey, 1, maxWrappedBytes);
      const result = await this.#budget.run(
        (abortSignal) =>
          this.client.send(
            new DecryptCommand({
              KeyId: keyRef,
              CiphertextBlob: Buffer.from(wrappedKey),
              EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
              EncryptionContext: {
                axiomDispatchPurpose: 'axiom.assessment.dispatch.dek.v1',
                axiomDispatchContext: binding.digest,
              },
            }),
            { abortSignal },
          ),
        (value) => clearPlaintext(value.Plaintext),
      );
      plaintext = result.Plaintext;
      if (result.KeyId !== keyRef || result.EncryptionAlgorithm !== 'SYMMETRIC_DEFAULT')
        throw new DispatchRefused();
      return responseBytes(plaintext, 32, 32);
    } catch {
      throw new DispatchRefused();
    } finally {
      clearPlaintext(plaintext);
    }
  }
}

export class GcpDispatchKeyWrapper implements DispatchKeyWrapper {
  readonly #budget = new KmsBudget();
  constructor(
    private readonly policy: DispatchKeyPolicy,
    private readonly client: DispatchGcpKmsPort = new KeyManagementServiceClient({
      apiEndpoint: 'asia-south1-cloudkms.googleapis.com',
      universeDomain: 'googleapis.com',
    }),
  ) {
    if (policy.provider !== 'gcp') throw new DispatchRefused();
  }
  async wrap(context: Uint8Array, key: Uint8Array) {
    let plaintext: Buffer | undefined;
    try {
      const binding = dispatchKmsBinding(context);
      const keyRef = this.policy.primary(binding.tenant);
      requireBytes(key, 32, 32);
      plaintext = Buffer.from(key);
      const [result] = await this.#budget.run(
        () =>
          this.client.encrypt(
            {
              name: keyRef,
              plaintext,
              plaintextCrc32c: { value: crc32c(plaintext!) },
              additionalAuthenticatedData: binding.aad,
              additionalAuthenticatedDataCrc32c: { value: crc32c(binding.aad) },
            },
            { timeout: deadlineMs, retry: null },
          ),
        () => {},
      );
      const prefix = `${keyRef}/cryptoKeyVersions/`;
      if (
        !result.name?.startsWith(prefix) ||
        !/^[1-9][0-9]*$/.test(result.name.slice(prefix.length)) ||
        result.verifiedPlaintextCrc32c !== true ||
        result.verifiedAdditionalAuthenticatedDataCrc32c !== true
      )
        throw new DispatchRefused();
      const wrappedKey = responseBytes(result.ciphertext, 1, maxWrappedBytes);
      if (
        result.ciphertextCrc32c?.value == null ||
        Number(result.ciphertextCrc32c.value) !== crc32c(wrappedKey)
      )
        throw new DispatchRefused();
      return { keyRef, wrappedKey };
    } catch {
      throw new DispatchRefused();
    } finally {
      plaintext?.fill(0);
    }
  }
  async unwrap(context: Uint8Array, keyRef: string, wrappedKey: Uint8Array) {
    let plaintext: Uint8Array | string | null | undefined, key: Buffer | undefined;
    try {
      const binding = dispatchKmsBinding(context);
      this.policy.requireReadable(binding.tenant, keyRef);
      requireBytes(wrappedKey, 1, maxWrappedBytes);
      const [result] = await this.#budget.run(
        () =>
          this.client.decrypt(
            {
              name: keyRef,
              ciphertext: Buffer.from(wrappedKey),
              ciphertextCrc32c: { value: crc32c(wrappedKey) },
              additionalAuthenticatedData: binding.aad,
              additionalAuthenticatedDataCrc32c: { value: crc32c(binding.aad) },
            },
            { timeout: deadlineMs, retry: null },
          ),
        ([value]) => clearPlaintext(value.plaintext),
      );
      plaintext = result.plaintext;
      key = responseBytes(plaintext, 32, 32);
      if (
        result.plaintextCrc32c?.value == null ||
        Number(result.plaintextCrc32c.value) !== crc32c(key)
      )
        throw new DispatchRefused();
      return key;
    } catch {
      key?.fill(0);
      throw new DispatchRefused();
    } finally {
      clearPlaintext(plaintext);
    }
  }
}
