import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  EndpointRefSchema,
  TargetBindingSchema,
  type TenantId,
  type ConnectorId,
} from '@axiom/types';

export type CredentialId = string & { readonly __brand: 'CredentialId' };
export type BrokerGrantType = 'client_credentials' | 'jwt_bearer';
export interface VaultIdentity {
  tenantId: TenantId;
  connectorId: ConnectorId;
  credentialId: CredentialId;
  grantType: BrokerGrantType;
  descriptorSha256: string;
  endpointRef: string;
  targetBinding: 'production' | 'sandbox' | 'reference-mock';
}
const identitySchema = z
  .object({
    tenantId: z.uuid(),
    connectorId: z.uuid(),
    credentialId: z.uuid(),
    grantType: z.enum(['client_credentials', 'jwt_bearer']),
    descriptorSha256: z.string().regex(/^[a-f0-9]{64}$/),
    endpointRef: EndpointRefSchema,
    targetBinding: TargetBindingSchema,
  })
  .strict();

/** Provider adapters own key selection and authentication. Never accept a key
 * resource from a browser or fall back to a shared application/signing key. */
export interface KeyWrapper {
  wrap(
    identity: Readonly<VaultIdentity>,
    dataKey: Uint8Array,
  ): Promise<{ keyRef: string; wrappedKey: Uint8Array }>;
  /** Returned bytes are caller-owned and cleared immediately after copying. */
  unwrap(
    identity: Readonly<VaultIdentity>,
    keyRef: string,
    wrappedKey: Uint8Array,
  ): Promise<Uint8Array>;
}
export interface CredentialEnvelope {
  formatVersion: 1;
  algorithm: 'aes-256-gcm';
  keyRef: string;
  nonce: Buffer;
  /** Ciphertext followed by its 16-byte GCM authentication tag. */
  ciphertext: Buffer;
  wrappedDataKey: Buffer;
}
export class CredentialEnvelopeError extends Error {
  constructor() {
    super('Credential envelope could not be authenticated.');
    this.name = 'CredentialEnvelopeError';
  }
}
const MAX_SECRET_BYTES = 32768;
const MAX_WRAPPED_KEY_BYTES = 16384;
const keyRefSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[a-zA-Z0-9:/_.-]+$/);

function canonicalIdentity(identity: VaultIdentity): VaultIdentity {
  const parsed = identitySchema.parse(identity);
  return {
    tenantId: parsed.tenantId.toLowerCase() as TenantId,
    connectorId: parsed.connectorId.toLowerCase() as ConnectorId,
    credentialId: parsed.credentialId.toLowerCase() as CredentialId,
    grantType: parsed.grantType,
    descriptorSha256: parsed.descriptorSha256,
    endpointRef: parsed.endpointRef,
    targetBinding: parsed.targetBinding,
  };
}
/** Public authenticated context for the wrapping provider, domain-separated
 * from every other key use (including MFA and approval signatures). */
export function wrappingContext(identity: VaultIdentity): Buffer {
  const value = canonicalIdentity(identity);
  return Buffer.from(
    JSON.stringify([
      'axiom.connector.credential.dek',
      1,
      value.tenantId,
      value.connectorId,
      value.credentialId,
      value.grantType,
      value.descriptorSha256,
      value.endpointRef,
      value.targetBinding,
    ]),
    'utf8',
  );
}
function dataContext(identity: VaultIdentity, keyRef: string): Buffer {
  return Buffer.from(
    JSON.stringify([
      'axiom.connector.credential.data',
      1,
      wrappingContext(identity).toString('base64'),
      keyRef,
    ]),
    'utf8',
  );
}
function validateEnvelope(envelope: CredentialEnvelope): void {
  if (
    envelope.formatVersion !== 1 ||
    envelope.algorithm !== 'aes-256-gcm' ||
    !keyRefSchema.safeParse(envelope.keyRef).success ||
    !Buffer.isBuffer(envelope.nonce) ||
    envelope.nonce.length !== 12 ||
    !Buffer.isBuffer(envelope.ciphertext) ||
    envelope.ciphertext.length < 17 ||
    envelope.ciphertext.length > MAX_SECRET_BYTES + 16 ||
    !Buffer.isBuffer(envelope.wrappedDataKey) ||
    envelope.wrappedDataKey.length === 0 ||
    envelope.wrappedDataKey.length > MAX_WRAPPED_KEY_BYTES
  )
    throw new CredentialEnvelopeError();
}

/** No persistence or authorization here. The broker's storage boundary must
 * authenticate/authorize the caller before invoking this cryptographic primitive. */
export async function sealCredential(
  identity: VaultIdentity,
  plaintext: Uint8Array,
  wrapper: KeyWrapper,
): Promise<CredentialEnvelope> {
  let dataKey: Buffer | undefined;
  try {
    const scope = canonicalIdentity(identity);
    if (!plaintext.byteLength || plaintext.byteLength > MAX_SECRET_BYTES)
      throw new CredentialEnvelopeError();
    dataKey = randomBytes(32);
    const wrapped = await wrapper.wrap(scope, dataKey);
    const keyRef = keyRefSchema.parse(wrapped.keyRef);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
    cipher.setAAD(dataContext(scope, keyRef));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const envelope: CredentialEnvelope = {
      formatVersion: 1,
      algorithm: 'aes-256-gcm',
      keyRef,
      nonce,
      ciphertext,
      wrappedDataKey: Buffer.from(wrapped.wrappedKey),
    };
    validateEnvelope(envelope);
    return envelope;
  } catch {
    throw new CredentialEnvelopeError();
  } finally {
    dataKey?.fill(0);
  }
}

/** Caller owns the returned buffer and must clear it after use. Never turn it
 * into an audit payload or return it from a browser-facing API. */
export async function openCredential(
  identity: VaultIdentity,
  envelope: CredentialEnvelope,
  wrapper: KeyWrapper,
): Promise<Buffer> {
  let dataKey: Buffer | undefined;
  let unauthenticated: Buffer | undefined;
  let final: Buffer | undefined;
  try {
    const scope = canonicalIdentity(identity);
    validateEnvelope(envelope);
    const unwrapped = await wrapper.unwrap(scope, envelope.keyRef, envelope.wrappedDataKey);
    dataKey = Buffer.from(unwrapped);
    unwrapped.fill(0);
    if (dataKey.length !== 32) throw new CredentialEnvelopeError();
    const decipher = createDecipheriv('aes-256-gcm', dataKey, envelope.nonce);
    decipher.setAAD(dataContext(scope, envelope.keyRef));
    decipher.setAuthTag(envelope.ciphertext.subarray(-16));
    unauthenticated = decipher.update(envelope.ciphertext.subarray(0, -16));
    final = decipher.final();
    return Buffer.concat([unauthenticated, final]);
  } catch {
    throw new CredentialEnvelopeError();
  } finally {
    dataKey?.fill(0);
    unauthenticated?.fill(0);
    final?.fill(0);
  }
}

/** Re-encrypt under a new provider/key. The caller must atomically compare the
 * stored version, persist this envelope and append its rotation audit event. */
export async function rotateEnvelope(
  identity: VaultIdentity,
  envelope: CredentialEnvelope,
  previous: KeyWrapper,
  next: KeyWrapper,
): Promise<CredentialEnvelope> {
  const plaintext = await openCredential(identity, envelope, previous);
  try {
    return await sealCredential(identity, plaintext, next);
  } finally {
    plaintext.fill(0);
  }
}
