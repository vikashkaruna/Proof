/** Internal scoped ciphertext transport; this must never be mounted as a public DTO. */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@axiom/ledger';
import { z } from 'zod';
import {
  originalHumanPayloadApprovalSchema,
  type TemporaryPayloadStore,
} from './saakshi-temporary-payload.js';
import { stageBindingSchema, StageUnconfirmed, type StageBinding } from './saakshi-staging-port.js';

export interface ScopedPayloadRpc {
  call(
    name: 'read_saakshi119_payload' | 'current_saakshi119_payload' | 'consume_saakshi119_upload',
    args: Record<string, string>,
    signal: AbortSignal,
  ): Promise<{ data: unknown; error: unknown }>;
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const hex = (length: number) =>
  z
    .string()
    .length(length)
    .regex(/^[a-f0-9]+$/);
const recordSchema = z
  .object({
    id: z.uuid(),
    binding: stageBindingSchema,
    originalApproval: originalHumanPayloadApprovalSchema,
    algorithm: z.literal('AES-256-GCM'),
    keyId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    nonce: hex(24),
    tag: hex(32),
    ciphertextHash: digest,
    ciphertextSize: z
      .number()
      .int()
      .min(1)
      .max(8 * 1024 * 1024),
    createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    purged: z.literal(false),
    ciphertextHex: z
      .string()
      .min(2)
      .max(16 * 1024 * 1024)
      .regex(/^(?:[a-f0-9]{2})+$/),
  })
  .strict();
function args(b: StageBinding) {
  return {
    t: b.source.tenant_id,
    a: b.source.actor_id,
    runid: b.runId,
    k: b.source.operation_key,
    ih: createHash('sha256').update(canonicalJson(b.source)).digest('hex'),
  };
}
async function response(
  rpc: ScopedPayloadRpc,
  name: Parameters<ScopedPayloadRpc['call']>[0],
  body: Record<string, string>,
  signal: AbortSignal,
) {
  if (signal.aborted) throw new StageUnconfirmed();
  const pending = rpc.call(name, body, signal);
  const result = await new Promise<Awaited<typeof pending>>((resolve, reject) => {
    const abort = () => reject(new StageUnconfirmed());
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
  if (signal.aborted || result.error) throw new StageUnconfirmed();
  return result.data;
}
export function createScopedTemporaryPayloadStore(rpc: ScopedPayloadRpc): TemporaryPayloadStore {
  return {
    async lease(input, signal) {
      try {
        const binding = stageBindingSchema.parse(input);
        const row = recordSchema.parse(
          await response(rpc, 'read_saakshi119_payload', args(binding), signal),
        );
        if (canonicalJson(row.binding) !== canonicalJson(binding)) throw new StageUnconfirmed();
        const ciphertext = Buffer.from(row.ciphertextHex, 'hex');
        if (
          ciphertext.length !== row.ciphertextSize ||
          createHash('sha256').update(ciphertext).digest('hex') !== row.ciphertextHash
        )
          throw new StageUnconfirmed();
        return {
          id: row.id,
          binding: row.binding,
          originalApproval: row.originalApproval,
          algorithm: row.algorithm,
          keyId: row.keyId,
          nonce: Buffer.from(row.nonce, 'hex'),
          tag: Buffer.from(row.tag, 'hex'),
          cipherHash: row.ciphertextHash,
          cipherSize: row.ciphertextSize,
          createdAt: Date.parse(row.createdAt),
          expiresAt: Date.parse(row.expiresAt),
          purged: row.purged,
          async *open(currentSignal) {
            if (currentSignal.aborted) throw new StageUnconfirmed();
            for (let offset = 0; offset < ciphertext.length; offset += 64 * 1024) {
              if (currentSignal.aborted) throw new StageUnconfirmed();
              yield ciphertext.subarray(offset, offset + 64 * 1024);
            }
          },
        };
      } catch {
        throw new StageUnconfirmed();
      }
    },
    async current(id, input, cipherHash, signal) {
      try {
        const binding = stageBindingSchema.parse(input);
        z.uuid().parse(id);
        digest.parse(cipherHash);
        return (
          (await response(
            rpc,
            'current_saakshi119_payload',
            { ...args(binding), payloadid: id, ch: cipherHash },
            signal,
          )) === true
        );
      } catch {
        throw new StageUnconfirmed();
      }
    },
  };
}

/** The claimed expiry is the locked temporary payload deadline, not a caller extension. */
export function createScopedStageClaim(rpc: ScopedPayloadRpc) {
  return {
    async consume(input: StageBinding, signal: AbortSignal) {
      try {
        const binding = stageBindingSchema.parse(input);
        const request = args(binding);
        const row = z
          .object({
            mode: z.enum(['upload_once', 'recover_only']),
            run_id: z.uuid(),
            input_hash: digest,
            expires_at_ms: z.number().int().safe().positive(),
          })
          .strict()
          .parse(await response(rpc, 'consume_saakshi119_upload', request, signal));
        if (
          row.run_id !== binding.runId ||
          row.input_hash !== request.ih ||
          row.expires_at_ms <= Date.now()
        )
          throw new StageUnconfirmed();
        return { mode: row.mode, expiresAt: row.expires_at_ms };
      } catch {
        throw new StageUnconfirmed();
      }
    },
  };
}
