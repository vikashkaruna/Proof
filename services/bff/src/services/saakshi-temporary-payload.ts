/** Unwired bounded BFF-only encrypted payload contract; never a public recovery DTO. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { canonicalJson } from '@axiom/ledger';
import { z } from 'zod';
import { humanRetentionApprovalSchema } from './saakshi-human-retention-approval.js';
import {
  stageBindingSchema,
  StageUnconfirmed,
  type StageBinding,
  type RetainedResourceReader,
} from './saakshi-staging-port.js';

const MAX_LIFETIME = 15 * 60_000;
export interface TemporaryPayloadKey {
  id: string;
  key: Buffer;
  /** Peer/runtime/source keys must never double as temporary payload keys. */
  otherKeys: readonly Buffer[];
}
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const originalHumanPayloadApprovalSchema = z
  .object({
    sourceKind: z.literal('human_uploaded_bytes'),
    tenantId: uuid,
    actorId: uuid,
    engagementId: uuid.nullable(),
    operationKey: uuid,
    bodyHash: digest,
    contentHash: digest,
    byteSize: z
      .number()
      .int()
      .min(1)
      .max(8 * 1024 * 1024),
    contentType: z
      .string()
      .max(120)
      .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
    retention: humanRetentionApprovalSchema,
  })
  .strict();
export type OriginalHumanPayloadApproval = z.infer<typeof originalHumanPayloadApprovalSchema>;
export interface TemporaryPayloadMetadata {
  originalApproval: OriginalHumanPayloadApproval;
  algorithm: 'AES-256-GCM';
  keyId: string;
  nonce: Buffer;
  tag: Buffer;
  cipherHash: string;
  cipherSize: number;
  createdAt: number;
  expiresAt: number;
}
export interface TemporaryPayloadRecord extends TemporaryPayloadMetadata {
  /** Obtained from current immutable SQL source projection, never encryption caller hints. */
  id: string;
  binding: StageBinding;
  purged: boolean;
  open(signal: AbortSignal): AsyncIterable<Uint8Array>;
}
export interface TemporaryPayloadStore {
  /** Server resolves exact immutable provenance + current bounded payload lease, never caller URL. */
  lease(binding: StageBinding, signal: AbortSignal): Promise<TemporaryPayloadRecord>;
  /** Rechecks current purge/version/expiry under the owned payload authority. */
  current(
    id: string,
    binding: StageBinding,
    cipherHash: string,
    signal: AbortSignal,
  ): Promise<boolean>;
}
function validKey(key: TemporaryPayloadKey) {
  if (
    !/^[a-zA-Z0-9_-]{1,80}$/.test(key.id) ||
    key.key.length !== 32 ||
    key.otherKeys.some((other) => key.key.equals(other))
  )
    throw new StageUnconfirmed();
}
function aad(approval: OriginalHumanPayloadApproval) {
  return Buffer.from(
    'axiom-saakshi-temporary-payload-v1\0' +
      canonicalJson(originalHumanPayloadApprovalSchema.parse(approval)),
  );
}
function matchesOriginal(binding: StageBinding, approval: OriginalHumanPayloadApproval) {
  const s = binding.source;
  return (
    s.tenant_id === approval.tenantId &&
    s.actor_id === approval.actorId &&
    s.engagement_id === approval.engagementId &&
    s.operation_key === approval.operationKey &&
    s.human_request_hash === approval.bodyHash &&
    s.content_hash === approval.contentHash &&
    s.byte_size === approval.byteSize &&
    s.provider === approval.retention.provider &&
    s.bucket === approval.retention.bucket &&
    s.encryption === approval.retention.encryption &&
    s.legal_hold === approval.retention.legalHold
  );
}

function active(record: TemporaryPayloadMetadata, now: number) {
  if (
    !Number.isSafeInteger(record.createdAt) ||
    !Number.isSafeInteger(record.expiresAt) ||
    record.createdAt > now ||
    record.expiresAt <= now ||
    record.expiresAt <= record.createdAt ||
    record.expiresAt - record.createdAt > MAX_LIFETIME ||
    record.algorithm !== 'AES-256-GCM' ||
    record.nonce.length !== 12 ||
    record.tag.length !== 16 ||
    !/^[a-f0-9]{64}$/.test(record.cipherHash) ||
    record.cipherSize !== record.originalApproval.byteSize
  )
    throw new StageUnconfirmed();
}
async function interrupted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    throw new StageUnconfirmed();
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(new StageUnconfirmed());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
/** Called on validated transient human bytes; immutable SQL provenance must not store these bytes/body. */
export function encryptTemporaryHumanPayload(
  input: OriginalHumanPayloadApproval,
  bytes: Buffer,
  key: TemporaryPayloadKey,
  options: { now?: number; lifetimeMs?: number } = {},
): { metadata: TemporaryPayloadMetadata; ciphertext: Buffer } {
  const approval = originalHumanPayloadApprovalSchema.parse(input);
  validKey(key);
  const now = options.now ?? Date.now();
  const lifetime = options.lifetimeMs ?? MAX_LIFETIME;
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(lifetime) ||
    lifetime < 1 ||
    lifetime > MAX_LIFETIME ||
    bytes.length !== approval.byteSize ||
    createHash('sha256').update(bytes).digest('hex') !== approval.contentHash
  )
    throw new StageUnconfirmed();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.key, nonce);
  cipher.setAAD(aad(approval));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    ciphertext,
    metadata: {
      originalApproval: approval,
      algorithm: 'AES-256-GCM',
      keyId: key.id,
      nonce,
      tag: cipher.getAuthTag(),
      cipherHash: createHash('sha256').update(ciphertext).digest('hex'),
      cipherSize: ciphertext.length,
      createdAt: now,
      expiresAt: now + lifetime,
    },
  };
}

export function createEncryptedRetainedResourceReader(
  store: TemporaryPayloadStore,
  key: TemporaryPayloadKey,
  clock: () => number = Date.now,
): RetainedResourceReader {
  validKey(key);
  return {
    async read(input, signal) {
      try {
        const binding = stageBindingSchema.parse(input);
        const record = await interrupted(store.lease(binding, signal), signal);
        const approval = originalHumanPayloadApprovalSchema.parse(record.originalApproval);
        active(record, clock());
        if (
          record.purged ||
          record.keyId !== key.id ||
          !matchesOriginal(binding, approval) ||
          canonicalJson(record.binding) !== canonicalJson(binding)
        )
          throw new StageUnconfirmed();
        const decipher = createDecipheriv('aes-256-gcm', key.key, record.nonce);
        decipher.setAAD(aad(approval));
        decipher.setAuthTag(record.tag);
        const hash = createHash('sha256');
        const plaintext: Buffer[] = [];
        let size = 0;
        const iterator = record.open(signal)[Symbol.asyncIterator]();
        try {
          while (true) {
            active(record, clock());
            const next = await interrupted(iterator.next(), signal);
            if (next.done) break;
            if (!(next.value instanceof Uint8Array)) throw new StageUnconfirmed();
            size += next.value.byteLength;
            if (size > record.cipherSize) throw new StageUnconfirmed();
            hash.update(next.value);
            plaintext.push(decipher.update(next.value));
          }
        } finally {
          void iterator.return?.().catch(() => undefined);
        }
        if (size !== record.cipherSize || hash.digest('hex') !== record.cipherHash)
          throw new StageUnconfirmed();
        // No plaintext reaches the stage port before GCM authentication succeeds.
        plaintext.push(decipher.final());
        const bytes = Buffer.concat(plaintext, size);
        if (
          bytes.length !== binding.source.byte_size ||
          createHash('sha256').update(bytes).digest('hex') !== binding.source.content_hash
        )
          throw new StageUnconfirmed();
        active(record, clock());
        if (
          !(await interrupted(store.current(record.id, binding, record.cipherHash, signal), signal))
        )
          throw new StageUnconfirmed();
        return {
          binding,
          contentType: approval.contentType,
          byteSize: bytes.length,
          async *open(readSignal) {
            for (let offset = 0; offset < bytes.length; offset += 65536) {
              active(record, clock());
              if (
                !(await interrupted(
                  store.current(record.id, binding, record.cipherHash, readSignal),
                  readSignal,
                ))
              )
                throw new StageUnconfirmed();
              yield bytes.subarray(offset, offset + 65536);
            }
          },
        };
      } catch {
        throw new StageUnconfirmed();
      }
    },
  };
}
